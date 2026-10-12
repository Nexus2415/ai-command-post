// ARN-89: contract tests for the disabled manager -> ARN-88 broker adapter (src/broker-adapter.ts).
// Fixtures only: every RPC reply below is a shape the ARN-88 SQL returns (opsdesk-harmony 0030_execution_broker.sql),
// or a deliberately broken one. No database, network, provider or environment is touched; the Postgres proof is in
// test/broker-postgres.test.ts.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { ADAPTER_REFUSALS, BROKER_SIGNATURES, createBrokerAdapter, type BrokerFunction, type CommandBinding, type RpcArgs } from "../src/broker-adapter.ts";
import { Manager, type AuditEntry, type ExecutorProfile, type Job, type KillState, type LedgerEntry, type ManagerEvent, type Ports, type Verification, type WorkerResult } from "../src/manager.ts";

const NOW = new Date("2026-10-12T23:30:00Z");
const T = "11111111-1111-4111-8111-111111111111";
const CMD = "22222222-2222-4222-8222-222222222222";
const TF = "33333333-3333-4333-8333-333333333333";
const CLAIM = "44444444-4444-4444-8444-444444444444";
const A1 = "55555555-5555-4555-8555-555555555555";
const A2 = "66666666-6666-4666-8666-666666666666";
const OP1 = `op:${CLAIM}:1`;
const OP2 = `op:${CLAIM}:2`;
const KEY = `${T}:evt-1`;

// Replies, as the SQL builds them.
const R = {
  claimed: (over: object = {}) => ({ ok: true, created: true, claim_id: CLAIM, attempt_id: A1, operation_id: OP1, fence: 1, reserved_micros: 0, budget_period: "2026-10-01", ...over }),
  existing: (state = "claimed") => ({ ok: true, created: false, claim_id: CLAIM, state }),
  takeover: (over: object = {}) => ({ ok: true, created: false, claim_id: CLAIM, attempt_id: A2, operation_id: OP2, fence: 2, reserved_micros: 0, budget_period: "2026-10-01", ...over }),
  status: (state: string, attempt = A1, fence = 1) => ({ ok: true, claim_id: CLAIM, attempt_id: attempt, attempt_no: fence, fence, operation_id: `op:${CLAIM}:${fence}`, state }),
  dispatched: (attempt = A1, fence = 1) => ({ ok: true, attempt_id: attempt, operation_id: `op:${CLAIM}:${fence}`, fence, provider: "synthetic", model: "free", rate_version: "v1", max_input_tokens: 100, max_cached_input_tokens: 50, max_output_tokens: 40 }),
  changed: { ok: true, changed: true },
  failed: { ok: true, changed: true, charged_micros: 0 },
  failedReplay: { ok: true, changed: false },
  settled: { ok: true, changed: true, actual_micros: 0, frozen: false },
  no: (reason: string, extra: object = {}) => ({ ok: false, reason, ...extra }),
};

type Reply = unknown | { throws: string };
interface Call { fn: BrokerFunction; args: RpcArgs }

const binding = (over: Partial<CommandBinding> = {}): CommandBinding => ({
  tenantRef: T, commandKey: "task-1:review_result", actionRef: CMD, tariffRef: TF, maxInputTokens: 100, maxCachedInputTokens: 50, maxOutputTokens: 40, idempotencyKey: KEY, ...over,
});

interface Rig {
  m: Manager;
  ports: Ports;
  calls: Call[];
  replies: Partial<Record<BrokerFunction, Reply[]>>;
  audit: AuditEntry[];
  worker: { runs: number; mode: "ok" | "throw"; micros: number };
  verifier: { ok: boolean };
  kill: { state: KillState };
  flags: { auditFailSteps: Set<string>; binding: CommandBinding | null; usage: string | null };
  ledger: Map<string, LedgerEntry>;
}

