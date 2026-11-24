import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createAuthenticatedIntake, type IntakeCommand, type IntakeDeps } from "../src/authenticated-intake.ts";
import { intakeApprovalFromRpc, intakeReceiptFromRpc } from "../src/intake-rpc.ts";

// Source-shaped fixtures copied from opsdesk 0035 (broker_int_intake_receipt, broker_read_intake_grant).
// No database, RPC, credentials or network.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const NOW = 2_000_000_000, T = "11111111-1111-4111-8111-111111111111";
const ACTION = "22222222-2222-4222-8222-222222222222", APPROVAL = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444", GRANT = "55555555-5555-4555-8555-555555555555";
const trust = { issuer: "https://oidc.vercel.com/synthetic", audience: "https://vercel.com/synthetic",
  subject: "owner:synthetic:project:acp:environment:preview", ownerId: "team_synthetic", projectId: "prj_synthetic", environment: "preview", tenantIds: [T] };
const event = { tenantId: T, eventId: "evt-a", taskId: "task-a", seq: 1, occurredAt: new Date(NOW * 1000).toISOString() };
function token() {
  const p = [{ alg: "RS256", typ: "JWT", kid: "k" }, { iss: trust.issuer, aud: trust.audience, sub: trust.subject,
    owner_id: trust.ownerId, project_id: trust.projectId, environment: trust.environment, iat: NOW - 60, nbf: NOW - 60, exp: NOW + 600 }]
    .map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
  return `${p}.${sign("RSA-SHA256", Buffer.from(p), pair.privateKey).toString("base64url")}`;
}
// jsonb_build_object('ok', true, 'approval', jsonb_build_object(...)) from broker_read_intake_grant.
const grantRpc = () => ({ ok: true, approval: { tenantId: T, taskId: "task-a", intent: "review_result", actionRef: ACTION,
  approvalRef: APPROVAL, expiresAt: NOW + 300, approved: true, mode: "shadow", maxBudgetMicros: 0, authorizationBasis: "owner_intake_grant" } });
// broker_int_intake_receipt(r, p_created) for the row the command would write.
const receiptRpc = (c: IntakeCommand, created = true) => ({
  ok: true, created,
  receipt: { ok: true, committed: true, created, commandId: COMMAND, tenantId: c.event.tenantId, eventId: c.event.eventId,
    taskId: c.event.taskId, seq: c.event.seq, claimKey: c.claimKey, idempotencyKey: c.idempotencyKey,
    actionRef: c.approval.actionRef, approvalRef: c.approval.approvalRef },
  subject: c.scope.subject, grantId: GRANT, validUntil: c.validUntil });
function intake(record: (c: IntakeCommand) => unknown, approval: () => unknown = () => intakeApprovalFromRpc(grantRpc())) {
  const deps: IntakeDeps = { mode: "synthetic", trust, now: () => NOW, kill: () => "off",
    key: async kid => kid === "k" ? pair.publicKey : null,
    approval: async () => approval() as never, record: async c => record(c) };
  return createAuthenticatedIntake(deps)(token(), event);
}

test("ARN-45: the 0035 RPC results, unwrapped, record an intake; created and replayed receipts both map", async () => {
  const a = await intake(c => intakeReceiptFromRpc(receiptRpc(c)));
  assert.equal(a.status, "recorded");
  if (a.status !== "recorded") return;
  assert.deepEqual(Object.keys(a.receipt).sort(), ["actionRef", "approvalRef", "claimKey", "commandId", "committed", "created",
    "eventId", "grantId", "idempotencyKey", "ok", "seq", "subject", "taskId", "tenantId", "validUntil"]);
  assert.equal(a.receipt.created, true); assert.equal(a.receipt.grantId, GRANT); assert.equal(a.receipt.subject, trust.subject);
  const replay = await intake(c => intakeReceiptFromRpc(receiptRpc(c, false)));
  assert.equal(replay.status, "recorded");
  if (replay.status === "recorded") assert.equal(replay.receipt.created, false);
});

test("ARN-45: wiring the raw RPC results straight into IntakeDeps fails closed", async () => {
  const raw = await intake(c => receiptRpc(c));
  assert.equal(raw.status === "blocked" && raw.reason, "unconfirmed_record");
  const nested = await intake(c => receiptRpc(c).receipt);
  assert.equal(nested.status === "blocked" && nested.reason, "unconfirmed_record");
  const rawGrant = await intake(c => intakeReceiptFromRpc(receiptRpc(c)), () => grantRpc());
  assert.equal(rawGrant.status === "blocked" && rawGrant.reason, "approval_required");
});

