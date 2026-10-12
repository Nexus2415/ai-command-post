// ARN-89: disabled, fail-closed adapter from the ARN-86 manager's `AdmissionBroker` port onto the ARN-88 Postgres
// broker RPCs (opsdesk-harmony drizzle/migrations/0030_execution_broker.sql, merged at 0dbee42).
//
// What this is: a translation layer. It names the RPCs and their parameters exactly as the SQL declares them, checks
// every response's shape before believing it, and turns anything it cannot read into a refusal, never a success. Cost
// stays at $0 here as well as in the broker: a request that could cost money is refused before the RPC, and a
// reservation the broker makes above zero is released at once and refused.
//
// What this is NOT: wired anywhere. Nothing in the engine, CLI, console, API routes, providers or workflows imports it,
// it reads no environment variable, opens no connection and holds no credentials. The transport (`rpc`) is injected:
// tests pass canned fixtures or a throwaway local PostgreSQL. It is not a second broker either: claims, fences,
// budgets and idempotency stay in the SQL; the only state kept here is a lookup cache (attempt -> operation id,
// claim -> command binding) that every miss turns into a refusal.
import type { AdmissionBroker, AttemptState, BrokerResult, BrokerStep, ClaimStatus } from "./manager.ts";

/** The ARN-88 RPCs granted to `broker_caller`, with their parameters in declaration order and their SQL types. */
export const BROKER_SIGNATURES = Object.freeze({
  broker_claim_and_reserve: [["p_tenant", "uuid"], ["p_command_key", "text"], ["p_action_ref", "uuid"], ["p_tariff_ref", "uuid"], ["p_max_input", "integer"], ["p_max_cached", "integer"], ["p_max_output", "integer"]],
  broker_claim_status: [["p_claim", "uuid"]],
  broker_mark_dispatched: [["p_attempt", "uuid"], ["p_fence", "bigint"]],
  broker_mark_unknown: [["p_attempt", "uuid"], ["p_fence", "bigint"]],
  broker_mark_failed: [["p_attempt", "uuid"], ["p_fence", "bigint"], ["p_reason", "text"]],
  broker_release: [["p_attempt", "uuid"], ["p_fence", "bigint"], ["p_reason", "text"]],
  broker_settle: [["p_attempt", "uuid"], ["p_operation_id", "text"], ["p_actual", "numeric"], ["p_usage_evidence", "text"]],
} as const satisfies Record<string, readonly (readonly [string, string])[]>);
export type BrokerFunction = keyof typeof BROKER_SIGNATURES;
export type RpcArgs = Record<string, string | number>;

/**
 * One RPC call as the `broker_caller` role, in a session whose verified JWT claims carry `executor: "acp"` and the
 * allowed tenant ids (the broker never takes the executor as an argument). Resolves to the RPC's jsonb result.
 * Throwing means the broker could not be reached or the call aborted; the manager then treats the broker as down.
 */
export type BrokerRpc = (fn: BrokerFunction, args: RpcArgs) => Promise<unknown>;

/**
 * The command a manager claim key stands for, as the intake job recorded it with `broker_record_command`. The SQL
 * claim is keyed by (tenant, command_key) and bound to that command row, its approved action and a tariff; none of
 * that is in the manager's request, so it comes from here.
 */
export interface CommandBinding {
  tenantRef: string;
  commandKey: string;
  actionRef: string;
  /** Must be an all-zero tariff while the budget is $0. A priced tariff reserves above zero and is refused. */
  tariffRef: string;
  maxInputTokens: number;
  maxCachedInputTokens: number;
  maxOutputTokens: number;
  /** Idempotency key of the manager admission this command was recorded for. Only that admission may claim it. */
  idempotencyKey: string;
}

export interface BrokerAdapterDeps {
  rpc: BrokerRpc;
  /** The recorded command for a manager claim, or null when there is none (refused). */
  binding(req: { tenantId: string; claimKey: string }): Promise<CommandBinding | null>;
  /** The usage hash the egress gateway captured for an attempt (`broker_capture_usage`), or null when none was. */
  usageEvidence(attemptId: string): Promise<string | null>;
}

/** Refusal reasons the adapter adds on top of the broker's own (which pass through unchanged). */
export const ADAPTER_REFUSALS = Object.freeze({
  cost: "provider_cost_above_zero",
  malformed: "malformed_broker_response",
  unbound: "unbound_command",
  boundElsewhere: "command_bound_to_another_event",
  unknownAttempt: "unknown_attempt",
  unboundClaim: "unbound_claim",
  noUsage: "no_usage_evidence",
  stale: "stale",
  notReclaimable: "not_reclaimable",
});

