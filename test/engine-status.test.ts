import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handle } from "../api/console.js";
import { PROJECT_ID, TEAM_ID } from "../api/lib/console-state.js";
import { STATUS_TITLE, engineStatusOf, parseStatus, statusContent } from "../api/lib/engine-status.js";
import { Budget } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { LinearStore, type TaskStore } from "../src/linear.ts";
import { tick, type Deps } from "../src/orchestrator.ts";

// Engine status: the engine rewrites one Linear project document per active run; the console reads it back.
const snap = (over: Record<string, unknown> = {}) => ({
  version: 1, at: "2026-10-20T22:00:00.000Z", active: true, dryRun: false, lead: "gemini", agentsOnline: ["gemini"],
  budget: { month: "2026-10", spentUsd: 0, capUsd: 0, calls: 3, ledgerProblem: null },
  counts: { planned: 1, worked: 2, reconciled: 0, waiting: 4, errors: 0 }, ...over,
});

test("status document round-trips, and anything malformed or foreign reads as no status", () => {
  const doc = (content: string, updatedAt = "2026-10-20T22:00:01Z", title = STATUS_TITLE) => ({ title, content, updatedAt });
  const { version, ...expected } = snap();
  assert.equal(version, 1);
  assert.deepEqual(engineStatusOf([doc(statusContent(snap()))]), expected);
  const parsed = engineStatusOf([doc(statusContent(snap()))])!;
  assert.equal(parsed.at, "2026-10-20T22:00:00.000Z");
  assert.deepEqual(parsed.counts, snap().counts);
  assert.equal(engineStatusOf([]), null);
  assert.equal(engineStatusOf([doc(statusContent(snap()), undefined, "Some other doc")]), null, "only the engine's title counts");
  for (const bad of [
    "no fence here", "```json\n{not json\n```",
    statusContent(snap({ version: 2 })), statusContent(snap({ at: "yesterday" })), statusContent(snap({ active: "yes" })),
    statusContent(snap({ budget: { month: "Oct", spentUsd: 0, capUsd: 0, calls: 0 } })),
    statusContent(snap({ budget: { month: "2026-10", spentUsd: -1, capUsd: 0, calls: 0 } })),
    statusContent(snap({ budget: { month: "2026-10", spentUsd: 0, capUsd: 0, calls: 0, ledgerProblem: 5 } })),
    statusContent(snap({ counts: { planned: 1 } })), statusContent(snap({ agentsOnline: "gemini" })),
  ]) assert.equal(parseStatus(bad), null, bad.slice(0, 80));
  const odd = parseStatus(statusContent(snap({ lead: "<script>", agentsOnline: ["gemini", "root", "claude"],
    budget: { month: "2026-10", spentUsd: 0, capUsd: 1, calls: 0, ledgerProblem: "x".repeat(500) } })))!;
  assert.equal(odd.lead, null);
  assert.deepEqual(odd.agentsOnline, ["claude", "gemini"]);
  assert.equal(odd.budget.ledgerProblem!.length, 200);
  const newer = engineStatusOf([doc(statusContent(snap()), "2026-10-20T10:00:00Z"), doc(statusContent(snap({ at: "2026-10-20T23:00:00.000Z" })), "2026-10-20T23:00:01Z")]);
  assert.equal(newer!.at, "2026-10-20T23:00:00.000Z", "a duplicated document resolves to the newest");
});

test("LinearStore creates the status document once in the fixed project, then updates it", async () => {
  const calls: any[] = [];
  let existing: any[] = [];
  const f = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    calls.push(b);
    if (b.query.includes("documents(")) return Response.json({ data: { project: { documents: { nodes: existing } } } });
    if (b.query.includes("documentCreate")) return Response.json({ data: { documentCreate: { success: true, document: { id: "doc-1" } } } });
    return Response.json({ data: { documentUpdate: { success: true } } });
  }) as typeof fetch;
  const store = new LinearStore("k", f);
  await store.publishStatus("one");
  await store.publishStatus("two");
  assert.deepEqual(calls.map(c => c.query.match(/documentCreate|documentUpdate|documents\(/)![0]), ["documents(", "documentCreate", "documentUpdate"]);
  assert.deepEqual(calls[0].variables, { p: PROJECT_ID });
  assert.deepEqual(calls[1].variables.input, { projectId: PROJECT_ID, title: STATUS_TITLE, content: "one" });
  assert.deepEqual(calls[2].variables, { id: "doc-1", input: { content: "two" } });

  calls.length = 0;
  existing = [{ id: "other", title: "Runbook" }, { id: "doc-9", title: STATUS_TITLE }];
  await new LinearStore("k", f).publishStatus("three");
  assert.deepEqual(calls[1].variables, { id: "doc-9", input: { content: "three" } }, "an existing document is reused, never duplicated");

  const failing = new LinearStore("k", (async () => Response.json({ data: { project: { documents: { nodes: [] } }, documentCreate: { success: false } } })) as typeof fetch);
  await assert.rejects(failing.publishStatus("x"), /did not create "AI Command Post: engine status"/);
});