test("ARN-45: a refused, missing or malformed receipt result never confirms intake", async () => {
  const shapes: [string, (c: IntakeCommand) => unknown][] = [
    ["refusal", () => ({ ok: false, reason: "no_grant" })],
    ["null", () => null], ["array", c => [receiptRpc(c)]], ["string", () => "ok"],
    ["outer ok false", c => ({ ...receiptRpc(c), ok: false })],
    ["outer ok string", c => ({ ...receiptRpc(c), ok: "true" })],
    ["created not boolean", c => ({ ...receiptRpc(c), created: "true" })],
    ["missing subject", c => { const { subject: _, ...v } = receiptRpc(c); return v; }],
    ["missing grantId", c => { const { grantId: _, ...v } = receiptRpc(c); return v; }],
    ["missing validUntil", c => { const { validUntil: _, ...v } = receiptRpc(c); return v; }],
    ["extra outer key", c => ({ ...receiptRpc(c), reason: "x" })],
    ["receipt null", c => ({ ...receiptRpc(c), receipt: null })],
    ["receipt array", c => ({ ...receiptRpc(c), receipt: [receiptRpc(c).receipt] })],
    ["nested ok false", c => { const v = receiptRpc(c); return { ...v, receipt: { ...v.receipt, ok: false } }; }],
    ["nested not committed", c => { const v = receiptRpc(c); return { ...v, receipt: { ...v.receipt, committed: false } }; }],
    ["nested missing key", c => { const v = receiptRpc(c); const { approvalRef: _, ...r } = v.receipt; return { ...v, receipt: r }; }],
    ["nested extra key", c => { const v = receiptRpc(c); return { ...v, receipt: { ...v.receipt, subject: trust.subject } }; }],
    ["created flags disagree", c => { const v = receiptRpc(c); return { ...v, receipt: { ...v.receipt, created: false } }; }],
  ];
  for (const [name, shape] of shapes) {
    let mapped: unknown = "unset";
    const r = await intake(c => (mapped = intakeReceiptFromRpc(shape(c))));
    assert.equal(mapped, null, `${name}: mapper returns null`);
    assert.equal(r.status === "blocked" && r.reason, "unconfirmed_record", name);
  }
  // Well-formed but bound to something else: the mapper passes it through and the intake's own check refuses it.
  const bindings: [string, (c: IntakeCommand) => unknown][] = [
    ["other subject", c => ({ ...receiptRpc(c), subject: "someone-else" })],
    ["later deadline", c => ({ ...receiptRpc(c), validUntil: c.validUntil + 1 })],
    ["bad grant id", c => ({ ...receiptRpc(c), grantId: "not-a-uuid" })],
    ["other event", c => { const v = receiptRpc(c); return { ...v, receipt: { ...v.receipt, eventId: "evt-z" } }; }],
  ];
  for (const [name, shape] of bindings) {
    const r = await intake(c => intakeReceiptFromRpc(shape(c)));
    assert.equal(r.status === "blocked" && r.reason, "unconfirmed_record", name);
  }
});

test("ARN-45: a refused, missing or malformed grant result never authorizes intake", async () => {
  const g = grantRpc();
  const { mode: _m, ...missingMode } = g.approval;
  const shapes: [string, unknown][] = [
    ["refusal", { ok: false, reason: "no_grant" }], ["null", null], ["array", [g]],
    ["outer ok false", { ...g, ok: false }], ["extra outer key", { ...g, reason: "x" }],
    ["approval null", { ok: true, approval: null }], ["approval missing key", { ok: true, approval: missingMode }],
    ["approval extra key", { ok: true, approval: { ...g.approval, subject: trust.subject } }],
  ];
  let recorded = 0;
  for (const [name, raw] of shapes) {
    assert.equal(intakeApprovalFromRpc(raw), null, `${name}: mapper returns null`);
    const r = await intake(c => (recorded++, intakeReceiptFromRpc(receiptRpc(c))), () => intakeApprovalFromRpc(raw));
    assert.equal(r.status === "blocked" && r.reason, "approval_required", name);
  }
  assert.equal(recorded, 0, "no record call without a grant");
  const paid = await intake(c => intakeReceiptFromRpc(receiptRpc(c)), () => intakeApprovalFromRpc({ ok: true, approval: { ...g.approval, maxBudgetMicros: 1 } }));
  assert.equal(paid.status === "blocked" && paid.reason, "approval_required", "values are still checked by the intake");
});
