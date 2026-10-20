import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createAuthenticatedIntake, type IntakeApproval, type IntakeCommand, type IntakeDeps, type IntakeReceipt } from "../src/authenticated-intake.ts";

// Real cryptography over synthetic claims; no Vercel token, network or provider.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const NOW = 2_000_000_000, T = "11111111-1111-4111-8111-111111111111";
const trust = { issuer: "https://oidc.vercel.com/synthetic", audience: "https://vercel.com/synthetic",
  subject: "owner:synthetic:project:acp:environment:preview", ownerId: "team_synthetic", projectId: "prj_synthetic", environment: "preview", tenantIds: [T] };
const claims = { iss: trust.issuer, aud: trust.audience, sub: trust.subject,
  owner_id: trust.ownerId, project_id: trust.projectId, environment: trust.environment,
  iat: NOW - 60, nbf: NOW - 60, exp: NOW + 600 };
const event = { tenantId: T, eventId: "evt-a", taskId: "task-a", seq: 1, occurredAt: new Date(NOW * 1000).toISOString() };
function token(over: object = {}, header: object = {}) {
  const p = [ { alg: "RS256", typ: "JWT", kid: "synthetic-key", ...header }, { ...claims, ...over } ]
    .map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
  return `${p}.${sign("RSA-SHA256", Buffer.from(p), pair.privateKey).toString("base64url")}`;
}
function rig() {
  let clock = NOW, kill: "off" | "on" | "error" = "off";
  const writes: IntakeCommand[] = [], rows = new Map<string, { command: IntakeCommand; receipt: IntakeReceipt }>();
  const approval: IntakeApproval = { tenantId: T, taskId: "task-a", intent: "review_result",
    actionRef: "22222222-2222-4222-8222-222222222222", approvalRef: "33333333-3333-4333-8333-333333333333",
    expiresAt: NOW + 300, approved: true, mode: "shadow", maxBudgetMicros: 0, authorizationBasis: "owner_intake_grant" };
  const deps: IntakeDeps = {
    mode: "synthetic", trust, now: () => clock, kill: () => kill,
    key: async kid => kid === "synthetic-key" ? pair.publicKey : null,
    approval: async () => approval,
    async record(c) {
      // Fixture stands in for an atomic durable store; never a production cache.
      if (clock >= c.validUntil || kill !== "off") throw new Error("expired or killed");
      const prior = rows.get(c.idempotencyKey);
      if (prior) {
        if (JSON.stringify(prior.command) !== JSON.stringify(c)) throw new Error("immutable replay conflict");
        return { ...prior.receipt, created: false };
      }
      writes.push(c);
      const r: IntakeReceipt = { ok: true, committed: true, created: true,
        commandId: "44444444-4444-4444-8444-444444444444", tenantId: c.event.tenantId, eventId: c.event.eventId,
        taskId: c.event.taskId, seq: c.event.seq, claimKey: c.claimKey, idempotencyKey: c.idempotencyKey,
        actionRef: c.approval.actionRef, approvalRef: c.approval.approvalRef,
        subject: c.scope.subject, grantId: "55555555-5555-4555-8555-555555555555", validUntil: c.validUntil };
      rows.set(c.idempotencyKey, { command: structuredClone(c), receipt: r }); return r;
    },
  };
  return { deps, writes, approval, setClock: (n: number) => { clock = n; }, setKill: (v: typeof kill) => { kill = v; }, run: () => createAuthenticatedIntake(deps) };
}

