// ARN-89: the disabled manager + adapter driven through the REAL ARN-88 broker SQL in a THROWAWAY local PostgreSQL.
//
// Opt-in: runs only when ACP_BROKER_PG_OPSDESK names a local opsdesk-harmony checkout (for its migrations, the
// Supabase stand-ins and the ARN-88 synthetic fixtures) and PostgreSQL server binaries, psql and jq are installed.
// It starts its own server in a temp directory on a private unix socket (no TCP), replays the opsdesk migrations
// into it, and destroys it afterwards. It refuses to run with any database or Supabase connection variable set.
// Synthetic tenants, commands and $0 tariffs only; no canonical database, credential, provider or network.
//
//   ACP_BROKER_PG_OPSDESK=../opsdesk-harmony node --test test/broker-postgres.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, chownSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { BROKER_SIGNATURES, createBrokerAdapter, type BrokerFunction, type CommandBinding, type RpcArgs } from "../src/broker-adapter.ts";
import { Manager, type AdmissionBroker, type AuditEntry, type Job, type LedgerEntry, type ManagerEvent, type Ports, type Verification, type WorkerResult } from "../src/manager.ts";

const OPSDESK = process.env["ACP_BROKER_PG_OPSDESK"] ? resolve(process.env["ACP_BROKER_PG_OPSDESK"]) : "";
const PGBIN = (() => {
  try {
    return readdirSync("/usr/lib/postgresql").sort((a, b) => Number(a) - Number(b)).map((v) => `/usr/lib/postgresql/${v}/bin`).filter((d) => existsSync(`${d}/initdb`)).at(-1) ?? "";
  } catch {
    return "";
  }
})();
const CONNECTION_VARS = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGSERVICE", "PGDATABASE", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const blocked = CONNECTION_VARS.filter((v) => process.env[v]);
const ready = OPSDESK !== "" && existsSync(join(OPSDESK, "drizzle/migrations/0030_execution_broker.sql")) && PGBIN !== ""
  && spawnSync("psql", ["--version"]).status === 0 && spawnSync("jq", ["--version"]).status === 0;
const skip = !ready ? "set ACP_BROKER_PG_OPSDESK to an opsdesk-harmony checkout and install PostgreSQL, psql and jq" : false;

const DB = "arn89_broker";
const NOW = new Date("2026-10-12T23:30:00Z");
let dir = "";
let env: NodeJS.ProcessEnv = {};
const root = userInfo().uid === 0;
const asPg = (cmd: string) => (root ? execFileSync("su", ["postgres", "-s", "/bin/bash", "-c", cmd]) : execFileSync("bash", ["-c", cmd]));

/** Runs a psql script against the throwaway server; resolves to its unaligned output. Never shells out the SQL. */
function psql(script: string, vars: Record<string, string> = {}): Promise<string> {
  return new Promise((done, fail) => {
    const args = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", DB, ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])];
    const p = spawn("psql", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? done(out.trim()) : fail(new Error(`psql ${code}: ${err.trim()}`))));
    p.stdin.end(script);
  });
}
const q = (sql: string) => psql(sql);

/**
 * The transport a real deployment would put behind the adapter, minus the network: one session per call, the role
 * `broker_caller`, and the verified-JWT claims the broker reads its executor and tenants from. Arguments travel as psql
 * variables with the SQL types from BROKER_SIGNATURES, by name, so a parameter the SQL does not declare fails the call.
 */
function pgRpc(tenants: string[], settings: Record<string, string> = {}) {
  return async (fn: BrokerFunction, args: RpcArgs): Promise<unknown> => {
    const sig = BROKER_SIGNATURES[fn];
    const vars: Record<string, string> = { claims: JSON.stringify({ executor: "acp", tenant_ids: tenants }) };
    for (const [name] of sig) vars[name] = String(args[name]);
    const extra = Object.keys(settings).map((k, i) => { vars[`s${i}`] = settings[k]!; return `SELECT set_config('${k.replace(/[^a-z0-9_.]/g, "")}', :'s${i}', false);`; }).join("\n");
    const call = sig.map(([name, type]) => `${name} => :'${name}'::${type}`).join(", ");
    const out = await psql(`\\o /dev/null\nSELECT set_config('request.jwt.claims', :'claims', false);\n${extra}\nSET ROLE broker_caller;\n\\o\nSELECT public.${fn}(${call})::text;\n`, vars);
    return JSON.parse(out);
  };
}

