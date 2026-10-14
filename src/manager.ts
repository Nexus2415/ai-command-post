// ARN-86: disabled, synthetic-only event-to-job admission seam for the owner-supervised manager.
//
// What this is: a typed event -> job envelope, a deterministic single-executor router, an admission pipeline that
// refuses to dispatch unless a durable claim-and-budget broker answers, and a job state machine. Every outside
// dependency (kill switch, broker, event ledger, audit sink, worker, verifier) is an injected port whose DEFAULT is
// "unavailable", so a manager built with no wiring admits nothing and dispatches nothing.
//
// What this is NOT: nothing here is imported by the engine, the CLI, the console or any workflow. It makes no network,
// provider or Linear call, reads no environment variable and activates nothing (ACP_ACTIVE, Eve dispatch, webhooks,
// schedules stay as they are). It is NOT a second broker: ownership, leases, idempotency and budget live behind the
// `AdmissionBroker` port, which mirrors the ARN-65 contract in opsdesk-harmony (src/lib/execution-broker.ts). A Linear
// comment is not an atomic lock (ARN-52), so no lock is invented here. The Postgres RPC behind the port is ARN-88.
import { createHash } from "node:crypto";
import { DEFAULT_RATES } from "./budget.ts";
import type { AgentKey, Config } from "./config.ts";
import type { Tier } from "./policy.ts";

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

/** Only an internal source is ever admissible. A chat wake, comment or external webhook is untrusted by construction. */
export type EventSource = "internal" | "chat_wake" | "github_comment" | "external_webhook";

export interface ManagerEvent {
  eventId: string;
  kind: string;
  source: EventSource;
  tenantId: string;
  taskId: string;
  /** Per-task monotonic sequence assigned by the trusted emitter; used to refuse out-of-order replays. */
  seq: number;
  occurredAt: string;
  /** Optional hint from the trusted emitter naming an executor. It is checked, never substituted. */
  preferredExecutor?: string;
  /** Free text. Untrusted: it is hashed for evidence and otherwise ignored. It can never change routing or intent. */
  body?: string;
}

/** Intent is fixed by event kind in this table, never by anything in the event body. */
export interface IntentSpec {
  intent: string;
  tier: Tier;
  /** Executors in preference order. */
  executors: AgentKey[];
}

export const EVENT_INTENTS: Readonly<Record<string, IntentSpec>> = Object.freeze({
  task_completed: { intent: "review_result", tier: "green", executors: ["claude", "chatgpt"] },
  owner_schedule: { intent: "periodic_summary", tier: "green", executors: ["chatgpt", "claude"] },
  task_exception: { intent: "triage_exception", tier: "yellow", executors: ["chatgpt", "claude"] },
  deploy_request: { intent: "deploy", tier: "red", executors: [] },
  spend_request: { intent: "spend", tier: "red", executors: [] },
});

const FUTURE_SKEW_MS = 5 * 60_000;
const MAX_EVENT_AGE_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------------------------------------------
// Ports (all default to unavailable)
// ---------------------------------------------------------------------------------------------------------------

export type KillState = "off" | "on" | "error";

export interface ExecutorProfile {
  key: AgentKey;
  configured: boolean;
  /** Suspended executors (currently Gemini) are never eligible, whatever else is true of them. */
  suspended: boolean;
  costTier: "free" | "paid";
  /** Worst-case cost of one attempt, in integer micro-USD. Free executors use 0. */
  worstCaseMicros: number;
}

/** Owner-assigned standing authority. Absent or expired authority admits nothing. */
export interface StandingGrant {
  intent: string;
  maxTier: "green" | "yellow";
  expiresAt: string;
  maxBudgetMicros: number;
}
export interface StandingAuthority {
  grants: StandingGrant[];
  /** Per-action owner approval of paid provider cost. Default false: a paid executor is never eligible. */
  paidExecutionApproved: boolean;
}

export type BrokerRefusal = string;
/**
 * `created: false` means the claim already existed. `idempotencyKey` names the request that created it, so the manager
 * can tell its own earlier, interrupted admission (which it resumes) from another event's claim (which it refuses).
 */
export type BrokerGrant = { claimId: string; attemptId: string; fence: number; operationId: string; created: boolean; idempotencyKey: string };
export type BrokerResult = ({ ok: true } & BrokerGrant) | { ok: false; reason: BrokerRefusal };
export type BrokerStep = { ok: true } | { ok: false; reason: BrokerRefusal };
/** Broker-side state of a claim's latest attempt (ARN-62 attempt states). */
export type AttemptState = "claimed" | "dispatched" | "unknown" | "settled" | "released" | "failed";
export type ClaimStatus = { ok: true; attemptId: string; fence: number; state: AttemptState } | { ok: false; reason: BrokerRefusal };