test("valid signed workload records one approved scoped command; identity token reuse is allowed", async () => {
  const r = rig(), intake = r.run(), jwt = token();
  const a = await intake(jwt, event);
  assert.equal(a.status, "recorded"); assert.equal(a.sent, false);
  assert.equal(a.command.scope.role, "broker_intake");
  assert.equal(a.command.claimKey, `${T}:task-a:review_result`);
  assert.equal(a.command.validUntil, NOW + 300);
  assert.ok(!JSON.stringify(a).includes(jwt));
  assert.equal((await intake(jwt, event)).status, "recorded"); assert.equal(r.writes.length, 1);
  assert.equal((await intake(jwt, { ...event, eventId: "evt-b", seq: 2 })).status, "recorded");
  assert.equal(r.writes.length, 2, "same Vercel workload token is valid for a distinct event");
  assert.equal((await intake(jwt, { ...event, seq: 9 })).status, "blocked"); assert.equal(r.writes.length, 2);
});
test("disabled by default; no browser role or generic execution input", async () => {
  const disabled = await createAuthenticatedIntake()(token(), event);
  assert.equal(disabled.status, "blocked");
  assert.equal(disabled.reason, "disabled");
  const r = rig();
  for (const e of [null, {}, { ...event, kind: "deploy_request" }, { ...event, role: "broker_caller" }, { ...event, tenantId: "55555555-5555-4555-8555-555555555555" }]) {
    assert.equal((await r.run()(token(), e)).status, "blocked");
  }
  assert.equal(r.writes.length, 0);
});
test("rejects forged signature, unsigned JWT, algorithm/key injection and key outage before recording", async () => {
  const r = rig(), jwt = token();
  const forged = jwt.split("."); forged[1] = Buffer.from(JSON.stringify({ ...claims, exp: NOW + 700 })).toString("base64url");
  for (const t of [forged.join("."), jwt.slice(0, jwt.lastIndexOf(".") + 1) + "eA", token({}, { alg: "none" }), token({}, { alg: "HS256" }), token({}, { kid: "unknown" }), token({}, { jku: "https://attacker.invalid/keys" }), "x.y.z"]) {
    assert.equal((await r.run()(t, event)).status, "blocked");
  }
  r.deps.key = async () => { throw new Error("JWKS unavailable"); };
  assert.equal((await r.run()(jwt, event)).status, "blocked"); assert.equal(r.writes.length, 0);
});
test("verifies issuer, audience, subject, stable IDs and environment; app claims grant no authority", async () => {
  const r = rig();
  for (const over of [{ iss: "https://attacker.invalid" }, { aud: "other" }, { sub: "other" }, { project_id: "other" }, { owner_id: "other" }, { environment: "production" }, { role: "broker_caller" }, { executor: "eve" }, { tenant_ids: [T] }, { permissions: ["deploy"] }]) {
    assert.equal((await r.run()(token(over), event)).status, "blocked", JSON.stringify(over));
  }
  assert.equal(r.writes.length, 0);
});
test("invalid times, expired grants, paid/live policy, scope mismatch and kill fail closed", async () => {
  for (const over of [{ exp: NOW }, { exp: "later" }, { nbf: NOW + 1 }, { iat: NOW + 1 }, { exp: NOW + 10000 }, { exp: null }]) {
    const r = rig(); assert.equal((await r.run()(token(over), event)).status, "blocked"); assert.equal(r.writes.length, 0);
  }
  for (const over of [{ tenantId: "other" }, { taskId: "other" }, { approved: false }, { mode: "live" }, { maxBudgetMicros: 1 }, { authorizationBasis: "client_authorization" }, { authorizationBasis: "owner_internal_test" }, { expiresAt: NOW }]) {
    const r = rig(); Object.assign(r.approval, over);
    assert.equal((await r.run()(token(), event)).status, "blocked"); assert.equal(r.writes.length, 0);
  }
  for (const kill of ["on", "error"] as const) {
    const r = rig(); r.setKill(kill); assert.equal((await r.run()(token(), event)).status, "blocked"); assert.equal(r.writes.length, 0);
  }
  const r = rig(); r.deps.approval = async () => { r.setClock(NOW + 301); return r.approval; };
  assert.equal((await r.run()(token(), event)).status, "blocked"); assert.equal(r.writes.length, 0);
});
test("uncommitted, forged and unavailable store acknowledgments never confirm intake", async () => {
  for (const answer of [null, { ok: true }, { ok: true, committed: false }, { ok: true, tenantId: "other" }]) {
    const r = rig(); r.deps.record = async () => answer;
    assert.equal((await r.run()(token(), event)).status, "blocked");
  }
  const r = rig(); r.deps.record = async () => { throw new Error("store down"); };
  assert.equal((await r.run()(token(), event)).status, "blocked");
});
test("receipt must carry the verified subject, a grant and a deadline no later than the request's", async () => {
  const bad = [{ subject: "someone-else" }, { grantId: "not-a-uuid" }, { validUntil: NOW + 301 }, { validUntil: "later" }];
  for (const over of bad) {
    const r = rig(), real = r.deps.record;
    r.deps.record = async c => ({ ...(await real(c) as IntakeReceipt), ...over });
    const out = await r.run()(token(), event);
    assert.equal(out.status, "blocked", JSON.stringify(over)); assert.equal(out.reason, "unconfirmed_record");
  }
  const r = rig(), real = r.deps.record;
  r.deps.record = async c => { const { grantId, ...rest } = await real(c) as IntakeReceipt; void grantId; return rest; };
  const out = await r.run()(token(), event);
  assert.equal(out.status, "blocked"); assert.equal(out.reason, "unconfirmed_record", "a receipt without its grant is not confirmed");
});
test("a commit that lands after the deadline or under the kill switch is reported as such, then recovered by replay", async () => {
  for (const after of ["late", "kill"] as const) {
    const r = rig(), real = r.deps.record;
    r.deps.record = async c => {
      const out = await real(c) as IntakeReceipt;
      if (after === "late") r.setClock(out.validUntil); else r.setKill("on");
      return out;
    };
    const first = await r.run()(token(), event);
    assert.equal(first.status, "blocked"); assert.equal(first.reason, "committed_after_deadline");
    assert.equal(r.writes.length, 1, "the store did commit");
    r.deps.record = real; r.setClock(NOW); r.setKill("off");
    const again = await r.run()(token(), event);
    assert.equal(again.status, "recorded"); assert.equal(again.receipt.created, false); assert.equal(r.writes.length, 1);
  }
});