interface World { t: string; tf: string; cmd: string; key: string }
/**
 * A fresh synthetic tenant with $0 budgets, a tariff (all-zero unless priced) and one approved, recorded command whose
 * command key is the tenant-scoped part of the manager's claim key for event() below (`<tenant>:task-1:review_result`).
 */
async function world(o: { priced?: boolean; cap?: number } = {}): Promise<World> {
  const out = await psql(`
\\o /dev/null
SELECT arn88_test.reset_world();
\\o
WITH t AS (SELECT arn88_test.mk_tenant('acp89') AS id),
     tf AS (SELECT CASE WHEN :'priced' = 'yes' THEN arn88_test.mk_tariff('priced') ELSE arn88_test.mk_tariff('free', 0, 0, 0) END AS id),
     b AS (SELECT arn88_test.mk_budgets(t.id, :'cap'::bigint, :'cap'::bigint) FROM t)
SELECT json_build_object('t', t.id, 'tf', tf.id, 'cmd', arn88_test.mk_command(t.id, 'task-1:review_result') ->> 'command', 'key', 'task-1:review_result')::text FROM t, tf, b;`,
    { priced: o.priced ? "yes" : "no", cap: String(o.cap ?? 0) });
  return JSON.parse(out) as World;
}

/** Hash of every broker table and the broker's audit rows: a read-only step must leave it unchanged. */
const snapshot = () => q("SELECT arn88_test.snapshot();");
const invariants = (label: string) => q(`SELECT arn88_test.assert_invariants('${label.replace(/'/g, "")}');`);
const attemptStates = async () => (await q("SELECT coalesce(string_agg(state, ',' ORDER BY attempt_no), '') FROM public.execution_attempts;")).split(",").filter(Boolean);
const budgets = async () => q("SELECT string_agg(scope || ':' || reserved_micros || '/' || settled_micros, ',' ORDER BY scope) FROM public.execution_budgets;");
const brokerAudit = async () => (await q("SELECT coalesce(string_agg(action, ',' ORDER BY action), '') FROM public.audit_events WHERE policy_rule = 'execution_broker';")).split(",").filter(Boolean);
const setKill = (on: boolean) => q(`UPDATE public.system_flags SET bool_value = ${on} WHERE key = 'global_kill_switch';`);

interface Rig { m: Manager; ports: Ports; ledger: Map<string, LedgerEntry>; broker: AdmissionBroker; audit: AuditEntry[]; worker: { runs: number; mode: "ok" | "throw" }; verifier: { ok: boolean }; usage: Map<string, string> }
/** The ARN-86 manager over the adapter over real RPCs. The ledger and the manager's own audit sink stay in-memory fakes. */
function rig(w: World, o: { ledger?: Map<string, LedgerEntry>; settings?: Record<string, string> } = {}): Rig {
  const ledger = o.ledger ?? new Map<string, LedgerEntry>();
  const audit: AuditEntry[] = [];
  const worker: Rig["worker"] = { runs: 0, mode: "ok" };
  const verifier = { ok: true };
  const usage = new Map<string, string>();
  const binding: CommandBinding = { tenantRef: w.t, commandKey: w.key, actionRef: w.cmd, tariffRef: w.tf, maxInputTokens: 100, maxCachedInputTokens: 50, maxOutputTokens: 40, idempotencyKey: `${w.t}:evt-1` };
  const broker = createBrokerAdapter({
    rpc: pgRpc([w.t], o.settings),
    binding: async (req) => (req.tenantId === w.t && req.claimKey === `${w.t}:task-1:review_result` ? binding : null),
    usageEvidence: async (attemptId) => usage.get(attemptId) ?? null,
  });
  const ports: Ports = {
    killSwitch: () => "off",
    broker,
    ledger: {
      async record(e) {
        const entry = ledger.get(e.eventId);
        if (entry) return { verdict: "duplicate", entry: structuredClone(entry) };
        ledger.set(e.eventId, { status: "pending", job: null });
        return { verdict: "new" };
      },
      async resolve(e) { ledger.set(e.eventId, { status: e.status, job: structuredClone(e.job) }); },
      async recordOutcome(e) {
        const entry = ledger.get(e.eventId);
        if (entry?.status !== "admitted") throw new Error("not admitted");
        entry.outcome = { ...e.outcome };
      },
    },
    audit: { async append(entry) { audit.push(entry); } },
    worker: {
      // The simulated worker: the egress gateway forwards once to a synthetic provider and captures zero usage.
      async run(job: Job): Promise<WorkerResult> {
        worker.runs++;
        const hash = await q(`SELECT arn88_test.gateway_capture('${job.attemptId}'::uuid, 0, 0, 0, 'acp89');`);
        usage.set(job.attemptId!, hash);
        if (worker.mode === "throw") throw new Error("worker lost after the provider was reached");
        return { summary: "SYNTHETIC result", actualMicros: 0 };
      },
    },
    verifier: { verify: async (): Promise<Verification> => ({ ok: verifier.ok, checkedBy: "chatgpt", ref: "check-1" }) },
    executors: [{ key: "claude", configured: true, suspended: false, costTier: "free", worstCaseMicros: 0 }],
    authority: { paidExecutionApproved: false, grants: [{ intent: "review_result", maxTier: "green", expiresAt: "2026-10-13T23:00:00Z", maxBudgetMicros: 0 }] },
    now: () => NOW,
  };
  return { m: new Manager(ports), ports, ledger, broker, audit, worker, verifier, usage };
}
const event = (w: World, over: Partial<ManagerEvent> = {}): ManagerEvent => ({
  eventId: "evt-1", kind: "task_completed", source: "internal", tenantId: w.t, taskId: "task-1", seq: 1, occurredAt: "2026-10-12T23:25:00Z", ...over,
});