/**
 * Durable transactional claim-and-budget broker. Shape follows the ARN-65 `ExecutionBroker`. Contract the manager
 * relies on: `markDispatched` succeeds only for the claim's latest attempt while it is `claimed`, so an attempt that
 * was already dispatched, settled, failed or released can never be dispatched (and its worker run) again. `settle` and
 * `markFailed` are idempotent for an attempt already in that state, so a reconciliation can re-record an outcome.
 */
export interface AdmissionBroker {
  /** Latest attempt of a claim and its state. The source of truth for a job recovered after a restart. */
  claimStatus(claimId: string): Promise<ClaimStatus>;
  claimAndReserve(req: { tenantId: string; claimKey: string; idempotencyKey: string; executor: AgentKey; tariffId: string; worstCaseMicros: number }): Promise<BrokerResult>;
  takeover(claimId: string, expectedFence: number, worstCaseMicros: number): Promise<BrokerResult>;
  markDispatched(attemptId: string, fence: number): Promise<BrokerStep>;
  markUnknown(attemptId: string, fence: number): Promise<BrokerStep>;
  markFailed(attemptId: string, fence: number): Promise<BrokerStep>;
  release(attemptId: string, fence: number): Promise<BrokerStep>;
  settle(attemptId: string, actualMicros: number, evidence: string): Promise<BrokerStep>;
}

/**
 * Durable admission status of one event. `pending` means receipt was recorded but admission did not finish (an audit,
 * broker or kill-switch stop, or a crash): a redelivery of the same event resumes admission. `admitted` and `staged`
 * carry the job, including its claim reference, so a redelivery recovers it even after the manager restarts.
 */
export type LedgerEntry = { status: "pending"; job: null } | { status: "admitted" | "staged"; job: Job; outcome?: LedgerOutcome };
/**
 * A terminal outcome, recorded only after its broker acknowledgment AND its audit entry exist, for one attempt (fence).
 * The broker proves an attempt was settled or failed; only this record proves the matching audit evidence was written.
 */
export type LedgerOutcome = { state: "complete" | "failed"; fence: number };
export type LedgerVerdict = { verdict: "new" } | { verdict: "out_of_order" } | { verdict: "duplicate"; entry: LedgerEntry };
/** Durable per-task event ledger. */
export interface AdmissionExpectation {
  /** Derived from the manager's fixed event-kind policy and owner grant, never the persisted snapshot. */
  kind: string;
  intent: string;
  tier: "green" | "yellow";
  executor: AgentKey;
  claimKey: string;
  bodyDigest: string;
  permissionsExpireAt: string;
  maxBudgetMicros: number;
}

export interface EventLedger {
  /** Records receipt as `pending`, atomically with the duplicate and out-of-order checks.
   * The optional expectation retains compatibility with inert test doubles; a real durable adapter MUST require it.
   */
  record(e: { tenantId: string; taskId: string; eventId: string; seq: number; expectation?: AdmissionExpectation }): Promise<LedgerVerdict>;
  /** Durably moves a pending receipt to its admission outcome. Throwing means it was not recorded. */
  resolve(e: { tenantId: string; eventId: string; status: "admitted" | "staged"; job: Job }): Promise<void>;
  /** Durably records an admitted job's terminal outcome for one attempt. Throwing means it was not recorded. */
  recordOutcome(e: { tenantId: string; eventId: string; outcome: LedgerOutcome }): Promise<void>;
}

export interface AuditEntry {
  at: string;
  /** Explicit tenant and task scope for durable audit/RLS; event IDs alone are not globally unique. */
  tenantId: string;
  taskId: string;
  eventId: string;
  jobId: string | null;
  step: string;
  outcome: string;
}
/** Audit sink. Throwing means the entry was not durably recorded; the manager then refuses to continue. */
export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
}

export interface WorkerResult {
  summary: string;
  actualMicros: number;
}
/** One worker per job. A throw or a non-result is an ambiguous outcome, never a success. */
export interface Worker {
  run(job: Job): Promise<WorkerResult>;
}
export interface Verification {
  ok: boolean;
  checkedBy: AgentKey | "system";
  ref: string;
}
/** Independent checker of a worker result. It must not be the executor that produced the result. */
export interface Verifier {
  verify(job: Job, result: WorkerResult): Promise<Verification>;
}

export interface Ports {
  killSwitch: () => KillState;
  broker: AdmissionBroker;
  ledger: EventLedger;
  audit: AuditSink;
  worker: Worker;
  verifier: Verifier;
  executors: ExecutorProfile[];
  authority: StandingAuthority;
  now: () => Date;
}

