import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handle } from "../api/console.js";
import { PROJECT_ID, TEAM_ID } from "../api/lib/console-state.js";
import { STATUS_TITLE, engineStatusOf, engineStatusRead, parseStatus, statusContent } from "../api/lib/engine-status.js";
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
  const docs = { project: { documents: { nodes: [{ title: STATUS_TITLE, content: statusContent(snap()), updatedAt: "2026-10-20T22:00:01Z" }], pageInfo: { hasNextPage: false } } } };
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
  assert.deepEqual(statusCall.variables, { project: PROJECT_ID, after: null }, "scope is fixed by the server");
  assert.ok(calls.some(c => c.variables?.team === TEAM_ID));
  const down: any = await handle(req, env, route(false));
  assert.equal(down.status, 200);
  assert.equal(down.body.engine, null);
  assert.equal(ok.body.engineStatus, "reported");
  assert.equal(down.body.engineStatus, "unavailable", "a failed status read is never reported as 'not reported yet'");
  assert.match(statusCall.query, /pageInfo \{ hasNextPage endCursor \}/, "the status query asks whether the document list is complete");
  // A first page of other documents with more to come is not proof the report is absent.
  const page = (more: boolean) => (async (_u: any, init: any) => JSON.parse(init.body).query.includes("ConsoleEngineStatus")
    ? Response.json({ data: { project: { documents: { nodes: [{ title: "Notes", content: "x", updatedAt: "2026-10-20T22:00:01Z" }], pageInfo: { hasNextPage: more } } } } })
    : Response.json({ data: issues })) as typeof fetch;
  assert.equal(((await handle(req, env, page(true))) as any).body.engineStatus, "unavailable");
  assert.equal(((await handle(req, env, page(false))) as any).body.engineStatus, "absent");
});