/** A manager over the real adapter, with a scripted RPC transport: each function answers from its own queue. */
function rig(replies: Partial<Record<BrokerFunction, Reply[]>> = {}, ledger = new Map<string, LedgerEntry>()): Rig {
  const calls: Call[] = [];
  const audit: AuditEntry[] = [];
  const worker: Rig["worker"] = { runs: 0, mode: "ok", micros: 0 };
  const verifier = { ok: true };
  const kill = { state: "off" as KillState };
  const flags: Rig["flags"] = { auditFailSteps: new Set(), binding: binding(), usage: "a".repeat(64) };
  const seen = new Map<string, number>();
  const broker = createBrokerAdapter({
    async rpc(fn, args) {
      calls.push({ fn, args });
      const q = replies[fn];
      if (!q || q.length === 0) throw new Error(`unscripted rpc ${fn}`);
      const r = q.shift();
      if (r && typeof r === "object" && "throws" in r) throw new Error(String((r as { throws: string }).throws));
      return structuredClone(r);
    },
    binding: async () => flags.binding,
    usageEvidence: async () => flags.usage,
  });
  const ports: Ports = {
    killSwitch: () => kill.state,
    broker,
    ledger: {
      async record(e) {
        const entry = ledger.get(`${e.tenantId}:${e.eventId}`);
        if (entry) return { verdict: "duplicate", entry: structuredClone(entry) };
        const k = `${e.tenantId}:${e.taskId}`;
        if (e.seq <= (seen.get(k) ?? -1)) return { verdict: "out_of_order" };
        seen.set(k, e.seq);
        ledger.set(`${e.tenantId}:${e.eventId}`, { status: "pending", job: null });
        return { verdict: "new" };
      },
      async resolve(e) {
        ledger.set(`${e.tenantId}:${e.eventId}`, { status: e.status, job: structuredClone(e.job) });
      },
      async recordOutcome(e) {
        const entry = ledger.get(`${e.tenantId}:${e.eventId}`);
        if (entry?.status !== "admitted") throw new Error("not admitted");
        entry.outcome = { ...e.outcome };
      },
    },
    audit: {
      async append(entry) {
        if (flags.auditFailSteps.has(entry.step)) throw new Error(`audit refused ${entry.step}`);
        audit.push(entry);
      },
    },
    worker: {
      async run(_job: Job): Promise<WorkerResult> {
        worker.runs++;
        if (worker.mode === "throw") throw new Error("worker crashed after it may have acted");
        return { summary: "SYNTHETIC result", actualMicros: worker.micros };
      },
    },
    verifier: { verify: async (): Promise<Verification> => ({ ok: verifier.ok, checkedBy: "chatgpt", ref: "check-1" }) },
    executors: [{ key: "claude", configured: true, suspended: false, costTier: "free", worstCaseMicros: 0 } satisfies ExecutorProfile],
    authority: { paidExecutionApproved: false, grants: [{ intent: "review_result", maxTier: "green", expiresAt: "2026-10-13T23:00:00Z", maxBudgetMicros: 0 }] },
    now: () => NOW,
  };
  return { m: new Manager(ports), ports, calls, replies, audit, worker, verifier, kill, flags, ledger };
}

const event = (over: Partial<ManagerEvent> = {}): ManagerEvent => ({
  eventId: "evt-1", kind: "task_completed", source: "internal", tenantId: T, taskId: "task-1", seq: 1, occurredAt: "2026-10-12T23:25:00Z", ...over,
});
const fns = (r: Rig) => r.calls.map((c) => c.fn);

/** Turns the global network call into a throw and asserts nothing used it. */
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (() => { attempts++; throw new Error("network call in a synthetic test"); }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    assert.equal(attempts, 0, "no network call may be attempted");
  }
}

test("ARN-89 misbound tenant or command refuses before the broker RPC", () => offline(async () => {
  for (const bad of [
    { tenantRef: "99999999-9999-4999-8999-999999999999" },
    { commandKey: "unrelated-task:review_result" },
  ]) {
    const r = rig({ broker_claim_and_reserve: [R.claimed()] });
    r.flags.binding = binding(bad);
    const decision = await r.m.handleEvent(event());
    assert.equal(decision.status, "BLOCKED");
    assert.equal(decision.reason, "broker_refused:unbound_command");
    assert.deepEqual(r.calls, [], "misbound command never reaches the broker");
    assert.equal(r.worker.runs, 0);
  }
}));