const emptyStore = (publish?: (c: string) => Promise<void>): TaskStore => ({
  listOpenAndRecent: async () => [], getComments: async () => [], comment: async () => {}, setState: async () => {},
  createIssue: async () => { throw new Error("no writes expected"); }, ...(publish ? { publishStatus: publish } : {}),
});
const deps = (env: Record<string, string>, store: TaskStore, log: string[]): Deps => ({
  cfg: loadConfig({ ACP_DEFAULT_LEAD: "gemini", ...env }), store, clients: {}, log: l => log.push(l),
  budget: new Budget({ capUsd: 0, path: null }), toolEnv: () => { throw new Error("no tools expected"); },
});

test("an active run publishes its status; an inactive run and a failed publish change nothing else", async () => {
  const published: string[] = [], log: string[] = [];
  const r = await tick(deps({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false" }, emptyStore(async c => { published.push(c); }), log));
  assert.equal(published.length, 1);
  const s = parseStatus(published[0])!;
  assert.deepEqual([s.active, s.dryRun, s.lead, s.budget.capUsd, s.budget.ledgerProblem], [true, false, "gemini", 0, null]);
  assert.deepEqual(s.agentsOnline, []);
  assert.deepEqual(r.errors, []);

  await tick(deps({ ACP_ACTIVE: "false" }, emptyStore(async c => { published.push(c); }), log));
  assert.equal(published.length, 1, "the status command and an off engine never write");

  const log2: string[] = [];
  const r2 = await tick(deps({ ACP_ACTIVE: "true" }, emptyStore(async () => { throw new Error("Linear 500"); }), log2));
  assert.deepEqual(r2.errors, [], "a status failure never fails the run");
  assert.ok(log2.some(l => l.includes("engine status not published: Linear 500")));
});

test("console overview carries the engine status, and a status read failure never hides the board", async () => {
  const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
  const req = { method: "POST", headers: { "x-acp-password": "pw" }, body: { action: "overview" } };
  const issues = { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
  const docs = { project: { documents: { nodes: [{ title: STATUS_TITLE, content: statusContent(snap()), updatedAt: "2026-10-20T22:00:01Z" }] } } };
  const calls: any[] = [];
  const route = (statusOk: boolean) => (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    calls.push(b);
    if (b.query.includes("ConsoleEngineStatus")) return statusOk ? Response.json({ data: docs }) : new Response("{}", { status: 500 });
    return Response.json({ data: issues });
  }) as typeof fetch;
  const ok: any = await handle(req, env, route(true));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.engine.at, "2026-10-20T22:00:00.000Z");
  const statusCall = calls.find(c => c.query.includes("ConsoleEngineStatus"));
  assert.deepEqual(statusCall.variables, { project: PROJECT_ID }, "scope is fixed by the server");
  assert.ok(calls.some(c => c.variables?.team === TEAM_ID));
  const down: any = await handle(req, env, route(false));
  assert.equal(down.status, 200);
  assert.equal(down.body.engine, null);
});

test("dashboard engine rows: missing, stale, blocked and failing states are flagged", () => {
  const sandbox: any = {};
  vm.runInNewContext(readFileSync(new URL("../dashboard/console.js", import.meta.url), "utf8"), sandbox);
  const rows = (e: any, now = Date.parse("2026-10-20T22:30:00Z")) => sandbox.ACPConsoleCore.engineRows(e, now);
  const missing = rows(null);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].tone, "warn");
  const fresh = rows(parseStatus(statusContent(snap({ lead: "claude", agentsOnline: ["claude"] }))));
  assert.ok(fresh.every((r: any) => r.tone === null), JSON.stringify(fresh));
  assert.match(fresh[0].value, /30 min ago/);
  assert.match(fresh.find((r: any) => r.label === "Paid AI calls").value, /cap is zero/);
  assert.equal(rows(parseStatus(statusContent(snap())), Date.parse("2026-10-21T06:00:00Z"))[0].tone, "warn", "no run for 8 hours");
  const blocked = rows(parseStatus(statusContent(snap({ budget: { month: "2026-10", spentUsd: 0, capUsd: 5, calls: 0, ledgerProblem: "the spend ledger is missing" } }))));
  assert.equal(blocked.find((r: any) => r.label === "Paid AI calls").tone, "warn");
  const failing = rows(parseStatus(statusContent(snap({ counts: { planned: 0, worked: 0, reconciled: 0, waiting: 0, errors: 2 } }))));
  assert.equal(failing.at(-1).tone, "warn");
});

