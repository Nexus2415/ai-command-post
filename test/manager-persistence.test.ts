// ARN-92: contract-only tests. A scripted transaction gateway stands in for a future
// tenant-scoped PostgreSQL RPC; nothing opens a network connection or writes live data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createManagerPersistencePorts, type ManagerPersistenceOperation } from "../src/manager-persistence.ts";
import type { AuditEntry, Job } from "../src/manager.ts";

const T = "synthetic-tenant-a";
const E = "synthetic-event-1";
const TASK = "synthetic-task-1";
const job: Job = {
  jobId: "job-1", eventId: E, correlationId: "corr-1", tenantId: T, taskId: TASK,
  source: "internal", intent: "review_result", tier: "green",
  trigger: { kind: "task_completed", seq: 1, bodyDigest: "digest" },
  idempotencyKey: `${T}:${E}`, claimKey: `${T}:${TASK}:review_result`,
  executor: "claude", permissions: ["review_result"], permissionsExpireAt: "2030-01-01T00:00:00Z",
  maxBudgetMicros: 0, state: "admitted", attempt: 1, replayId: "job-1#1",
  claimId: "claim-1", attemptId: "attempt-1", fence: 1, result: null, order: 1,
};
const receipt = { tenantId: T, taskId: TASK, eventId: E, seq: 1 };
const audit: AuditEntry = {
  at: "2026-10-12T00:00:00Z", tenantId: T, taskId: TASK,
  eventId: E, jobId: null, step: "admission_decided", outcome: "green:review_result:claude",
};

type Ack = Record<string, unknown>;
function scripted(replies: Ack[]) {
  const calls: { op: ManagerPersistenceOperation; args: Readonly<Record<string, unknown>> }[] = [];
  const p = createManagerPersistencePorts(async (op, args) => {
    calls.push({ op, args });
    return replies.shift() ?? null;
  });
  return { p, calls };
}
const ok = (more: Ack = {}) => ({ ok: true, tenantId: T, eventId: E, committed: true, ...more });

async function offline<TValue>(action: () => Promise<TValue>): Promise<TValue> {
  const previous = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (() => { hits++; throw Error("network forbidden in contract test"); }) as typeof fetch;
  try { return await action(); }
  finally { globalThis.fetch = previous; assert.equal(hits, 0); }
}

test("ARN-92 commit-backed receipt, audit, admission and terminal writes require explicit matching acknowledgments", () => offline(async () => {
  const { p, calls } = scripted([
    ok({ verdict: "new", taskId: TASK }),
    ok({ taskId: TASK, auditId: "audit-1" }),
    ok({ taskId: TASK, status: "admitted" }),
    ok({ state: "complete", fence: 1 }),
  ]);
  assert.deepEqual(await p.ledger.record(receipt), { verdict: "new" });
  await p.audit.append(audit);
  await p.ledger.resolve({ tenantId: T, eventId: E, status: "admitted", job });
  await p.ledger.recordOutcome({ tenantId: T, eventId: E, outcome: { state: "complete", fence: 1 } });
  assert.deepEqual(calls.map((x) => x.op), [
    "manager_record_receipt", "manager_append_audit", "manager_resolve_receipt", "manager_record_terminal",
  ]);
  assert.equal(calls[1]?.args.tenantId, T);
  assert.equal(calls[1]?.args.taskId, TASK);
}));

test("ARN-92 same event ID under another tenant is not a successful acknowledgment", () => offline(async () => {
  const { p } = scripted([ok({ tenantId: "synthetic-tenant-b", verdict: "new", taskId: TASK })]);
  await assert.rejects(p.ledger.record(receipt), /unconfirmed/);
}));

test("ARN-92 reject missing commit, malformed acknowledgment, wrong task and unavailable store", () => offline(async () => {
  for (const reply of [null, { ok: true, tenantId: T, eventId: E, verdict: "new", taskId: TASK }, ok({ verdict: "new", taskId: "different-task" })]) {
    const { p } = scripted([reply as Ack]);
    await assert.rejects(p.ledger.record(receipt));
  }
  const p = createManagerPersistencePorts(async () => { throw new Error("database down"); });
  await assert.rejects(p.ledger.record(receipt), /database down/);
}));

test("ARN-92 duplicate job snapshot must retain tenant, event, task, internal origin and zero-spend", () => offline(async () => {
  const good = scripted([ok({ verdict: "duplicate", taskId: TASK, entry: { status: "admitted", job } })]);
  const out = await good.p.ledger.record(receipt);
  assert.equal(out.verdict, "duplicate");
  if (out.verdict === "duplicate") assert.deepEqual(out.entry.job, job);

  const corrupt: Job[] = [
    { ...job, tenantId: "different-tenant" },
    { ...job, eventId: "different-event" },
    { ...job, taskId: "different-task" },
    { ...job, maxBudgetMicros: 1 },
    { ...job, source: "external_webhook" as Job["source"] },
    { ...job, idempotencyKey: "other" },
    { ...job, claimKey: `${T}:other-task:review_result` },
    { ...job, permissions: ["review_result", "deploy"] },
    { ...job, replayId: "job-1#9" },
    { ...job, trigger: { ...job.trigger, seq: -1 } },
  ];
  for (const forged of corrupt) {
    const { p } = scripted([ok({ verdict: "duplicate", taskId: TASK, entry: { status: "admitted", job: forged } })]);
    await assert.rejects(p.ledger.record(receipt), /cross-tenant receipt/);
  }
}));

test("ARN-92 audits never accept missing tenant, missing task, or an unconfirmed write", () => offline(async () => {
  for (const bad of [
    { ...audit, tenantId: "" },
    { ...audit, taskId: "" },
    { ...audit, eventId: "" },
    { ...audit, at: "not-a-date" },
  ]) {
    const { p, calls } = scripted([]);
    await assert.rejects(p.audit.append(bad), /invalid scoped audit/);
    assert.equal(calls.length, 0);
  }
  const { p } = scripted([ok({ taskId: TASK, auditId: "" })]);
  await assert.rejects(p.audit.append(audit), /audit not committed/);
}));

test("ARN-92 terminal acknowledgment must match the exact state and fence", () => offline(async () => {
  for (const reply of [ok({ state: "complete", fence: 2 }), ok({ state: "failed", fence: 1 }), ok({ state: "complete" })]) {
    const { p } = scripted([reply]);
    await assert.rejects(p.ledger.recordOutcome({ tenantId: T, eventId: E, outcome: { state: "complete", fence: 1 } }), /terminal outcome not committed/);
  }
}));