test("ARN-89 empty positive lifecycle acknowledgment is not accepted", () => offline(async () => {
  const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.dispatched()], broker_mark_unknown: [{ ok: true }] });
  const d = await r.m.handleEvent(event());
  assert.equal(d.status, "ADMITTED");
  r.worker.mode = "throw";
  const x = await r.m.dispatch(d.job!.jobId);
  assert.notEqual(x.job?.state, "complete", "no success can be inferred from malformed broker acknowledgments");
  assert.equal(r.worker.runs, 1);
}));

test("ARN-89 happy path: zero-cost internal event -> one claim -> audit -> simulated worker -> settle -> durable recovery", () => offline(async () => {
  const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.dispatched()], broker_settle: [R.settled] });
  const d = await r.m.handleEvent(event());
  assert.equal(d.status, "ADMITTED", d.reason);
  assert.deepEqual(r.calls[0], { fn: "broker_claim_and_reserve", args: { p_tenant: T, p_command_key: "task-1:review_result", p_action_ref: CMD, p_tariff_ref: TF, p_max_input: 100, p_max_cached: 50, p_max_output: 40 } });
  assert.deepEqual(r.audit.map((a) => a.step), ["admission_decided", "admitted"], "audited before and after the claim");
  const done = await r.m.dispatch(d.job!.jobId);
  assert.equal(done.status, "ADMITTED", done.reason);
  assert.equal(done.job!.state, "complete");
  assert.equal(r.worker.runs, 1);
  assert.deepEqual(fns(r), ["broker_claim_and_reserve", "broker_mark_dispatched", "broker_settle"]);
  assert.deepEqual(r.calls[2]?.args, { p_attempt: A1, p_operation_id: OP1, p_actual: 0, p_usage_evidence: "a".repeat(64) }, "settles $0 against the gateway's usage hash and the grant's operation id");
  assert.deepEqual((r.ledger.get(`${T}:evt-1`) as { outcome?: unknown } | undefined)?.outcome, { state: "complete", fence: 1 });

  // A restarted manager (same durable ledger, fresh adapter) recovers it from a read-only status call only.
  const again = rig({ broker_claim_status: [R.status("settled")] }, r.ledger);
  const rec = await again.m.handleEvent(event());
  assert.equal(rec.status, "DUPLICATE", rec.reason);
  assert.equal(rec.job!.state, "complete");
  assert.deepEqual(fns(again), ["broker_claim_status"], "recovery writes nothing at the broker");
  assert.equal(again.worker.runs, 0);
}));

test("ARN-89 duplicate arrival of the same event dispatches nothing new", () => offline(async () => {
  const r = rig({ broker_claim_and_reserve: [R.claimed()] });
  assert.equal((await r.m.handleEvent(event())).status, "ADMITTED");
  const dup = await r.m.handleEvent(event());
  assert.equal(dup.status, "DUPLICATE");
  assert.deepEqual(fns(r), ["broker_claim_and_reserve"], "one claim, ever");
  assert.equal(r.worker.runs, 0);
}));

test("ARN-89 stale fence: a dispatch the broker calls stale never runs the worker", () => offline(async () => {
  const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.no("stale")] });
  const d = await r.m.handleEvent(event());
  const x = await r.m.dispatch(d.job!.jobId);
  assert.equal(x.status, "BLOCKED");
  assert.equal(x.reason, "broker_refused:stale");
  assert.equal(r.worker.runs, 0);
}));