test("ARN-47: the paid-calls row follows the reported state and never reads a cap as permission", () => {
  const sandbox: any = {};
  vm.runInNewContext(readFileSync(new URL("../dashboard/console.js", import.meta.url), "utf8"), sandbox);
  const paid = (o: any) => {
    const parsed = parseStatus(statusContent(snap(o)));
    assert.ok(parsed, "the server parser accepts the synthetic report");
    return sandbox.ACPConsoleCore.engineRows(parsed, Date.parse("2026-10-20T22:30:00Z")).find((r: any) => r.label === "Paid AI calls");
  };
  const budget = (capUsd: number, ledgerProblem: string | null = null) => ({ budget: { month: "2026-10", spentUsd: 0, capUsd, calls: 0, ledgerProblem } });
  const cases: [any, RegExp, string | null][] = [
    [{ active: false, dryRun: false, ...budget(5) }, /^Off: the engine was off/, null],
    [{ active: false, dryRun: true, ...budget(5, "the spend ledger is missing") }, /^Off: the engine was off/, null],
    [{ active: true, dryRun: false, ...budget(5, "the spend ledger is missing") }, /^Blocked: the spend ledger is missing$/, "warn"],
    [{ active: true, dryRun: false, ...budget(0) }, /^Off: the monthly cap is zero$/, null],
    [{ active: true, dryRun: true, ...budget(0) }, /^Off: the monthly cap is zero$/, null],
    [{ active: true, dryRun: false, ...budget(5) }, /^Cap set at \$5\.00 a month\. A cap is a limit, not a permission; calls are not verified$/, null],
    [{ active: true, dryRun: true, ...budget(5) }, /^Cap set at \$5\.00 a month\..*not verified\. Dry run still runs the AIs and only skips writes$/, null],
  ];
  for (const [o, value, tone] of cases) {
    const r = paid(o);
    assert.match(r.value, value, JSON.stringify(o));
    assert.equal(r.tone, tone, JSON.stringify(o));
    assert.doesNotMatch(r.value, /allowed/i, "a cap is never shown as permission");
  }
});

test("ARN-47: engine rows label the report as reported, never call an off engine live, and keep Gemini suspended", () => {
  const sandbox: any = {};
  vm.runInNewContext(readFileSync(new URL("../dashboard/console.js", import.meta.url), "utf8"), sandbox);
  const rows = (e: any) => sandbox.ACPConsoleCore.engineRows(e, Date.parse("2026-10-20T22:30:00Z"));
  const row = (r: any[], label: string) => r.find((x: any) => x.label === label);
  const off = rows(parseStatus(statusContent(snap({ active: false, dryRun: false, agentsOnline: ["gemini"] }))));
  assert.equal(row(off, "Last reported mode").value, "Engine off", "an inactive engine is never shown as live writes");
  const ais = row(off, "AIs in last report (unverified)");
  assert.equal(ais.value, "Gemini (suspended, not running)");
  assert.equal(ais.tone, "warn");
  assert.equal(row(rows(parseStatus(statusContent(snap({ agentsOnline: ["claude", "gemini"] })))), "AIs in last report (unverified)").value,
    "Claude, Gemini (suspended, not running)");
  assert.equal(row(rows(parseStatus(statusContent(snap({ dryRun: true })))), "Last reported mode").value, "Dry run, no writes");
  assert.ok(off.every((r: any) => !/online/i.test(r.label + " " + r.value)), "nothing claims an AI is online");
  const stale = rows(parseStatus(statusContent(snap({ at: "2026-10-19T10:00:00.000Z" }))));
  assert.equal(stale[0].tone, "warn", "a stale report is flagged");
  assert.equal(rows(null)[0].tone, "warn", "an unknown or malformed report shows as not reported");
});