const down = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} unavailable`);
};
export const UNAVAILABLE_BROKER: AdmissionBroker = {
  claimStatus: down("broker"),
  claimAndReserve: down("broker"),
  takeover: down("broker"),
  markDispatched: down("broker"),
  markUnknown: down("broker"),
  markFailed: down("broker"),
  release: down("broker"),
  settle: down("broker"),
};

/** Ports that make a manager inert: kill switch reads "error" (treated as on), nothing is reachable. */
export function inertPorts(): Ports {
  return {
    killSwitch: () => "error",
    broker: UNAVAILABLE_BROKER,
    ledger: { record: down("event ledger"), resolve: down("event ledger"), recordOutcome: down("event ledger") },
    audit: { append: down("audit sink") },
    worker: { run: down("worker") },
    verifier: { verify: down("verifier") },
    executors: [],
    authority: { grants: [], paidExecutionApproved: false },
    now: () => new Date(),
  };
}

/** Roster from config key presence, with Gemini suspended (owner decision). Never reads the environment itself. */
export function rosterFromConfig(cfg: Config, suspended: AgentKey[] = ["gemini"]): ExecutorProfile[] {
  const keyOf: Record<AgentKey, string | undefined> = { claude: cfg.keys.anthropic, chatgpt: cfg.keys.openai, gemini: cfg.keys.gemini, perplexity: cfg.keys.perplexity };
  return (Object.keys(keyOf) as AgentKey[]).map((key) => ({
    key,
    configured: !!keyOf[key],
    suspended: suspended.includes(key),
    costTier: DEFAULT_RATES[key].freeTier ? "free" : "paid",
    worstCaseMicros: DEFAULT_RATES[key].freeTier ? 0 : 1_000_000,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs and the state machine
// ---------------------------------------------------------------------------------------------------------------

export type JobState = "admitted" | "dispatched" | "awaiting_verification" | "complete" | "failed" | "unknown" | "halted" | "awaiting_owner";
export const MAX_ATTEMPTS = 3;

export interface Job {
  jobId: string;
  eventId: string;
  correlationId: string;
  tenantId: string;
  taskId: string;
  source: "internal";
  intent: string;
  tier: Tier;
  trigger: { kind: string; seq: number; bodyDigest: string };
  idempotencyKey: string;
  /** One executor per tenant, task and intent. */
  claimKey: string;
  executor: AgentKey;
  permissions: string[];
  permissionsExpireAt: string;
  maxBudgetMicros: number;
  state: JobState;
  /** Monotonic attempt number; the replay identity is `${jobId}#${attempt}`. */
  attempt: number;
  replayId: string;
  claimId: string | null;
  attemptId: string | null;
  fence: number | null;
  result: WorkerResult | null;
  /** Insertion order, for deterministic next-job selection. */
  order: number;
}

export type Status = "ADMITTED" | "DUPLICATE" | "AWAITING_OWNER" | "OWNER_APPROVAL_REQUIRED" | "BLOCKED" | "REJECTED" | "HALTED";
export interface Decision {
  status: Status;
  reason: string;
  job?: Job;
}
export interface OwnerQueueItem {
  eventId: string;
  jobId: string | null;
  needs: "approval" | "reconciliation" | "attention";
  reason: string;
}