test("ARN-89 concurrent claims: a live claim resolves to its existing attempt; another event never reaches the broker", () => offline(async () => {
  // Same event racing itself (e.g. two manager instances): the loser gets the winner's attempt from the status RPC.
  const a = createBrokerAdapter({
    rpc: async (fn) => (fn === "broker_claim_and_reserve" ? R.existing() : R.status("claimed")),
    binding: async () => binding(),
    usageEvidence: async () => null,
  });
  const got = await a.claimAndReserve({ tenantId: T, claimKey: "c", idempotencyKey: KEY, executor: "claude", tariffId: "free", worstCaseMicros: 0 });
  assert.deepEqual(got, { ok: true, claimId: CLAIM, attemptId: A1, fence: 1, operationId: OP1, created: false, idempotencyKey: KEY });

  // A different event on the same task and intent: refused before the broker is asked, so it cannot win the race.
  const r = rig();
  const d = await r.m.handleEvent(event({ eventId: "evt-2" }));
  assert.equal(d.status, "BLOCKED");
  assert.equal(d.reason, `broker_refused:${ADAPTER_REFUSALS.boundElsewhere}`);
  assert.deepEqual(r.calls, []);
}));

test("ARN-89 provider cost above $0 fails closed at every step that could spend", () => offline(async () => {
  const a = createBrokerAdapter({ rpc: async () => assert.fail("no rpc for a priced request"), binding: async () => binding(), usageEvidence: async () => "h" });
  const base = { tenantId: T, claimKey: "c", idempotencyKey: KEY, executor: "claude" as const };
  assert.deepEqual(await a.claimAndReserve({ ...base, tariffId: "paid", worstCaseMicros: 0 }), { ok: false, reason: ADAPTER_REFUSALS.cost });
  assert.deepEqual(await a.claimAndReserve({ ...base, tariffId: "free", worstCaseMicros: 1 }), { ok: false, reason: ADAPTER_REFUSALS.cost });
  assert.deepEqual(await a.takeover(CLAIM, 1, 5), { ok: false, reason: ADAPTER_REFUSALS.cost });
  assert.deepEqual(await a.settle(A1, 7, "ref"), { ok: false, reason: ADAPTER_REFUSALS.cost });

  // The broker priced it anyway (a non-zero tariff behind the binding): the reservation is handed straight back.
  const r = rig({ broker_claim_and_reserve: [R.claimed({ reserved_micros: 1500 })], broker_release: [R.changed] });
  const d = await r.m.handleEvent(event());
  assert.equal(d.reason, `broker_refused:${ADAPTER_REFUSALS.cost}`);
  assert.deepEqual(r.calls[1], { fn: "broker_release", args: { p_attempt: A1, p_fence: 1, p_reason: ADAPTER_REFUSALS.cost } });
  assert.equal(r.worker.runs, 0);

  // A worker that reports a cost: never settled; the outcome is unknown and goes to reconciliation.
  const w = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.dispatched()], broker_mark_unknown: [R.changed] });
  w.worker.micros = 250;
  const j = await w.m.handleEvent(event());
  const x = await w.m.dispatch(j.job!.jobId);
  assert.equal(x.reason, `unknown_outcome:settle_refused:${ADAPTER_REFUSALS.cost}`);
  assert.ok(!fns(w).includes("broker_settle"));
}));

test("ARN-89 kill switch: the manager's switch stops before the broker; the broker's switch stops claim and dispatch", () => offline(async () => {
  const off = rig();
  off.kill.state = "on";
  assert.equal((await off.m.handleEvent(event())).status, "HALTED");
  assert.deepEqual(off.calls, []);

  const claim = rig({ broker_claim_and_reserve: [R.no("kill_switch")] });
  assert.equal((await claim.m.handleEvent(event())).reason, "broker_refused:kill_switch");

  const disp = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.no("kill_switch", { released: true })] });
  const d = await disp.m.handleEvent(event());
  assert.equal((await disp.m.dispatch(d.job!.jobId)).reason, "broker_refused:kill_switch");
  assert.equal(disp.worker.runs, 0);
}));