describe("ARN-89 manager + adapter against the real ARN-88 SQL (throwaway PostgreSQL)", { skip }, () => {
  before(() => {
    assert.deepEqual(blocked, [], "refusing to run with a database or Supabase connection variable set");
    dir = mkdtempSync(join(tmpdir(), "arn89-pg-"));
    if (root) chownSync(dir, Number(execFileSync("id", ["-u", "postgres"]).toString().trim()), Number(execFileSync("id", ["-g", "postgres"]).toString().trim()));
    const port = 20000 + Math.floor(Math.random() * 20000);
    asPg(`${PGBIN}/initdb -D ${dir}/data -U postgres --auth=trust --no-sync >/dev/null`);
    asPg(`${PGBIN}/pg_ctl -D ${dir}/data -w -l ${dir}/log -o "-c listen_addresses='' -c unix_socket_directories=${dir} -c port=${port} -c fsync=off -c synchronous_commit=off" start >/dev/null`);
    env = { PATH: process.env["PATH"], HOME: process.env["HOME"], PGHOST: dir, PGPORT: String(port), PGUSER: "postgres" };
    execFileSync("bash", [join(OPSDESK, "tests/sql/replay.sh"), DB], { env, stdio: "pipe" });
    execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", DB, "-f", join(OPSDESK, "tests/sql/arn-88-fixtures.sql")], { env, stdio: "pipe" });
  });
  after(() => {
    if (!dir) return;
    try { asPg(`${PGBIN}/pg_ctl -D ${dir}/data -m immediate stop >/dev/null 2>&1`); } catch { /* already down */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("the adapter's RPC names, parameters and types are exactly the SQL's, and exactly broker_caller's grants", async () => {
    const sql = readFileSync(join(OPSDESK, "drizzle/migrations/0030_execution_broker.sql"), "utf8");
    for (const [fn, sig] of Object.entries(BROKER_SIGNATURES)) {
      const m = new RegExp(`CREATE FUNCTION public\\.${fn}\\(([^)]*)\\)`).exec(sql);
      assert.ok(m, `${fn} is declared`);
      assert.deepEqual(m[1]!.split(",").map((p) => p.trim().split(/\s+/)), sig.map(([n, t]) => [n, t]), fn);
    }
    const granted = await q("SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'broker\\_%' AND has_function_privilege('broker_caller', p.oid, 'EXECUTE');");
    assert.deepEqual(granted.split(","), Object.keys(BROKER_SIGNATURES).sort());
  });

  test("happy path: internal $0 event -> one atomic claim -> audit -> simulated worker -> settle -> read-only recovery", async () => {
    const w = await world();
    const r = rig(w);
    const d = await r.m.handleEvent(event(w));
    assert.equal(d.status, "ADMITTED", d.reason);
    const done = await r.m.dispatch(d.job!.jobId);
    assert.equal(done.status, "ADMITTED", done.reason);
    assert.equal(done.job!.state, "complete");
    assert.equal(r.worker.runs, 1);
    assert.deepEqual(await attemptStates(), ["settled"]);
    assert.equal(await budgets(), "global:0/0,tenant:0/0", "$0 reserved, $0 settled");
    assert.deepEqual(await brokerAudit(), ["broker_dispatch", "broker_forwarded", "broker_record_command", "broker_reserve", "broker_settle", "broker_usage_captured"]);
    assert.deepEqual(r.audit.map((a) => a.step), ["admission_decided", "admitted", "dispatched", "verified", "complete"]);
    await invariants("happy path");

    const before = await snapshot();
    const again = rig(w, { ledger: r.ledger });
    const rec = await again.m.handleEvent(event(w));
    assert.equal(rec.status, "DUPLICATE", rec.reason);
    assert.equal(rec.job!.state, "complete");
    assert.equal(await snapshot(), before, "recovery wrote nothing");
    assert.equal(again.worker.runs, 0);
  });

  test("duplicate arrivals: the same event twice is one claim and one attempt", async () => {
    const w = await world();
    const r = rig(w);
    assert.equal((await r.m.handleEvent(event(w))).status, "ADMITTED");
    assert.equal((await r.m.handleEvent(event(w))).status, "DUPLICATE");
    assert.equal(await q("SELECT count(*) || '/' || (SELECT count(*) FROM public.execution_attempts) FROM public.execution_claims;"), "1/1");
  });

  test("concurrent claims: eight parallel sessions make one claim; two managers racing one job run the worker once", async () => {
    const w = await world();
    const adapters = Array.from({ length: 8 }, () => rig(w).broker);
    const req = { tenantId: w.t, claimKey: `${w.t}:task-1:review_result`, idempotencyKey: `${w.t}:evt-1`, executor: "claude" as const, tariffId: "free", worstCaseMicros: 0 };
    const got = await Promise.all(adapters.map((a) => a.claimAndReserve(req)));
    assert.ok(got.every((g) => g.ok), JSON.stringify(got));
    const grants = got.filter((g) => g.ok);
    assert.equal(grants.filter((g) => g.created).length, 1, "exactly one session created the claim");
    assert.equal(new Set(grants.map((g) => `${g.claimId}/${g.attemptId}/${g.fence}`)).size, 1, "everyone sees the same attempt and fence");
    assert.equal(await q("SELECT count(*) FROM public.execution_attempts;"), "1");
    await invariants("parallel claims");

    // Two manager instances that both admitted the same job (shared durable ledger) race to dispatch it.
    const w2 = await world();
    const ledger = new Map<string, LedgerEntry>();
    const a = rig(w2, { ledger });
    const b = rig(w2, { ledger });
    const da = await a.m.handleEvent(event(w2));
    const db = await b.m.handleEvent(event(w2));
    assert.equal(da.status, "ADMITTED");
    assert.equal(db.status, "DUPLICATE");
    b.m.jobs.set(da.job!.jobId, structuredClone(da.job!)); // b holds a copy of the same admitted job
    const [xa, xb] = await Promise.all([a.m.dispatch(da.job!.jobId), b.m.dispatch(da.job!.jobId)]);
    assert.equal(a.worker.runs + b.worker.runs, 1, "the worker ran once");
    assert.deepEqual([xa.reason, xb.reason].filter((x) => x === "broker_refused:stale"), ["broker_refused:stale"], "the loser was refused as stale");
    await invariants("racing dispatch");
  });

  test("stale fence: after a takeover the old attempt can never dispatch", async () => {
    const w = await world();
    const r = rig(w);
    const req = { tenantId: w.t, claimKey: `${w.t}:task-1:review_result`, idempotencyKey: `${w.t}:evt-1`, executor: "claude" as const, tariffId: "free", worstCaseMicros: 0 };
    const g1 = await r.broker.claimAndReserve(req);
    assert.ok(g1.ok);
    assert.deepEqual(await r.broker.release(g1.attemptId, g1.fence), { ok: true });
    const g2 = await r.broker.takeover(g1.claimId, g1.fence, 0);
    assert.ok(g2.ok, JSON.stringify(g2));
    assert.equal(g2.fence, g1.fence + 1);
    assert.deepEqual(await r.broker.markDispatched(g1.attemptId, g1.fence), { ok: false, reason: "stale" });
    assert.deepEqual(await r.broker.takeover(g1.claimId, g1.fence, 0), { ok: false, reason: "stale" }, "a second takeover on the old fence");
    assert.deepEqual(await r.broker.markDispatched(g2.attemptId, g2.fence), { ok: true });
    await invariants("stale fence");
  });

  test("provider cost above $0: a priced tariff is reserved, handed straight back and refused; a $0 cap refuses it outright", async () => {
    const w = await world({ priced: true, cap: 1_000_000 });
    const r = rig(w);
    const d = await r.m.handleEvent(event(w));
    assert.equal(d.reason, "broker_refused:provider_cost_above_zero");
    assert.deepEqual(await attemptStates(), ["released"]);
    assert.equal(await budgets(), "global:0/0,tenant:0/0");
    assert.equal(r.worker.runs, 0);
    await invariants("priced release");

    const z = await world({ priced: true, cap: 0 });
    const before = await snapshot();
    assert.equal((await rig(z).m.handleEvent(event(z))).reason, "broker_refused:insufficient_budget");
    assert.equal(await snapshot(), before);
  });

  test("kill switch: the broker refuses the claim, and a dispatch after it flips releases the attempt", async () => {
    const w = await world();
    await setKill(true);
    const before = await snapshot();
    assert.equal((await rig(w).m.handleEvent(event(w))).reason, "broker_refused:kill_switch");
    assert.equal(await snapshot(), before, "a refused claim writes nothing");
    await setKill(false);
    const r = rig(w);
    const d = await r.m.handleEvent(event(w, { eventId: "evt-1" }));
    assert.equal(d.status, "ADMITTED", d.reason);
    await setKill(true);
    assert.equal((await r.m.dispatch(d.job!.jobId)).reason, "broker_refused:kill_switch");
    assert.equal(r.worker.runs, 0);
    assert.deepEqual(await attemptStates(), ["released"]);
    await setKill(false);
    await invariants("kill switch");
  });

  test("broken audit at the broker: the claim rolls back whole and the manager sees the broker as down", async () => {
    const w = await world();
    const before = await snapshot();
    const d = await rig(w, { settings: { "arn88.fail_audit": "broker_reserve" } }).m.handleEvent(event(w));
    assert.equal(d.reason, "broker_unavailable");
    assert.equal(await snapshot(), before);
    // And the cause was the injected audit failure, not some other error in the call.
    const call = { p_tenant: w.t, p_command_key: w.key, p_action_ref: w.cmd, p_tariff_ref: w.tf, p_max_input: 100, p_max_cached: 50, p_max_output: 40 };
    await assert.rejects(pgRpc([w.t], { "arn88.fail_audit": "broker_reserve" })("broker_claim_and_reserve", call), /injected audit failure for broker_reserve/);
    assert.equal(await snapshot(), before);
  });

  test("ambiguous completion: a worker lost after the provider was reached leaves the attempt unknown, unsettled", async () => {
    const w = await world();
    const r = rig(w);
    r.worker.mode = "throw";
    const d = await r.m.handleEvent(event(w));
    const x = await r.m.dispatch(d.job!.jobId);
    assert.equal(x.job!.state, "unknown");
    assert.deepEqual(await attemptStates(), ["unknown"]);
    assert.equal(await q("SELECT count(*) FROM public.execution_attempts WHERE actual_micros IS NOT NULL;"), "0");

    // Read-only claim-status recovery after a restart: still unknown, and the broker is not written to.
    const before = await snapshot();
    const again = rig(w, { ledger: r.ledger });
    const rec = await again.m.handleEvent(event(w));
    assert.equal(rec.job!.state, "unknown");
    assert.equal(again.m.ownerQueue[0]?.needs, "reconciliation");
    assert.equal(await snapshot(), before);
    await invariants("ambiguous");
  });

  test("idempotent failure finalization: a rejected result fails once; a replay changes nothing; a stale fence is refused", async () => {
    const w = await world();
    const r = rig(w);
    r.verifier.ok = false;
    const d = await r.m.handleEvent(event(w));
    const x = await r.m.dispatch(d.job!.jobId);
    assert.equal(x.job!.state, "failed");
    assert.deepEqual(await attemptStates(), ["failed"]);
    const before = await snapshot();
    assert.deepEqual(await r.broker.markFailed(x.job!.attemptId!, x.job!.fence!), { ok: true });
    assert.equal(await snapshot(), before, "the replay wrote nothing");
    assert.deepEqual(await r.broker.markFailed(x.job!.attemptId!, x.job!.fence! + 1), { ok: false, reason: "stale" });
    await invariants("failed");
  });
});