/** Allowed transitions. Anything else is refused, so a late or duplicate signal cannot move a job backwards. */
const NEXT: Record<JobState, JobState[]> = {
  admitted: ["dispatched", "halted"],
  dispatched: ["awaiting_verification", "failed", "unknown", "halted"],
  awaiting_verification: ["complete", "failed", "unknown", "halted"],
  unknown: ["complete", "failed"],
  failed: ["admitted"], // bounded retry only
  complete: [],
  halted: [],
  awaiting_owner: [],
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 200;

export interface Reconciliation {
  checkedBy: AgentKey | "owner" | "system";
  outcome: "completed" | "not_executed";
  ref: string;
}

export class Manager {
  readonly jobs = new Map<string, Job>();
  readonly ownerQueue: OwnerQueueItem[] = [];
  /** Every kill-switch check, by boundary name, in order. Lets tests prove the switch is read at each boundary. */
  readonly boundaries: string[] = [];
  private n = 0;

  private readonly p: Ports;

  constructor(ports: Ports = inertPorts()) {
    this.p = ports;
  }

  // --- helpers --------------------------------------------------------------------------------------------------

  /** Reads the kill switch at a boundary. Anything but "off" (including an unreadable switch) stops the run here. */
  private live(boundary: string): boolean {
    this.boundaries.push(boundary);
    try {
      return this.p.killSwitch() === "off";
    } catch {
      return false;
    }
  }

  private async audit(tenantId: string, taskId: string, eventId: string, job: Job | null, step: string, outcome: string): Promise<boolean> {
    try {
      await this.p.audit.append({ at: this.p.now().toISOString(), tenantId, taskId, eventId, jobId: job?.jobId ?? null, step, outcome });
      return true;
    } catch {
      return false;
    }
  }

  private move(job: Job, to: JobState): boolean {
    if (!NEXT[job.state].includes(to)) return false;
    job.state = to;
    return true;
  }

  private queue(item: OwnerQueueItem): void {
    this.ownerQueue.push(item);
  }

  private halted(job: Job | null, boundary: string): Decision {
    if (job) this.move(job, "halted");
    return { status: "HALTED", reason: `kill switch on or unreadable at ${boundary}`, ...(job ? { job } : {}) };
  }

  // --- event -> job ---------------------------------------------------------------------------------------------

  async handleEvent(raw: unknown): Promise<Decision> {
    const e = raw as Partial<ManagerEvent> | null;
    if (!this.live("ingest")) return this.halted(null, "ingest");

    // 1. Structural validation and trust. Nothing from the body is read beyond a digest.
    if (!e || typeof e !== "object" || !str(e.eventId) || !str(e.kind) || !str(e.tenantId) || !str(e.taskId) || !Number.isSafeInteger(e.seq) || (e.seq as number) < 0 || !str(e.occurredAt)) {
      return { status: "REJECTED", reason: "malformed_event" };
    }
    if (e.source !== "internal") return { status: "REJECTED", reason: `untrusted_source:${String(e.source)}` };
    const at = Date.parse(e.occurredAt);
    const now = this.p.now().getTime();
    if (Number.isNaN(at) || at > now + FUTURE_SKEW_MS || now - at > MAX_EVENT_AGE_MS) return { status: "REJECTED", reason: "stale_or_future_event" };
    const spec = Object.hasOwn(EVENT_INTENTS, e.kind) ? EVENT_INTENTS[e.kind] : undefined;
    if (!spec) return { status: "REJECTED", reason: "unknown_event_kind" };
    if (spec.tier === "red") {
      this.queue({ eventId: e.eventId, jobId: null, needs: "approval", reason: `${spec.intent} is owner-only` });
      return { status: "OWNER_APPROVAL_REQUIRED", reason: `${spec.intent} is a red-tier action and never runs automatically` };
    }

    // 2. Authority: owner-assigned, unexpired, covering this intent and tier.
    if (!this.live("route")) return this.halted(null, "route");
    const grant = this.p.authority.grants.find((g) => g.intent === spec.intent);
    if (!grant) return { status: "BLOCKED", reason: "permission_missing" };
    const expires = Date.parse(grant.expiresAt);
    if (Number.isNaN(expires) || expires <= now) return { status: "BLOCKED", reason: "permission_expired" };
    if (spec.tier === "yellow" && grant.maxTier !== "yellow") {
      this.queue({ eventId: e.eventId, jobId: null, needs: "approval", reason: `${spec.intent} needs yellow-tier authority` });
      return { status: "OWNER_APPROVAL_REQUIRED", reason: "grant does not cover yellow-tier work" };
    }

    // 3. Routing: exactly one existing supported executor, or BLOCKED. No fan-out, no silent substitution.
    const pick = this.route(spec, e.preferredExecutor, grant);
    if ("blocked" in pick) return { status: "BLOCKED", reason: pick.blocked };
    const executor = pick.executor;

    // 4. Durable event ledger (duplicate and out-of-order refusal). Unavailable ledger means no dispatch.
    if (!this.live("ledger")) return this.halted(null, "ledger");
    let recorded: LedgerVerdict;
    try {
      recorded = await this.p.ledger.record({
        tenantId: e.tenantId, taskId: e.taskId, eventId: e.eventId, seq: e.seq as number,
        expectation: {
          kind: e.kind, intent: spec.intent, tier: spec.tier as "green" | "yellow", executor,
          claimKey: `${e.tenantId}:${e.taskId}:${spec.intent}`,
          bodyDigest: sha(typeof e.body === "string" ? e.body : ""),
          permissionsExpireAt: grant.expiresAt, maxBudgetMicros: grant.maxBudgetMicros,
        },
      });
    } catch {
      return { status: "BLOCKED", reason: "ledger_unavailable" };
    }
    const idempotencyKey = `${e.tenantId}:${e.eventId}`;
    if (recorded.verdict === "out_of_order") return { status: "REJECTED", reason: "out_of_order" };
    // A duplicate is benign only when its outcome is durably recoverable. A pending receipt (admission was interrupted)
    // falls through and resumes admission; the broker's idempotency makes the resumed claim the same claim.
    const resuming = recorded.verdict === "duplicate";
    if (recorded.verdict === "duplicate" && recorded.entry.status !== "pending") {
      const durable = recorded.entry.job;
      if (!durable || durable.idempotencyKey !== idempotencyKey) return { status: "BLOCKED", reason: "ledger_entry_unrecoverable" };
      const local = this.jobs.get(durable.jobId);
      if (local) return { status: "DUPLICATE", reason: `event already ${recorded.entry.status}; nothing dispatched`, job: local };
      const recovered = await this.recover(structuredClone(durable), recorded.entry.status === "admitted" ? recorded.entry.outcome : undefined);
      if ("blocked" in recovered) return { status: "BLOCKED", reason: recovered.blocked };
      return { status: "DUPLICATE", reason: `event already ${recorded.entry.status}; recovered as ${recovered.job.state}; nothing dispatched`, job: recovered.job };
    }

    const job: Job = {
      jobId: `job-${sha(idempotencyKey)}`,
      eventId: e.eventId,
      correlationId: `corr-${sha(`${e.tenantId}:${e.taskId}`)}`,
      tenantId: e.tenantId,
      taskId: e.taskId,
      source: "internal",
      intent: spec.intent,
      tier: spec.tier,
      trigger: { kind: e.kind, seq: e.seq as number, bodyDigest: sha(typeof e.body === "string" ? e.body : "") },
      idempotencyKey,
      claimKey: `${e.tenantId}:${e.taskId}:${spec.intent}`,
      executor,
      permissions: [spec.intent],
      permissionsExpireAt: grant.expiresAt,
      maxBudgetMicros: grant.maxBudgetMicros,
      state: spec.tier === "yellow" ? "awaiting_owner" : "admitted",
      attempt: 1,
      replayId: "",
      claimId: null,
      attemptId: null,
      fence: null,
      result: null,
      order: 0,
    };
    job.replayId = `${job.jobId}#1`;

    // 5. Audit before any claim. A missing audit trail blocks the job (the receipt stays pending, so a retry resumes).
    if (!this.live("audit")) return this.halted(null, "audit");
    if (!(await this.audit(e.tenantId, e.taskId, e.eventId, null, "admission_decided", `${spec.tier}:${spec.intent}:${executor}`))) return { status: "BLOCKED", reason: "audit_unavailable" };

    // Yellow work is staged: recorded for the owner, with no claim, no reservation and no dispatch.
    if (spec.tier === "yellow") {
      if (!(await this.resolve(job, "staged"))) return { status: "BLOCKED", reason: "ledger_unavailable" };
      this.adopt(job);
      this.queue({ eventId: e.eventId, jobId: job.jobId, needs: "approval", reason: `${spec.intent} staged for owner approval` });
      return { status: "AWAITING_OWNER", reason: "yellow-tier work is staged until the owner approves", job };
    }

    // 6. Atomic claim + budget through the broker. If it cannot answer, nothing is dispatched.
    if (!this.live("claim")) return this.halted(null, "claim");
    const profile = this.p.executors.find((x) => x.key === executor)!;
    let claim: BrokerResult;
    try {
      claim = await this.p.broker.claimAndReserve({ tenantId: e.tenantId, claimKey: job.claimKey, idempotencyKey, executor, tariffId: profile.costTier, worstCaseMicros: profile.worstCaseMicros });
    } catch {
      return { status: "BLOCKED", reason: "broker_unavailable" };
    }
    if (!claim.ok) return { status: "BLOCKED", reason: `broker_refused:${claim.reason}` };
    if (!claim.created) {
      // The claim already exists. Only this event's own interrupted admission may take it over; another event's claim
      // on the same task and intent is never a second job, and never a silent "duplicate" either.
      if (claim.idempotencyKey !== idempotencyKey) {
        this.queue({ eventId: e.eventId, jobId: null, needs: "attention", reason: `claim ${claim.claimId} is held by another event` });
        return { status: "BLOCKED", reason: "claim_held_by_another_event" };
      }
      if (!resuming) {
        this.queue({ eventId: e.eventId, jobId: null, needs: "attention", reason: `claim ${claim.claimId} exists without a ledger receipt` });
        return { status: "BLOCKED", reason: "claim_without_ledger_receipt" };
      }
    }
    job.claimId = claim.claimId;
    job.attemptId = claim.attemptId;
    job.fence = claim.fence;
    if (!(await this.audit(e.tenantId, e.taskId, e.eventId, job, "admitted", `${claim.claimId}/${claim.attemptId}/fence=${claim.fence}`))) {
      await this.p.broker.release(claim.attemptId, claim.fence).catch(() => undefined);
      return { status: "BLOCKED", reason: "audit_failed_after_claim; reservation released" };
    }
    // The receipt becomes `admitted` with the claim reference only after the claim and its audit entry exist.
    if (!(await this.resolve(job, "admitted"))) {
      await this.p.broker.release(claim.attemptId, claim.fence).catch(() => undefined);
      await this.audit(e.tenantId, e.taskId, e.eventId, job, "admission_rolled_back", "ledger_unavailable");
      return { status: "BLOCKED", reason: "ledger_unavailable_after_claim; reservation released" };
    }
    this.adopt(job);
    return { status: "ADMITTED", reason: "claimed and reserved", job };
  }

  private async resolve(job: Job, status: "admitted" | "staged"): Promise<boolean> {
    try {
      await this.p.ledger.resolve({ tenantId: job.tenantId, eventId: job.eventId, status, job: structuredClone(job) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rebuilds a job this manager has not seen (after a restart) from its ledger snapshot plus the broker's current
   * state, never from the snapshot alone: the snapshot is the admission record, and every later transition is the
   * broker's. Work that may have run comes back `unknown` for independent reconciliation, and only an attempt that is
   * still `claimed` comes back dispatchable. A settled or failed attempt comes back `complete` or `failed` only when the
   * ledger holds that same outcome for that same fence (proof its audit evidence was written); otherwise `unknown`.
   */
  private async recover(job: Job, outcome: LedgerOutcome | undefined): Promise<{ job: Job } | { blocked: string }> {
    if (job.state === "awaiting_owner" && job.claimId === null) return { job: this.adopt(job) };
    if (job.state !== "admitted" || job.claimId === null) return { blocked: "ledger_entry_unrecoverable" };
    let st: ClaimStatus;
    try {
      st = await this.p.broker.claimStatus(job.claimId);
    } catch {
      return { blocked: "broker_unavailable" };
    }
    if (!st.ok) return { blocked: `broker_refused:${st.reason}` };
    if (job.fence !== null && st.fence < job.fence) return { blocked: "non_monotonic_fence" };
    job.attemptId = st.attemptId;
    job.fence = st.fence;
    // Every attempt takes a fresh fence, so the fence bounds how many attempts were made: retries stay bounded.
    job.attempt = Math.max(job.attempt, st.fence);
    job.replayId = `${job.jobId}#${job.attempt}`;
    const proven = (state: "complete" | "failed"): JobState => (outcome?.state === state && outcome.fence === st.fence ? state : "unknown");
    const recoveredState: Record<AttemptState, () => JobState> = {
      claimed: () => "admitted",
      dispatched: () => "unknown",
      unknown: () => "unknown",
      settled: () => proven("complete"),
      failed: () => proven("failed"),
      released: () => "halted",
    };
    job.state = recoveredState[st.state]();
    this.adopt(job);
    if (job.state === "unknown") {
      const why = st.state === "settled" || st.state === "failed" ? `attempt ${st.state} at the broker but its outcome evidence is not recorded` : `attempt ${st.state}`;
      this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "reconciliation", reason: `recovered after restart: ${why}` });
    }
    if (job.state === "halted") this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "attention", reason: "recovered after restart with a released attempt" });
    return { job };
  }

  /** Records a terminal outcome for the job's current attempt. Called only after the broker ack and the audit entry. */
  private async recordOutcome(job: Job, state: "complete" | "failed"): Promise<boolean> {
    if (job.fence === null) return false;
    try {
      await this.p.ledger.recordOutcome({ tenantId: job.tenantId, eventId: job.eventId, outcome: { state, fence: job.fence } });
      return true;
    } catch {
      return false;
    }
  }

  /** Puts a job (new, or recovered from the ledger after a restart) into the local index. */
  private adopt(job: Job): Job {
    job.order = ++this.n;
    this.jobs.set(job.jobId, job);
    return job;
  }

  private route(spec: IntentSpec, preferred: string | undefined, grant: StandingGrant): { executor: AgentKey } | { blocked: string } {
    const eligible = (x: ExecutorProfile): string | null => {
      if (!x.configured) return "executor_unconfigured";
      if (x.suspended) return "executor_suspended";
      if (x.costTier === "paid" && !this.p.authority.paidExecutionApproved) return "unapproved_provider_cost";
      if (x.worstCaseMicros > grant.maxBudgetMicros) return "insufficient_budget";
      return null;
    };
    if (preferred !== undefined) {
      if (!spec.executors.includes(preferred as AgentKey)) return { blocked: "executor_not_supported" };
      const x = this.p.executors.find((y) => y.key === preferred);
      if (!x) return { blocked: "executor_unconfigured" };
      const why = eligible(x);
      return why ? { blocked: why } : { executor: x.key };
    }
    let firstWhy = "no_eligible_executor";
    for (const key of spec.executors) {
      const x = this.p.executors.find((y) => y.key === key);
      if (!x) continue;
      const why = eligible(x);
      if (!why) return { executor: key };
      if (firstWhy === "no_eligible_executor") firstWhy = why;
    }
    return { blocked: firstWhy };
  }

  // --- dispatch, verification, reconciliation -------------------------------------------------------------------

  /** Runs one admitted job on its one worker. Checks the kill switch before every forward step. */
  async dispatch(jobId: string): Promise<Decision> {
    const job = this.jobs.get(jobId);
    if (!job) return { status: "REJECTED", reason: "unknown_job" };
    if (job.state !== "admitted" || job.attemptId === null || job.fence === null) return { status: "REJECTED", reason: `job_not_dispatchable:${job.state}`, job };
    if (!this.live("dispatch")) return this.stop(job, "dispatch");
    const { attemptId, fence } = job;
    let step: BrokerStep;
    try {
      step = await this.p.broker.markDispatched(attemptId, fence);
    } catch {
      return { status: "BLOCKED", reason: "broker_unavailable", job };
    }
    if (!step.ok) return { status: "BLOCKED", reason: `broker_refused:${step.reason}`, job };
    this.move(job, "dispatched");
    if (!(await this.audit(job.tenantId, job.taskId, job.eventId, job, "dispatched", job.replayId))) return this.ambiguous(job, "audit_failed_after_dispatch");
    if (!this.live("worker_start")) {
      // Marked dispatched but the worker has not been started: a known non-execution, so close the attempt as failed.
      await this.p.broker.markFailed(attemptId, fence).catch(() => this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "attention", reason: "halted before the worker started; attempt could not be closed" }));
      return this.halted(job, "worker_start");
    }

    let result: WorkerResult;
    try {
      result = await this.p.worker.run(job);
    } catch {
      // The worker may have done anything before it threw: ambiguous, never retried automatically.
      return this.ambiguous(job, "worker_outcome_unknown");
    }
    if (!result || typeof result.summary !== "string" || !Number.isSafeInteger(result.actualMicros) || result.actualMicros < 0) return this.ambiguous(job, "worker_returned_no_result");
    this.move(job, "awaiting_verification");
    job.result = result;

    if (!this.live("verify")) return this.stop(job, "verify");
    let v: Verification;
    try {
      v = await this.p.verifier.verify(job, result);
    } catch {
      return this.ambiguous(job, "verifier_unavailable");
    }
    if (!v || v.checkedBy === job.executor) return this.ambiguous(job, "verifier_not_independent");
    // From here the worker has run. A job moves to `failed` or `complete` only after the audit entry and the broker both
    // acknowledge; if either cannot, the outcome is unknown and goes to an independent reconciliation.
    if (!v.ok) {
      if (!(await this.audit(job.tenantId, job.taskId, job.eventId, job, "verification_failed", v.ref))) return this.ambiguous(job, "audit_failed_on_rejected_result");
      const f = await this.p.broker.markFailed(attemptId, fence).catch(() => ({ ok: false as const, reason: "unavailable" }));
      if (!f.ok) return this.ambiguous(job, `mark_failed_refused:${f.reason}`);
      if (!(await this.recordOutcome(job, "failed"))) return this.ambiguous(job, "ledger_failed_after_mark_failed");
      this.move(job, "failed");
      return { status: "BLOCKED", reason: "result_failed_independent_check", job };
    }

    if (!this.live("settle")) return this.stop(job, "settle");
    if (!(await this.audit(job.tenantId, job.taskId, job.eventId, job, "verified", v.ref))) return this.ambiguous(job, "audit_failed_before_settle");
    try {
      const s = await this.p.broker.settle(attemptId, result.actualMicros, v.ref);
      if (!s.ok) return this.ambiguous(job, `settle_refused:${s.reason}`);
    } catch {
      return this.ambiguous(job, "settle_unavailable");
    }
    if (!(await this.audit(job.tenantId, job.taskId, job.eventId, job, "complete", v.ref))) return this.ambiguous(job, "audit_failed_after_settle");
    if (!(await this.recordOutcome(job, "complete"))) return this.ambiguous(job, "ledger_failed_after_settle");
    this.move(job, "complete");
    return { status: "ADMITTED", reason: "complete and independently checked", job };
  }

  /** Halts a job at a boundary. A held reservation is released (a safety release, not a forward step). */
  private async stop(job: Job, boundary: string): Promise<Decision> {
    if (job.state === "admitted" && job.attemptId !== null && job.fence !== null) {
      const rel = await this.p.broker.release(job.attemptId, job.fence).catch(() => ({ ok: false as const, reason: "unavailable" }));
      if (!rel.ok) this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "attention", reason: "halted but the reservation could not be released" });
    } else if (job.state === "awaiting_verification" || job.state === "dispatched") {
      // Work may have run. Do not release; record unknown so an independent check or the owner reconciles it.
      return this.ambiguous(job, `halted_at_${boundary}_after_work_may_have_run`);
    }
    return this.halted(job, boundary);
  }

  private async ambiguous(job: Job, why: string): Promise<Decision> {
    if (this.move(job, "unknown") && job.attemptId !== null && job.fence !== null) await this.p.broker.markUnknown(job.attemptId, job.fence).catch(() => undefined);
    this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "reconciliation", reason: why });
    await this.audit(job.tenantId, job.taskId, job.eventId, job, "unknown", why);
    return { status: "BLOCKED", reason: `unknown_outcome:${why}`, job };
  }

  /** Independent reconciliation of an UNKNOWN job. The checker must not be the job's own executor. */
  async reconcile(jobId: string, r: Reconciliation): Promise<Decision> {
    const job = this.jobs.get(jobId);
    if (!job) return { status: "REJECTED", reason: "unknown_job" };
    if (job.state !== "unknown" || job.attemptId === null || job.fence === null) return { status: "REJECTED", reason: `job_not_unknown:${job.state}`, job };
    if (r.checkedBy === job.executor || !str(r.ref)) return { status: "REJECTED", reason: "reconciliation_not_independent_or_unreferenced", job };
    if (!this.live("reconcile")) return this.halted(job, "reconcile");
    const { attemptId, fence } = job;
    // The job stays unknown unless the decision is audited, the broker acknowledges it, and the result is audited.
    if (!(await this.audit(job.tenantId, job.taskId, job.eventId, job, "reconcile_decided", `${r.outcome}:${r.checkedBy}:${r.ref}`))) return { status: "BLOCKED", reason: "audit_unavailable", job };
    const step: BrokerStep =
      r.outcome === "completed"
        ? await this.p.broker.settle(attemptId, job.result?.actualMicros ?? 0, r.ref).catch(() => ({ ok: false as const, reason: "unavailable" }))
        : await this.p.broker.markFailed(attemptId, fence).catch(() => ({ ok: false as const, reason: "unavailable" }));
    if (!step.ok) return { status: "BLOCKED", reason: `broker_refused:${step.reason}`, job };
    if (!(await this.audit(job.tenantId, job.taskId, job.eventId, job, "reconciled", `${r.outcome}:${r.ref}`))) {
      this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "attention", reason: `broker recorded ${r.outcome} but the reconciliation audit entry failed` });
      return { status: "BLOCKED", reason: "audit_failed_after_reconcile", job };
    }
    const to = r.outcome === "completed" ? "complete" : "failed";
    if (!(await this.recordOutcome(job, to))) {
      this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "attention", reason: `broker recorded ${r.outcome} but the ledger outcome could not be recorded` });
      return { status: "BLOCKED", reason: "ledger_failed_after_reconcile", job };
    }
    this.move(job, to);
    const i = this.ownerQueue.findIndex((q) => q.jobId === job.jobId && q.needs === "reconciliation");
    if (i >= 0) this.ownerQueue.splice(i, 1);
    return { status: "ADMITTED", reason: `reconciled as ${r.outcome}`, job };
  }

  /** Bounded retry: only after a definite failure, never after an unknown outcome, with a fresh fence and attempt id. */
  async retry(jobId: string): Promise<Decision> {
    const job = this.jobs.get(jobId);
    if (!job) return { status: "REJECTED", reason: "unknown_job" };
    if (job.state !== "failed" || job.claimId === null || job.fence === null) return { status: "REJECTED", reason: `job_not_retryable:${job.state}`, job };
    if (job.attempt >= MAX_ATTEMPTS) {
      this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "attention", reason: "retries exhausted" });
      return { status: "BLOCKED", reason: "retries_exhausted", job };
    }
    if (!this.live("retry")) return this.halted(job, "retry");
    const profile = this.p.executors.find((x) => x.key === job.executor);
    if (!profile) return { status: "BLOCKED", reason: "executor_unconfigured", job };
    let t: BrokerResult;
    try {
      t = await this.p.broker.takeover(job.claimId, job.fence, profile.worstCaseMicros);
    } catch {
      return { status: "BLOCKED", reason: "broker_unavailable", job };
    }
    if (!t.ok) return { status: "BLOCKED", reason: `broker_refused:${t.reason}`, job };
    if (t.fence <= job.fence) return { status: "BLOCKED", reason: "non_monotonic_fence", job };
    // The claim has moved to the fresh attempt either way; the job only becomes admitted once that is audited.
    job.attemptId = t.attemptId;
    job.fence = t.fence;
    if (!(await this.audit(job.tenantId, job.taskId, job.eventId, job, "retry_admitted", `${job.jobId}#${job.attempt + 1}`))) {
      const rel = await this.p.broker.release(t.attemptId, t.fence).catch(() => ({ ok: false as const, reason: "unavailable" }));
      if (!rel.ok) this.queue({ eventId: job.eventId, jobId: job.jobId, needs: "attention", reason: "retry not audited and its fresh attempt could not be released" });
      return { status: "BLOCKED", reason: "audit_unavailable; fresh attempt released", job };
    }
    job.attempt += 1;
    job.replayId = `${job.jobId}#${job.attempt}`;
    job.result = null;
    this.move(job, "admitted");
    return { status: "ADMITTED", reason: `attempt ${job.attempt} admitted`, job };
  }

  /** Next admitted job: oldest first, one active job per claim key. Staged, unknown and halted jobs are never eligible. */
  nextEligible(): Job | null {
    const all = [...this.jobs.values()];
    const busy = new Set(all.filter((j) => ["dispatched", "awaiting_verification", "unknown"].includes(j.state)).map((j) => j.claimKey));
    return all.filter((j) => j.state === "admitted" && !busy.has(j.claimKey)).sort((a, b) => a.order - b.order)[0] ?? null;
  }
}
