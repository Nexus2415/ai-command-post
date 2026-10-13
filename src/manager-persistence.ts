// ARN-92: inert, transport-free contract for a transaction-backed event ledger and audit sink.
//
// This does NOT implement a database, create a connection, grant authority, or activate the manager.
// Callers must inject a tenant-enforcing, authenticated store whose individual operations commit atomically
// with their audit writes. Until that SQL/transport is independently verified, this is synthetic-only.
// No default connection, provider, worker, env read, scheduler, or network path exists here.
import type { AuditSink, EventLedger, Job, LedgerEntry, LedgerOutcome, LedgerVerdict } from "./manager.ts";

export type ManagerPersistenceOperation =
  | "manager_record_receipt"
  | "manager_resolve_receipt"
  | "manager_record_terminal"
  | "manager_append_audit";

export type ManagerPersistenceRpc = (operation: ManagerPersistenceOperation, data: Readonly<Record<string, unknown>>) => Promise<unknown>;

export interface ManagerPersistencePorts {
  ledger: EventLedger;
  audit: AuditSink;
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => whole(v) && v > 0;

function assertScope(v: Obj, tenantId: string, eventId: string): void {
  if (v.ok !== true || v.tenantId !== tenantId || v.eventId !== eventId || v.committed !== true) {
    throw new Error("manager persistence unavailable or unconfirmed");
  }
}

function validJob(v: unknown, tenantId: string, eventId: string, taskId?: string): v is Job {
  if (!object(v) || v.tenantId !== tenantId || v.eventId !== eventId || v.source !== "internal") return false;
  if (taskId !== undefined && v.taskId !== taskId) return false;
  if (!nonempty(v.taskId) || !nonempty(v.jobId) || !nonempty(v.claimKey) || !nonempty(v.idempotencyKey)) return false;
  if (v.idempotencyKey !== `${tenantId}:${eventId}`) return false;
  if (!nonempty(v.intent) || !Array.isArray(v.permissions) || !v.permissions.includes(v.intent)) return false;
  if (v.maxBudgetMicros !== 0 || !positive(v.attempt) || v.attempt > 3) return false;
  if (!["green", "yellow"].includes(String(v.tier))) return false;
  if (!["claude", "chatgpt", "perplexity", "gemini"].includes(String(v.executor))) return false;
  if (!["admitted", "dispatched", "awaiting_verification", "complete", "failed", "unknown", "halted", "awaiting_owner"].includes(String(v.state))) return false;
  // The durable record must not smuggle an unbounded cost or unscoped job into restart recovery.
  if (!nonempty(v.permissionsExpireAt) || Number.isNaN(Date.parse(v.permissionsExpireAt))) return false;
  if (v.claimId !== null && !nonempty(v.claimId)) return false;
  if (v.attemptId !== null && !nonempty(v.attemptId)) return false;
  if (v.fence !== null && !positive(v.fence)) return false;
  return true;
}

function validLedgerEntry(v: unknown, tenantId: string, eventId: string, taskId: string): v is LedgerEntry {
  if (!object(v)) return false;
  if (v.status === "pending") return v.job === null;
  if (v.status !== "admitted" && v.status !== "staged") return false;
  if (!validJob(v.job, tenantId, eventId, taskId)) return false;
  if (v.status === "staged" && v.job.state !== "awaiting_owner") return false;
  if (v.outcome !== undefined) {
    if (!object(v.outcome) || !["complete", "failed"].includes(String(v.outcome.state)) || !positive(v.outcome.fence)) return false;
    if (v.status !== "admitted" || v.job.fence !== v.outcome.fence) return false;
  }
  return true;
}

/** Strict protocol boundary. The injected store, not this adapter, must provide ACID commits and RLS. */
export function createManagerPersistencePorts(rpc: ManagerPersistenceRpc): ManagerPersistencePorts {
  if (typeof rpc !== "function") throw new Error("transaction-backed manager store required");
  const call = async (op: ManagerPersistenceOperation, args: Obj): Promise<Obj> => {
    const r = await rpc(op, Object.freeze({ ...args }));
    if (!object(r)) throw new Error("malformed manager persistence acknowledgment");
    return r;
  };
  return {
    ledger: {
      async record(e): Promise<LedgerVerdict> {
        if (!nonempty(e.tenantId) || !nonempty(e.taskId) || !nonempty(e.eventId) || !whole(e.seq)) throw new Error("invalid receipt");
        const r = await call("manager_record_receipt", e);
        assertScope(r, e.tenantId, e.eventId);
        if (r.taskId !== e.taskId) throw new Error("receipt task mismatch");
        if (r.verdict === "new" || r.verdict === "out_of_order") return { verdict: r.verdict };
        if (r.verdict !== "duplicate" || !validLedgerEntry(r.entry, e.tenantId, e.eventId, e.taskId)) {
          throw new Error("malformed or cross-tenant receipt");
        }
        return { verdict: "duplicate", entry: structuredClone(r.entry) };
      },
      async resolve(e): Promise<void> {
        if (!nonempty(e.tenantId) || !nonempty(e.eventId) || !validJob(e.job, e.tenantId, e.eventId)) throw new Error("invalid admission");
        if (e.status === "staged" && e.job.state !== "awaiting_owner") throw new Error("invalid staged state");
        const r = await call("manager_resolve_receipt", { tenantId: e.tenantId, eventId: e.eventId, taskId: e.job.taskId, status: e.status, job: e.job });
        assertScope(r, e.tenantId, e.eventId);
        if (r.taskId !== e.job.taskId || r.status !== e.status) throw new Error("admission not committed");
      },
      async recordOutcome(e): Promise<void> {
        if (!nonempty(e.tenantId) || !nonempty(e.eventId) || !object(e.outcome)
          || !["complete", "failed"].includes(e.outcome.state) || !positive(e.outcome.fence)) throw new Error("invalid terminal outcome");
        const r = await call("manager_record_terminal", e as unknown as Obj);
        assertScope(r, e.tenantId, e.eventId);
        if (r.state !== e.outcome.state || r.fence !== e.outcome.fence) throw new Error("terminal outcome not committed");
      },
    },
    audit: {
      async append(entry): Promise<void> {
        if (!nonempty(entry.tenantId) || !nonempty(entry.taskId) || !nonempty(entry.eventId)
          || !nonempty(entry.step) || !nonempty(entry.outcome) || !nonempty(entry.at)
          || Number.isNaN(Date.parse(entry.at)) || (entry.jobId !== null && !nonempty(entry.jobId))) {
          throw new Error("invalid scoped audit");
        }
        const r = await call("manager_append_audit", entry);
        assertScope(r, entry.tenantId, entry.eventId);
        if (r.taskId !== entry.taskId || !nonempty(r.auditId)) throw new Error("audit not committed");
      },
    },
  };
}