test("ARN-47: the console follows status-document pages and never picks an older report from a partial list", async () => {
  const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
  const req = { method: "POST", headers: { "x-acp-password": "pw" }, body: { action: "overview" } };
  const issues = { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
  const older = { title: STATUS_TITLE, content: statusContent({ ...snap(), at: "2026-10-20T21:00:00.000Z" }), updatedAt: "2026-10-20T21:00:01Z" };
  const newer = { title: STATUS_TITLE, content: statusContent(snap()), updatedAt: "2026-10-20T22:00:01Z" };
  const run = async (pages: any[]) => {
    const asked: any[] = [];
    const f = (async (_u: any, init: any) => {
      const b = JSON.parse(init.body);
      if (!b.query.includes("ConsoleEngineStatus")) return Response.json({ data: issues });
      asked.push(b.variables.after);
      const p = pages[asked.length - 1];
      return p instanceof Response ? p : Response.json({ data: { project: { documents: p } } });
    }) as typeof fetch;
    return { body: ((await handle(req, env, f)) as any).body, asked };
  };
  // The older report on page 1 and the newer duplicate on page 2: the newer one wins.
  const both = await run([
    { nodes: [older], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [newer], pageInfo: { hasNextPage: false, endCursor: null } },
  ]);
  assert.deepEqual(both.asked, [null, "c1"]);
  assert.equal(both.body.engineStatus, "reported");
  assert.equal(both.body.engine.at, "2026-10-20T22:00:00.000Z");
  // Missing or malformed pageInfo leaves the list unconfirmed: unavailable, never the older report.
  for (const pageInfo of [undefined, null, {}, { hasNextPage: "false" }]) {
    const r = await run([{ nodes: [older], pageInfo }]);
    assert.equal(r.body.engineStatus, "unavailable");
    assert.equal(r.body.engine, null);
  }
  // More pages promised but no cursor to follow them: unavailable.
  assert.equal((await run([{ nodes: [older], pageInfo: { hasNextPage: true, endCursor: null } }])).body.engineStatus, "unavailable");
  // A later page that fails or is malformed: unavailable, even though page 1 had a report.
  assert.equal((await run([{ nodes: [older], pageInfo: { hasNextPage: true, endCursor: "c1" } }, new Response("{}", { status: 500 })])).body.engineStatus, "unavailable");
  assert.equal((await run([{ nodes: [older], pageInfo: { hasNextPage: true, endCursor: "c1" } }, { nodes: "x", pageInfo: { hasNextPage: false } }])).body.engineStatus, "unavailable");
  // Still incomplete after the page cap: unavailable, with a bounded number of reads.
  const endless = Array.from({ length: 10 }, (_, i) => ({ nodes: [older], pageInfo: { hasNextPage: true, endCursor: "c" + (i + 1) } }));
  const capped = await run(endless);
  assert.equal(capped.body.engineStatus, "unavailable");
  assert.deepEqual(capped.asked, [null, "c1", "c2", "c3"]);
});

test("ARN-47: engine report read result tells absent from unavailable", () => {
  const good = { title: STATUS_TITLE, content: statusContent(snap()), updatedAt: "2026-10-20T22:00:01Z" };
  assert.deepEqual(engineStatusRead([good], false), { engineStatus: "reported", engine: engineStatusOf([good]) });
  // A match on a partial or unconfirmed list may be an older duplicate of a newer report on an unread page.
  for (const more of [true, undefined, null, "false"]) assert.deepEqual(engineStatusRead([good], more), { engineStatus: "unavailable", engine: null });
  assert.deepEqual(engineStatusRead([], false), { engineStatus: "absent", engine: null });
  const others = Array.from({ length: 50 }, (_, i) => ({ ...good, title: "Doc " + i }));
  assert.deepEqual(engineStatusRead(others, false), { engineStatus: "absent", engine: null }, "a complete list without the report");
  // A partial or unconfirmed list without the report proves nothing: it may be on a later page.
  for (const more of [true, undefined, null, "false"]) assert.deepEqual(engineStatusRead(others, more), { engineStatus: "unavailable", engine: null });
  for (const bad of [undefined, null, {}, "docs"]) assert.deepEqual(engineStatusRead(bad, false), { engineStatus: "unavailable", engine: null });
  assert.deepEqual(engineStatusRead([{ ...good, content: "edited by hand" }], false), { engineStatus: "unavailable", engine: null }, "a malformed report is unreadable, not absent");
});

test("dashboard engine rows: missing, stale, blocked and failing states are flagged", () => {
  const sandbox: any = {};
  vm.runInNewContext(readFileSync(new URL("../dashboard/console.js", import.meta.url), "utf8"), sandbox);
  const rows = (e: any, now = Date.parse("2026-10-20T22:30:00Z")) => sandbox.ACPConsoleCore.engineRows(e, now);
  const missing = rows(null);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].tone, "warn");
  const fresh = rows(parseStatus(statusContent(snap())));
  assert.ok(fresh.every((r: any) => r.tone === null), JSON.stringify(fresh));
  assert.match(fresh[0].value, /30 min ago/);
  assert.match(fresh.find((r: any) => r.label === "Paid AI calls").value, /cap is zero/);
  assert.equal(rows(parseStatus(statusContent(snap())), Date.parse("2026-10-21T06:00:00Z"))[0].tone, "warn", "no run for 8 hours");
  const blocked = rows(parseStatus(statusContent(snap({ budget: { month: "2026-10", spentUsd: 0, capUsd: 5, calls: 0, ledgerProblem: "the spend ledger is missing" } }))));
  assert.equal(blocked.find((r: any) => r.label === "Paid AI calls").tone, "warn");
  const failing = rows(parseStatus(statusContent(snap({ counts: { planned: 0, worked: 0, reconciled: 0, waiting: 0, errors: 2 } }))));
  assert.equal(failing.at(-1).tone, "warn");
  // ARN-47: an unreadable report is flagged, never shown as "not reported yet"; a kept report keeps its own time.
  const down = sandbox.ACPConsoleCore.engineView(null, Date.parse("2026-10-20T22:30:00Z"), true);
  assert.equal(down.length, 1);
  assert.equal(down[0].tone, "warn");
  assert.match(down[0].value, /^Unavailable/);
  assert.doesNotMatch(down[0].value, /Not reported/);
  const report = parseStatus(statusContent(snap()));
  const kept = sandbox.ACPConsoleCore.engineView(report, Date.parse("2026-10-20T22:30:00Z"), true);
  assert.match(kept[0].value, /Unavailable.*last verified report/);
  assert.equal(kept[0].tone, "warn");
  assert.deepEqual(kept.slice(1).map((r: any) => r.value), rows(report).map((r: any) => r.value));
  assert.deepEqual(sandbox.ACPConsoleCore.engineView(null, 0, false).map((r: any) => r.value), missing.map((r: any) => r.value), "absent stays 'not reported yet'");
});
