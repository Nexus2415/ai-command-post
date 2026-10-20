// ARN-94: existing source seams + pinned canonical SQL, never a live service.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createAuthenticatedIntake, type IntakeCommand, type IntakeEvent } from "../src/authenticated-intake.ts";
import { BROKER_SIGNATURES, MANAGER_EVENT_SIGNATURE, createManagerEventBrokerAdapter, type ManagerBrokerFunction, type RpcArgs } from "../src/broker-adapter.ts";
import { createManagerPersistencePorts, type ManagerPersistenceOperation } from "../src/manager-persistence.ts";
import { Manager, type Job, type Ports, type WorkerResult } from "../src/manager.ts";

const enabled = process.env["ARN94_DISPOSABLE"] === "1";
const bin = process.env["ARN94_PGBIN"] ?? "/usr/lib/postgresql/16/bin";
const bundle = resolve("test/fixtures/arn94-opsdesk.tar.gz");
const manifest = JSON.parse(readFileSync("test/fixtures/arn94-opsdesk.json", "utf8")) as {
  repository: string; commit: string; archiveSha256: string; files: Record<string, string>;
};
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function assertIsolatedConnectionEnvironment() {
  for (const k of [...Object.keys(process.env).filter(k => k.startsWith("PG")), "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    assert.ok(!process.env[k], `refusing external connection variable ${k}`);
  }
}
// Run the same preflight before test-runner hooks in the refusal probe, so
// every supported Node reporter preserves the actual guard's diagnostic.
if (process.env["ARN94_GUARD_CHILD"] === "1") assertIsolatedConnectionEnvironment();
test("ARN-94 SQL fixture is pinned to the independently accepted source", () => {
  assert.equal(manifest.repository, "Nexus2415/opsdesk-harmony");
  assert.equal(manifest.commit, "df274ef994c807dff375fb05020d68d3fe692a7f");
  assert.equal(hash(readFileSync(bundle)), manifest.archiveSha256);
});
test("disposable harness refuses inherited libpq hostaddr before starting a server", { skip: process.env["ARN94_GUARD_CHILD"] === "1" }, () => {
  // A fresh Node test runner must not inherit its parent's internal worker mode.
  const guardEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
  assert.throws(() => execFileSync(process.execPath, ["test/synthetic-workflow.test.ts"], {
    env: { ...guardEnv, ARN94_DISPOSABLE: "1", ARN94_GUARD_CHILD: "1", ARN94_PGBIN: "/nonexistent/arn94-server",
      PGHOSTADDR: "192.0.2.1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  }), (e: unknown) => e instanceof Error && ["stdout", "stderr"].some(k =>
    k in e && String((e as Error & Record<string, unknown>)[k]).includes("refusing external connection variable PGHOSTADDR")));
});

let dir = "", source = "";
let pgEnv: NodeJS.ProcessEnv = {};
function pg(sql: string, vars: Record<string, string> = {}, db = "arn94"): Promise<string> {
  assert.ok(dir && pgEnv["PGHOST"] === dir && ["arn94", "postgres"].includes(db));
  return new Promise((done, fail) => {
    const p = spawn(join(bin, "psql"), ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", db,
      ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])], { env: pgEnv, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; }); p.stderr.on("data", c => { err += c; });
    p.on("error", fail); p.on("close", code => code === 0 ? done(out.trim()) : fail(new Error(`disposable psql: ${err.trim()}`)));
    p.stdin.end(sql);
  });
}
type Role = "broker_intake" | "broker_caller" | "broker_gateway" | "manager_verifier";
async function rpc(fn: string, args: Record<string, readonly [unknown, string]>, tenant: string, role: Role = "broker_caller", verifier = "chatgpt") {
  assert.ok(["broker_record_command", "broker_claim_manager_event", ...Object.keys(BROKER_SIGNATURES),
    "broker_mark_forwarded", "broker_capture_usage", "manager_record_receipt", "manager_resolve_receipt",
    "manager_record_terminal", "manager_append_audit", "manager_record_verification"].includes(fn));
  const claims = role === "manager_verifier" ? { executor: "verifier", role, verifier, tenant_ids: [tenant] } : { executor: "acp", tenant_ids: [tenant] };
  const vars: Record<string, string> = { claims: JSON.stringify(claims) };
  const params = Object.entries(args).map(([name, [value, type]], i) => {
    assert.ok(/^[a-z_]+$/.test(name) && ["uuid", "text", "integer", "bigint", "numeric", "jsonb"].includes(type));
    vars[`a${i}`] = type === "jsonb" ? JSON.stringify(value) : String(value);
    return `${name} => :'a${i}'::${type}`;
  }).join(",");
  return JSON.parse(await pg(`\\o /dev/null\nSELECT set_config('request.jwt.claims', :'claims', false);\nSET ROLE ${role};\n\\o\nSELECT public.${fn}(${params})::text;`, vars)) as Record<string, unknown>;
}