const MALFORMED_CLAIMS: [string, unknown][] = [
  ["null", null], ["string", "ok"], ["array", [R.claimed()]], ["empty object", {}], ["bare ok", { ok: true }],
  ["refusal without reason", { ok: false }], ["empty reason", { ok: false, reason: "" }],
  ["non-uuid claim", R.claimed({ claim_id: "claim-1" })], ["created as string", R.claimed({ created: "true" })],
  ["fence 0", R.claimed({ fence: 0 })], ["fence as string", R.claimed({ fence: "1" })], ["fractional fence", R.claimed({ fence: 1.5 })],
  ["negative reservation", R.claimed({ reserved_micros: -1 })], ["missing operation", R.claimed({ operation_id: undefined })],
  ["non-uuid attempt", R.claimed({ attempt_id: "a1" })], ["created without attempt", { ok: true, created: true, claim_id: CLAIM }],
];

test("ARN-89 missing or malformed broker replies are refusals, never successes", () => offline(async () => {
  for (const [name, reply] of MALFORMED_CLAIMS) {
    const r = rig({ broker_claim_and_reserve: [reply] });
    const d = await r.m.handleEvent(event());
    assert.equal(d.status, "BLOCKED", name);
    assert.equal(d.reason, `broker_refused:${ADAPTER_REFUSALS.malformed}`, name);
    assert.equal(r.worker.runs, 0, name);
  }
  const down = rig({ broker_claim_and_reserve: [{ throws: "connection refused" }] });
  assert.equal((await down.m.handleEvent(event())).reason, "broker_unavailable");

  // A live claim whose status reply is broken: refused, not resumed.
  for (const bad of [R.status("claimed", A1, 0), { ...R.status("claimed"), claim_id: A2 }, R.status("running"), { ...R.status("claimed"), operation_id: "" }]) {
    const r = rig({ broker_claim_and_reserve: [R.existing()], broker_claim_status: [bad] });
    assert.equal((await r.m.handleEvent(event())).reason, `broker_refused:${ADAPTER_REFUSALS.malformed}`);
  }

  // A dispatch acknowledgment for some other attempt or fence does not authorize this worker.
  for (const bad of [R.dispatched(A2), R.dispatched(A1, 2), { ok: true }, null]) {
    const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [bad] });
    const d = await r.m.handleEvent(event());
    assert.equal((await r.m.dispatch(d.job!.jobId)).reason, `broker_refused:${ADAPTER_REFUSALS.malformed}`);
    assert.equal(r.worker.runs, 0);
  }

  // A settle reply that is not a $0 settlement leaves the outcome unknown.
  for (const bad of [{ ok: true }, { ok: true, changed: true, actual_micros: 5 }, "settled"]) {
    const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.dispatched()], broker_settle: [bad], broker_mark_unknown: [R.changed] });
    const d = await r.m.handleEvent(event());
    const x = await r.m.dispatch(d.job!.jobId);
    assert.equal(x.job!.state, "unknown");
    assert.equal(x.reason, `unknown_outcome:settle_refused:${ADAPTER_REFUSALS.malformed}`);
  }
}));

test("ARN-89 broken audit after the claim releases the reservation through the broker", () => offline(async () => {
  const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_release: [R.changed] });
  r.flags.auditFailSteps.add("admitted");
  const d = await r.m.handleEvent(event());
  assert.equal(d.status, "BLOCKED");
  assert.match(d.reason, /audit_failed_after_claim/);
  assert.deepEqual(r.calls[1], { fn: "broker_release", args: { p_attempt: A1, p_fence: 1, p_reason: "acp_manager_release" } });
}));

test("ARN-89 ambiguous completion: a worker that throws is marked unknown, never settled or failed", () => offline(async () => {
  const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.dispatched()], broker_mark_unknown: [R.changed] });
  r.worker.mode = "throw";
  const d = await r.m.handleEvent(event());
  const x = await r.m.dispatch(d.job!.jobId);
  assert.equal(x.job!.state, "unknown");
  assert.deepEqual(fns(r), ["broker_claim_and_reserve", "broker_mark_dispatched", "broker_mark_unknown"]);
  assert.deepEqual(r.calls[2]?.args, { p_attempt: A1, p_fence: 1 });

  // Missing usage evidence is the same: the broker cannot settle without the gateway's measurement.
  const n = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.dispatched()], broker_mark_unknown: [R.changed] });
  n.flags.usage = null;
  const j = await n.m.handleEvent(event());
  assert.equal((await n.m.dispatch(j.job!.jobId)).reason, `unknown_outcome:settle_refused:${ADAPTER_REFUSALS.noUsage}`);
}));