const ATTEMPT_STATES: readonly AttemptState[] = ["claimed", "dispatched", "unknown", "settled", "released", "failed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isFence = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const refuse = (reason: string) => ({ ok: false as const, reason });
const MALFORMED = refuse(ADAPTER_REFUSALS.malformed);

/** The reply fields the adapter reads. Anything else the broker returns is ignored. */
type Json = Partial<Record<"ok" | "reason" | "created" | "claim_id" | "attempt_id" | "operation_id" | "fence" | "reserved_micros" | "state" | "actual_micros", unknown>>;
/** `{ok:false, reason}` from the broker, a plain object with `ok:true`, or null for anything else. */
function read(r: unknown): { refusal: string } | { body: Json } | null {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const o = r as Json;
  if (o.ok === false) return isText(o.reason) ? { refusal: o.reason } : null;
  return o.ok === true ? { body: o } : null;
}

function validBinding(b: CommandBinding | null): b is CommandBinding {
  return !!b && isUuid(b.tenantRef) && isText(b.commandKey) && isUuid(b.actionRef) && isUuid(b.tariffRef) && isText(b.idempotencyKey)
    && isCount(b.maxInputTokens) && isCount(b.maxCachedInputTokens) && isFence(b.maxOutputTokens) && b.maxCachedInputTokens <= b.maxInputTokens;
}

/** Builds the adapter. There is no default instance and no default transport. */
export function createBrokerAdapter(deps: BrokerAdapterDeps): AdmissionBroker {
  const ops = new Map<string, string>(); // attempt id -> operation id
  const claims = new Map<string, CommandBinding>(); // claim id -> binding

  const call = (fn: BrokerFunction, args: RpcArgs): Promise<unknown> => {
    const want = BROKER_SIGNATURES[fn].map(([name]) => name);
    const got = Object.keys(args);
    if (got.length !== want.length || want.some((n) => !(n in args))) throw new Error(`adapter bug: ${fn} arguments ${got.join(",")}`);
    return deps.rpc(fn, args);
  };

  const step = async (fn: BrokerFunction, args: RpcArgs, check?: (body: Json) => boolean): Promise<BrokerStep> => {
    const r = read(await call(fn, args));
    if (!r) return MALFORMED;
    if ("refusal" in r) return refuse(r.refusal);
    if (check && !check(r.body)) return MALFORMED;
    return { ok: true };
  };

  const status = async (claimId: string): Promise<ClaimStatus> => {
    if (!isUuid(claimId)) return refuse("invalid_input");
    const r = read(await call("broker_claim_status", { p_claim: claimId }));
    if (!r) return MALFORMED;
    if ("refusal" in r) return refuse(r.refusal);
    const b = r.body;
    if (b.claim_id !== claimId || !isUuid(b.attempt_id) || !isFence(b.fence) || !isText(b.operation_id) || !ATTEMPT_STATES.includes(b.state as AttemptState)) return MALFORMED;
    ops.set(b.attempt_id, b.operation_id);
    return { ok: true, attemptId: b.attempt_id, fence: b.fence, state: b.state as AttemptState };
  };

  const release = (attemptId: string, fence: number, reason: string): Promise<BrokerStep> =>
    step("broker_release", { p_attempt: attemptId, p_fence: fence, p_reason: reason });

  /** `broker_claim_and_reserve` for a binding. Also the SQL's takeover path when the latest attempt is released/failed. */
  const reserve = async (b: CommandBinding, expectAttempt: "any" | "new_attempt"): Promise<BrokerResult> => {
    const r = read(await call("broker_claim_and_reserve", {
      p_tenant: b.tenantRef, p_command_key: b.commandKey, p_action_ref: b.actionRef, p_tariff_ref: b.tariffRef,
      p_max_input: b.maxInputTokens, p_max_cached: b.maxCachedInputTokens, p_max_output: b.maxOutputTokens,
    }));
    if (!r) return MALFORMED;
    if ("refusal" in r) return refuse(r.refusal);
    const o = r.body;
    if (typeof o.created !== "boolean" || !isUuid(o.claim_id)) return MALFORMED;
    const claimId = o.claim_id;
    if (o.attempt_id === undefined) {
      // The claim exists and is live: the broker returns its id only and charges nothing. Its attempt comes from the
      // read-only status RPC. A "created" claim without an attempt is not a shape the broker returns.
      if (o.created || expectAttempt === "new_attempt") return o.created ? MALFORMED : refuse(ADAPTER_REFUSALS.notReclaimable);
      claims.set(claimId, b);
      const st = await status(claimId);
      if (!st.ok) return st;
      return { ok: true, claimId, attemptId: st.attemptId, fence: st.fence, operationId: ops.get(st.attemptId)!, created: false, idempotencyKey: b.idempotencyKey };
    }
    if (!isUuid(o.attempt_id) || !isText(o.operation_id) || !isFence(o.fence) || !isCount(o.reserved_micros)) return MALFORMED;
    claims.set(claimId, b);
    ops.set(o.attempt_id, o.operation_id);
    if (o.reserved_micros !== 0) {
      // A priced tariff: the broker reserved real money. Hand it back before anything can dispatch, then refuse.
      await release(o.attempt_id, o.fence, ADAPTER_REFUSALS.cost).catch(() => undefined);
      return refuse(ADAPTER_REFUSALS.cost);
    }
    return { ok: true, claimId, attemptId: o.attempt_id, fence: o.fence, operationId: o.operation_id, created: o.created, idempotencyKey: b.idempotencyKey };
  };

  return {
    claimStatus: status,

    async claimAndReserve(req) {
      if (req.tariffId !== "free" || req.worstCaseMicros !== 0) return refuse(ADAPTER_REFUSALS.cost);
      const b = await deps.binding({ tenantId: req.tenantId, claimKey: req.claimKey });
      if (!validBinding(b)) return refuse(ADAPTER_REFUSALS.unbound);
      // Only the admission the command was recorded for may claim it; another event on the same task is refused here,
      // before the broker is asked, so it can never take the claim first.
      if (b.idempotencyKey !== req.idempotencyKey) return refuse(ADAPTER_REFUSALS.boundElsewhere);
      return reserve(b, "any");
    },

    async takeover(claimId, expectedFence, worstCaseMicros) {
      if (worstCaseMicros !== 0) return refuse(ADAPTER_REFUSALS.cost);
      const b = claims.get(claimId);
      if (!b) return refuse(ADAPTER_REFUSALS.unboundClaim);
      // The SQL takeover takes no expected fence, so check it first (read-only), then require the next fence.
      const st = await status(claimId);
      if (!st.ok) return st;
      if (st.fence !== expectedFence) return refuse(ADAPTER_REFUSALS.stale);
      if (st.state !== "failed" && st.state !== "released") return refuse(ADAPTER_REFUSALS.notReclaimable);
      const t = await reserve(b, "new_attempt");
      if (!t.ok) return t;
      // The claim moved on between the check and the call (another takeover ran and ended): the attempt just minted is
      // ours but not the one this retry expected, so hand it back and refuse rather than run on a surprise fence.
      if (t.claimId !== claimId || t.fence !== expectedFence + 1) {
        await release(t.attemptId, t.fence, "stale_takeover").catch(() => undefined);
        return refuse(ADAPTER_REFUSALS.stale);
      }
      return { ...t, created: false };
    },

    markDispatched: (attemptId, fence) =>
      step("broker_mark_dispatched", { p_attempt: attemptId, p_fence: fence }, (o) => o.attempt_id === attemptId && o.fence === fence),
    markUnknown: (attemptId, fence) => step("broker_mark_unknown", { p_attempt: attemptId, p_fence: fence }),
    markFailed: (attemptId, fence) => step("broker_mark_failed", { p_attempt: attemptId, p_fence: fence, p_reason: "acp_manager_failed" }),
    release: (attemptId, fence) => release(attemptId, fence, "acp_manager_release"),

    async settle(attemptId, actualMicros) {
      // The manager's verification reference stays in its own audit trail; the broker settles against the usage the
      // gateway measured, and with a $0 budget only a zero amount may be settled.
      if (actualMicros !== 0) return refuse(ADAPTER_REFUSALS.cost);
      const op = ops.get(attemptId);
      if (!op) return refuse(ADAPTER_REFUSALS.unknownAttempt);
      const evidence = await deps.usageEvidence(attemptId);
      if (!isText(evidence)) return refuse(ADAPTER_REFUSALS.noUsage);
      return step("broker_settle", { p_attempt: attemptId, p_operation_id: op, p_actual: 0, p_usage_evidence: evidence }, (o) => o.actual_micros === 0);
    },
  };
}