describe("ARN-94 native synthetic workflow", { skip: !enabled }, () => {
  before(async () => {
    assert.notEqual(userInfo().uid, 0, "run the disposable harness as an unprivileged user");
    assertIsolatedConnectionEnvironment();
    assert.ok(existsSync(join(bin, "postgres")), "PostgreSQL 16 server binaries required");
    assert.match(execFileSync(join(bin, "postgres"), ["--version"], { encoding: "utf8" }), /PostgreSQL\) 16\./);
    dir = mkdtempSync(join(tmpdir(), "arn94-pg-")); source = join(dir, "source"); mkdirSync(source);
    const names = execFileSync("tar", ["-tzf", bundle], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(names.sort(), Object.keys(manifest.files).sort());
    assert.ok(names.every(n => !n.startsWith("/") && !n.split("/").includes("..")));
    execFileSync("tar", ["-xzf", bundle, "-C", source]);
    for (const [name, digest] of Object.entries(manifest.files)) assert.equal(hash(readFileSync(join(source, name))), digest, name);
    const data = join(dir, "data");
    execFileSync(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"], { stdio: "ignore" });
    execFileSync(join(bin, "pg_ctl"), ["-D", data, "-l", join(dir, "postgres.log"), "-o", `-c listen_addresses='' -c unix_socket_directories=${dir}`, "-w", "start"], { stdio: "ignore" });
    pgEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PG"))), PGHOST: dir, PGPORT: "5432", PGUSER: "postgres" };
    await pg("CREATE DATABASE arn94;", {}, "postgres");
    const file = async (name: string) => { await pg(`\\i ${join(source, name)}`); };
    await file("tests/sql/supabase-stub.sql");
    const journal = JSON.parse(readFileSync(join(source, "drizzle/migrations/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      if (tag === "0002_setup_checklist_policies") await file("tests/sql/stub-before-0002.sql");
      if (tag === "0017_harden_shadow_readiness_view") await file("tests/sql/stub-before-0017.sql");
      await file(`drizzle/migrations/${tag}.sql`);
    }
    await file("tests/sql/arn-88-fixtures.sql");
  });
  after(() => {
    if (!dir) return;
    try { execFileSync(join(bin, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"], { stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true }); dir = "";
  });

  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  async function world(name: string) {
    const w = JSON.parse(await pg(`\\o /dev/null
SELECT arn88_test.mk_tenant(:'name') AS t \\gset
SELECT arn88_test.mk_tariff(:'name',0,0,0) AS tariff \\gset
SELECT arn88_test.mk_budgets(:'t'::uuid,0,0);
INSERT INTO public.authority_policies(tenant_id,capability,risk,live_enabled,requires_secondary_validation)
 VALUES(:'t'::uuid,'email.reply','yellow',false,true);
INSERT INTO public.proposed_actions(tenant_id,action_type,capability,payload,risk,decision,mode,idempotency_key,status)
 VALUES(:'t'::uuid,'synthetic','email.reply','{}','yellow','needs_approval','shadow',:'name','proposed') RETURNING id AS action \\gset
INSERT INTO public.approvals(tenant_id,proposed_action_id,decision,proposal_version,payload_fingerprint,policy_version)
 SELECT tenant_id,id,'approved',proposal_version,payload_fingerprint,policy_version FROM public.proposed_actions WHERE id=:'action'::uuid RETURNING id AS approval \\gset
\\o
SELECT jsonb_build_object('tenant',:'t','tariff',:'tariff','action',:'action','approval',:'approval');`, { name })) as { tenant: string; tariff: string; action: string; approval: string };
    let runs = 0, unavailableVerifier = false, missingVerification = false, failWorker = false, kill = false;
    const bindings = new Map<string, { commandId: string; eventId: string }>();
    const now = () => Math.floor(Date.now() / 1000);
    const trust = { issuer: "https://oidc.vercel.com/synthetic", audience: "https://vercel.com/synthetic", subject: "owner:synthetic:project:acp:environment:preview", ownerId: "team_synthetic", projectId: "prj_synthetic", environment: "preview", tenantIds: [w.tenant] };
    const expiry = Date.parse("2030-01-01T00:00:00Z") / 1000;
    const intake = createAuthenticatedIntake({ mode: "synthetic", trust, now, kill: () => kill ? "on" : "off", key: async k => k === "test-key" ? keys.publicKey : null,
      approval: async e => ({ tenantId: w.tenant, taskId: e.taskId, intent: "review_result", actionRef: w.action, approvalRef: w.approval, expiresAt: expiry, approved: true, mode: "shadow", maxBudgetMicros: 0, authorizationBasis: "owner_intake_grant" }),
      async record(c: IntakeCommand) {
        const r = await rpc("broker_record_command", { p_tenant: [w.tenant, "uuid"], p_command_key: [c.claimKey, "text"], p_source_ref: [c.event.eventId, "text"], p_title: [`Synthetic ${c.event.eventId}`, "text"], p_proposed_action: [w.action, "uuid"], p_hard_max_input: [0, "integer"], p_hard_max_cached: [0, "integer"], p_hard_max_output: [1, "integer"] }, w.tenant, "broker_intake");
        assert.equal(r["ok"], true); assert.equal(typeof r["command_id"], "string");
        bindings.set(c.claimKey, { commandId: String(r["command_id"]), eventId: c.event.eventId });
        return { ok: true, committed: true, created: r["created"], commandId: r["command_id"], tenantId: w.tenant, eventId: c.event.eventId, taskId: c.event.taskId, seq: c.event.seq, claimKey: c.claimKey, idempotencyKey: c.idempotencyKey, actionRef: w.action, approvalRef: w.approval,
          // Pinned ARN-94 bundle predates opsdesk 0035, so this bridge supplies the binding the 0035 RPC returns.
          subject: c.scope.subject, grantId: "00000000-0000-4000-8000-000000000122", validUntil: c.validUntil };
      } });
    const token = (over: object = {}) => {
      const n = now(); const p = [ { alg: "RS256", typ: "JWT", kid: "test-key" }, { iss: trust.issuer, aud: trust.audience, sub: trust.subject, owner_id: trust.ownerId, project_id: trust.projectId, environment: "preview", iat: n, nbf: n, exp: n + 600, ...over } ].map(x => Buffer.from(JSON.stringify(x)).toString("base64url")).join(".");
      return `${p}.${sign("RSA-SHA256", Buffer.from(p), keys.privateKey).toString("base64url")}`;
    };
    const event = (id: string, task = id): IntakeEvent => ({ tenantId: w.tenant, eventId: id, taskId: task, seq: 1, occurredAt: new Date().toISOString() });
    const managerEvent = (e: IntakeEvent) => ({ ...e, kind: "task_completed", source: "internal" });
    async function verification(job: Job, decision = "complete", who = "chatgpt") {
      return rpc("manager_record_verification", { p_data: [{ tenantId: w.tenant, eventId: job.eventId, fence: job.fence, decision, evidenceRef: `synthetic-proof-${job.eventId}` }, "jsonb"] }, w.tenant, "manager_verifier", who);
    }
    const make = () => {
      const broker = createManagerEventBrokerAdapter({
        async rpc(fn: ManagerBrokerFunction, args: RpcArgs) {
          const sig = fn === "broker_claim_manager_event" ? MANAGER_EVENT_SIGNATURE : BROKER_SIGNATURES[fn];
          return rpc(fn, Object.fromEntries(sig.map(([k, t]) => [k, [args[k], t]])), w.tenant);
        },
        binding: async req => {
          const b = bindings.get(req.claimKey); if (!b) return null;
          return { tenantRef: w.tenant, commandKey: req.claimKey, actionRef: b.commandId, tariffRef: w.tariff, maxInputTokens: 0, maxCachedInputTokens: 0, maxOutputTokens: 1, idempotencyKey: `${w.tenant}:${b.eventId}` };
        },
        usageEvidence: async a => pg("SELECT raw_usage_hash FROM public.execution_usage WHERE attempt_id=:'a'::uuid;", { a }),
      });
      const persistence = createManagerPersistencePorts(async (op: ManagerPersistenceOperation, data) => rpc(op, { p_data: [data, "jsonb"] }, w.tenant));
      const ports: Ports = { ...persistence, broker, killSwitch: () => kill ? "on" : "off", now: () => new Date(),
        executors: [{ key: "claude", configured: true, suspended: false, costTier: "free", worstCaseMicros: 0 }],
        authority: { grants: [{ intent: "review_result", maxTier: "green", expiresAt: "2030-01-01T00:00:00Z", maxBudgetMicros: 0 }], paidExecutionApproved: false },
        worker: { async run(job) {
          runs++; if (failWorker) throw new Error("synthetic worker outcome unknown");
          const f = await rpc("broker_mark_forwarded", { p_attempt: [job.attemptId, "uuid"] }, w.tenant, "broker_gateway"); assert.equal(f["forward"], true);
          const u = await rpc("broker_capture_usage", { p_attempt: [job.attemptId, "uuid"], p_provider_request_id: [`synthetic-${job.eventId}`, "text"], p_input: [0, "bigint"], p_cached: [0, "bigint"], p_output: [0, "bigint"], p_raw_hash: [hash(job.eventId), "text"] }, w.tenant, "broker_gateway"); assert.equal(u["ok"], true);
          return { summary: "synthetic checked result", actualMicros: 0 };
        } },
        verifier: { async verify(job, result: WorkerResult) {
          if (unavailableVerifier) throw new Error("independent verifier unavailable");
          assert.equal(result.summary, "synthetic checked result"); assert.equal(result.actualMicros, 0);
          if (!missingVerification) assert.equal((await verification(job))["verified"], true);
          return { ok: true, checkedBy: "chatgpt", ref: `synthetic-proof-${job.eventId}` };
        } },
      };
      return { manager: new Manager(ports), ports };
    };
    const receive = async (m: Manager, e: IntakeEvent) => {
      const r = await intake(token(), e); assert.equal(r.status, "recorded"); return m.handleEvent(managerEvent(e));
    };
    return { ...w, token, intake, event, managerEvent, make, receive, verification, runs: () => runs,
      set: (v: { verifierDown?: boolean; missingProof?: boolean; workerThrows?: boolean; killed?: boolean }) => {
        if (v.verifierDown !== undefined) unavailableVerifier = v.verifierDown;
        if (v.missingProof !== undefined) missingVerification = v.missingProof;
        if (v.workerThrows !== undefined) failWorker = v.workerThrows;
        if (v.killed !== undefined) kill = v.killed;
      } };
  }

  test("signed intake -> durable receipt -> native claim -> mock worker -> distinct verifier -> $0 terminal -> next eligible", async () => {
    const w = await world("arn94-happy"), { manager: m } = w.make(), e = w.event("happy");
    const d = await w.receive(m, e); assert.equal(d.status, "ADMITTED", d.reason); assert.ok(d.job);
    const end = await m.dispatch(d.job.jobId); assert.equal(end.job?.state, "complete", end.reason);
    assert.equal(w.runs(), 1);
    assert.equal(await pg("SELECT count(*) FROM public.manager_verifications WHERE tenant_id=:'t'::uuid AND verifier='chatgpt';", { t: w.tenant }), "1");
    assert.equal(await pg("SELECT outcome->>'state' FROM public.manager_event_receipts WHERE tenant_id=:'t'::uuid AND event_id='happy';", { t: w.tenant }), "complete");
    const next = await w.receive(m, w.event("next")); assert.equal(next.status, "ADMITTED", next.reason);
    assert.equal(m.nextEligible()?.eventId, "next");
    assert.equal(await pg("SELECT sum(reserved_micros+settled_micros) FROM public.execution_budgets;"), "0");
  });
  test("eight concurrent deliveries reserve once; concurrent dispatch runs one worker", async () => {
    const w = await world("arn94-race"), e = w.event("race");
    const delivered = await Promise.all(Array.from({ length: 8 }, () => w.intake(w.token(), e)));
    assert.ok(delivered.every(d => d.status === "recorded"));
    const managers = Array.from({ length: 8 }, () => w.make().manager);
    await Promise.all(managers.map(m => m.handleEvent(w.managerEvent(e))));
    assert.equal(await pg("SELECT count(*) FROM public.execution_claims WHERE tenant_id=:'t'::uuid;", { t: w.tenant }), "1");
    assert.equal(await pg("SELECT count(*) FROM public.broker_manager_event_lineage WHERE tenant_id=:'t'::uuid;", { t: w.tenant }), "1");
    const fresh = Array.from({ length: 8 }, () => w.make().manager);
    const jobs = await Promise.all(fresh.map(m => m.handleEvent(w.managerEvent(e))));
    assert.ok(jobs.every(d => d.job));
    await Promise.all(fresh.map((m, i) => m.dispatch(jobs[i]!.job!.jobId)));
    assert.equal(w.runs(), 1);
  });
  test("actual database restart preserves terminal evidence without repeating work", async () => {
    const w = await world("arn94-reboot"), { manager: m } = w.make(), e = w.event("reboot");
    const d = await w.receive(m, e); assert.ok(d.job); assert.equal((await m.dispatch(d.job.jobId)).job?.state, "complete");
    execFileSync(join(bin, "pg_ctl"), ["-D", join(dir, "data"), "-m", "fast", "-w", "restart"], { stdio: "ignore" });
    const m2 = w.make().manager, recovered = await m2.handleEvent(w.managerEvent(e));
    assert.equal(recovered.status, "DUPLICATE", recovered.reason); assert.equal(recovered.job?.state, "complete");
    assert.equal((await m2.dispatch(recovered.job!.jobId)).status, "REJECTED"); assert.equal(w.runs(), 1);
  });
  test("verifier outage remains unknown after manager restart; independent reconciliation completes audited evidence", async () => {
    const w = await world("arn94-unknown"), { manager: m } = w.make(), e = w.event("unknown");
    w.set({ verifierDown: true }); const d = await w.receive(m, e); assert.ok(d.job);
    assert.equal((await m.dispatch(d.job.jobId)).job?.state, "unknown");
    const m2 = w.make().manager, r = await m2.handleEvent(w.managerEvent(e)); assert.equal(r.job?.state, "unknown");
    assert.equal(m2.nextEligible(), null); assert.equal(w.runs(), 1);
    assert.equal((await m2.reconcile(r.job!.jobId, { checkedBy: "claude", outcome: "completed", ref: "self" })).status, "REJECTED");
    assert.equal((await w.verification(r.job!))["verified"], true);
    const end = await m2.reconcile(r.job!.jobId, { checkedBy: "chatgpt", outcome: "completed", ref: `synthetic-proof-${e.eventId}` });
    assert.equal(end.job?.state, "complete", end.reason); assert.equal(w.runs(), 1);
  });
  test("crash after broker dispatch recovers unknown without executing or automatically retrying", async () => {
    const w = await world("arn94-crash"), first = w.make(), e = w.event("crash");
    const d = await w.receive(first.manager, e); assert.ok(d.job);
    assert.equal((await first.ports.broker.markDispatched(d.job.attemptId!, d.job.fence!)).ok, true);
    // Simulate loss of all Manager memory after dispatch authority was committed.
    const second = w.make(), r = await second.manager.handleEvent(w.managerEvent(e));
    assert.equal(r.job?.state, "unknown"); assert.equal(second.manager.nextEligible(), null);
    assert.equal((await second.manager.dispatch(r.job!.jobId)).status, "REJECTED");
    assert.equal((await second.manager.retry(r.job!.jobId)).status, "REJECTED"); assert.equal(w.runs(), 0);
  });
  test("forged identity, wrong tenant, red intent, kill and missing verification cannot complete", async () => {
    const w = await world("arn94-negative"), { manager: m } = w.make(), e = w.event("negative");
    assert.equal((await w.intake(w.token({ role: "broker_caller" }), e)).status, "blocked");
    assert.equal((await w.intake(w.token(), { ...e, tenantId: "11111111-1111-4111-8111-111111111111" })).status, "blocked");
    assert.equal((await m.handleEvent({ ...w.managerEvent(e), kind: "deploy_request" })).status, "OWNER_APPROVAL_REQUIRED");
    w.set({ killed: true }); assert.equal((await w.intake(w.token(), e)).status, "blocked"); assert.equal(w.runs(), 0);
    w.set({ killed: false, missingProof: true }); const d = await w.receive(m, e); assert.ok(d.job);
    assert.equal((await rpc("broker_claim_status", { p_claim: [d.job.claimId!, "uuid"] }, "11111111-1111-4111-8111-111111111111"))["ok"], false);
    await assert.rejects(w.verification(d.job, "complete", "claude"), /manager_denied:self_or_unknown_verification/);
    const end = await m.dispatch(d.job.jobId); assert.equal(end.job?.state, "unknown");
    assert.equal(await pg("SELECT outcome IS NULL FROM public.manager_event_receipts WHERE tenant_id=:'t'::uuid AND event_id=:'e';", { t: w.tenant, e: e.eventId }), "t");
    await assert.rejects(rpc("manager_record_verification", { p_data: [{ tenantId: w.tenant, eventId: e.eventId, fence: d.job.fence, decision: "complete", evidenceRef: "fake" }, "jsonb"] }, w.tenant), /permission denied/);
  });
  test("kill switch at every manager boundary stops all subsequent forward work", async () => {
    for (const boundary of ["ingest", "route", "ledger", "audit", "claim", "dispatch", "worker_start", "verify", "settle"]) {
      const w = await world(`arn94-kill-${boundary}`), { manager: m, ports } = w.make(), e = w.event(`kill-${boundary}`);
      let stopped = false, runsAtStop = 0;
      ports.killSwitch = () => {
        if (m.boundaries.at(-1) === boundary) { stopped = true; runsAtStop = w.runs(); }
        return stopped ? "on" : "off";
      };
      const d = await w.receive(m, e);
      const end = d.job ? await m.dispatch(d.job.jobId) : d;
      assert.ok(stopped, boundary); assert.notEqual(end.job?.state, "complete", boundary);
      assert.equal(w.runs(), runsAtStop, boundary);
      assert.equal(await pg("SELECT count(*) FROM public.manager_event_receipts WHERE tenant_id=:'t'::uuid AND outcome IS NOT NULL;", { t: w.tenant }), "0", boundary);
    }
  });
  test("expired grants, stale fences, replay substitution and later reclaim cannot dispatch", async () => {
    const w = await world("arn94-fences"), { manager: m, ports } = w.make(), e = w.event("fences");
    const d = await w.receive(m, e); assert.ok(d.job);
    assert.equal((await ports.broker.markDispatched(d.job.attemptId!, d.job.fence! + 1)).ok, false);
    assert.equal((await m.handleEvent(w.managerEvent({ ...e, taskId: "substituted" }))).status, "BLOCKED");
    assert.equal((await ports.broker.release(d.job.attemptId!, d.job.fence!)).ok, true);
    assert.equal((await ports.broker.takeover(d.job.claimId!, d.job.fence!, 0)).ok, false);
    const commandId = await pg("SELECT action_ref FROM public.execution_claims WHERE id=:'c'::uuid;", { c: d.job.claimId! });
    const args: Record<string, readonly [unknown, string]> = { p_tenant: [w.tenant, "uuid"], p_command_key: [d.job.claimKey, "text"], p_action_ref: [commandId, "uuid"], p_tariff_ref: [w.tariff, "uuid"], p_max_input: [0, "integer"], p_max_cached: [0, "integer"], p_max_output: [1, "integer"] };
    const later = await rpc("broker_claim_and_reserve", args, w.tenant); assert.equal(later["ok"], true); assert.equal(later["fence"], 2);
    await assert.rejects(rpc("broker_claim_manager_event", { ...args, p_event: [e.eventId, "text"] }, w.tenant), /manager_denied:unrecorded_manager_event/);
    assert.equal((await w.make().manager.handleEvent(w.managerEvent(e))).status, "BLOCKED");
    const expired = await world("arn94-expired"), fresh = expired.make();
    fresh.ports.authority.grants[0]!.expiresAt = "2000-01-01T00:00:00Z";
    assert.equal((await expired.receive(fresh.manager, expired.event("expired"))).reason, "permission_expired");
    assert.equal(expired.runs(), 0); assert.equal(w.runs(), 0);
  });
  test("worker failure is unknown and never automatically retried", async () => {
    const w = await world("arn94-worker"), { manager: m } = w.make(); w.set({ workerThrows: true });
    const d = await w.receive(m, w.event("worker-failure")); assert.ok(d.job);
    assert.equal((await m.dispatch(d.job.jobId)).job?.state, "unknown");
    assert.equal((await m.retry(d.job.jobId)).status, "REJECTED"); assert.equal(w.runs(), 1);
  });
});