test("ARN-89 read-only claim-status recovery: work that may have run comes back unknown with no broker write", () => offline(async () => {
  const first = rig({ broker_claim_and_reserve: [R.claimed()] });
  await first.m.handleEvent(event());
  for (const state of ["dispatched", "unknown", "settled", "failed"]) {
    const ledger = new Map([...first.ledger].map(([k, v]) => [k, structuredClone(v)]));
    const r = rig({ broker_claim_status: [R.status(state)] }, ledger);
    const d = await r.m.handleEvent(event());
    assert.equal(d.status, "DUPLICATE", state);
    assert.equal(d.job!.state, "unknown", `${state} without a recorded outcome is unknown`);
    assert.deepEqual(fns(r), ["broker_claim_status"], state);
  }
  const claimed = rig({ broker_claim_status: [R.status("claimed")] }, first.ledger);
  assert.equal((await claimed.m.handleEvent(event())).job!.state, "admitted", "a still-claimed attempt is dispatchable again");
}));

test("ARN-89 idempotent failure finalization: a rejected result fails once, and a replay changes nothing", () => offline(async () => {
  const r = rig({ broker_claim_and_reserve: [R.claimed()], broker_mark_dispatched: [R.dispatched()], broker_mark_failed: [R.failed, R.failedReplay, R.no("stale")] });
  r.verifier.ok = false;
  const d = await r.m.handleEvent(event());
  const x = await r.m.dispatch(d.job!.jobId);
  assert.equal(x.job!.state, "failed");
  assert.deepEqual(r.calls[2], { fn: "broker_mark_failed", args: { p_attempt: A1, p_fence: 1, p_reason: "acp_manager_failed" } });
  assert.deepEqual(await r.ports.broker.markFailed(A1, 1), { ok: true }, "a replay of a recorded failure is ok");
  assert.deepEqual(await r.ports.broker.markFailed(A1, 9), { ok: false, reason: "stale" });
}));

test("ARN-89 takeover: checks the expected fence read-only first, and refuses a surprise fence", () => offline(async () => {
  const b = binding();
  const make = (replies: Partial<Record<BrokerFunction, unknown[]>>, calls: Call[] = []) => createBrokerAdapter({
    rpc: async (fn, args) => { calls.push({ fn, args }); return replies[fn]!.shift(); },
    binding: async () => b, usageEvidence: async () => null,
  });
  const claimReq = { tenantId: T, claimKey: "c", idempotencyKey: KEY, executor: "claude" as const, tariffId: "free", worstCaseMicros: 0 };

  assert.deepEqual(await make({}).takeover(CLAIM, 1, 0), { ok: false, reason: ADAPTER_REFUSALS.unboundClaim }, "a claim it never saw is refused");

  const ok = make({ broker_claim_and_reserve: [R.claimed(), R.takeover()], broker_claim_status: [R.status("failed")] });
  await ok.claimAndReserve(claimReq);
  assert.deepEqual(await ok.takeover(CLAIM, 1, 0), { ok: true, claimId: CLAIM, attemptId: A2, fence: 2, operationId: OP2, created: false, idempotencyKey: KEY });

  const calls: Call[] = [];
  const stale = make({ broker_claim_and_reserve: [R.claimed()], broker_claim_status: [R.status("failed", A2, 2)] }, calls);
  await stale.claimAndReserve(claimReq);
  assert.deepEqual(await stale.takeover(CLAIM, 1, 0), { ok: false, reason: "stale" });
  assert.deepEqual(calls.map((c) => c.fn), ["broker_claim_and_reserve", "broker_claim_status"], "no second claim on a stale fence");

  const live = make({ broker_claim_and_reserve: [R.claimed()], broker_claim_status: [R.status("dispatched")] });
  await live.claimAndReserve(claimReq);
  assert.deepEqual(await live.takeover(CLAIM, 1, 0), { ok: false, reason: ADAPTER_REFUSALS.notReclaimable });

  const jumpCalls: Call[] = [];
  const jump = make({ broker_claim_and_reserve: [R.claimed(), R.takeover({ fence: 3 })], broker_claim_status: [R.status("released")], broker_release: [R.changed] }, jumpCalls);
  await jump.claimAndReserve(claimReq);
  assert.deepEqual(await jump.takeover(CLAIM, 1, 0), { ok: false, reason: "stale" });
  assert.deepEqual(jumpCalls.at(-1), { fn: "broker_release", args: { p_attempt: A2, p_fence: 3, p_reason: "stale_takeover" } }, "the surprise attempt is handed back");
}));

test("ARN-89 an unbound or malformed command binding never reaches the broker", () => offline(async () => {
  for (const bad of [null, binding({ tenantRef: "t" }), binding({ actionRef: "" }), binding({ maxOutputTokens: 0 }), binding({ maxCachedInputTokens: 101 }), binding({ maxInputTokens: -1 }), binding({ idempotencyKey: "" })]) {
    const r = rig();
    r.flags.binding = bad;
    assert.equal((await r.m.handleEvent(event())).reason, `broker_refused:${ADAPTER_REFUSALS.unbound}`);
    assert.deepEqual(r.calls, []);
  }
}));

test("ARN-89 every RPC is called with exactly the parameters the SQL declares", () => offline(async () => {
  const seen = new Map<string, string[]>();
  const a = createBrokerAdapter({
    rpc: async (fn, args) => {
      seen.set(fn, Object.keys(args));
      return ({ broker_claim_and_reserve: R.claimed(), broker_claim_status: R.status("failed"), broker_mark_dispatched: R.dispatched(), broker_settle: R.settled } as Record<string, unknown>)[fn] ?? R.changed;
    },
    binding: async () => binding(), usageEvidence: async () => "h",
  });
  await a.claimAndReserve({ tenantId: T, claimKey: "c", idempotencyKey: KEY, executor: "claude", tariffId: "free", worstCaseMicros: 0 });
  await a.claimStatus(CLAIM);
  await a.markDispatched(A1, 1);
  await a.markUnknown(A1, 1);
  await a.markFailed(A1, 1);
  await a.release(A1, 1);
  await a.settle(A1, 0, "ref");
  for (const [fn, sig] of Object.entries(BROKER_SIGNATURES)) assert.deepEqual(seen.get(fn), sig.map(([n]) => n), fn);
}));

test("ARN-89 disabled: the adapter is reachable from no live API, scheduler, webhook, provider or workflow path", () => {
  const src = readFileSync("src/broker-adapter.ts", "utf8");
  assert.doesNotMatch(src, /\bfetch\s*\(|process\.env|XMLHttpRequest|WebSocket|child_process|node:(http|https|net|dns|fs)|\bimport\s*\(/, "no network, env, filesystem or dynamic import");
  assert.deepEqual([...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]), ["./manager.ts"], "imports only the manager's types");
  assert.match(src, /^import type /m, "a type-only import: nothing of the manager runs from here");
  const live = [
    ...readdirSync("src").filter((x) => x !== "broker-adapter.ts").map((x) => `src/${x}`),
    ...readdirSync("api").filter((x) => x.endsWith(".js")).map((x) => `api/${x}`),
    ...readdirSync("api/lib").map((x) => `api/lib/${x}`),
    ...readdirSync("dashboard").map((x) => `dashboard/${x}`),
    ...readdirSync(".github/workflows").map((x) => `.github/workflows/${x}`),
    "package.json", "vercel.json",
  ].filter((f) => { try { readFileSync(f); return true; } catch { return false; } });
  for (const f of live) assert.doesNotMatch(readFileSync(f, "utf8"), /broker-adapter|createBrokerAdapter/, `${f} must not reach the adapter`);
});
