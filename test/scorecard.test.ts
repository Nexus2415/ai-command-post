// ARN-150: the engine scorecard. Pure counting, the engine wiring (status report) and the dashboard rows.
// Synthetic only: an in-memory store and fake ledger entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseScorecard, parseStatus } from "../api/_lib/engine-status.js";
import { Budget, type LedgerEntry } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import type { Issue, TaskStore } from "../src/linear.ts";
import { COMMAND_MARKER, tick, type Deps } from "../src/orchestrator.ts";
import { hasProof, scorecard, MAX_SCORED_TASKS } from "../src/scorecard.ts";

const issue = (n: number, over: Partial<Issue> = {}): Issue => ({
  id: `id-${n}`, identifier: `ARN-${n}`, title: `[Claude] Task ${n}`, description: "", url: "", priority: 3,
  stateType: "completed", stateName: "Done", labels: [], assignee: null, parentId: null, childIds: [],
  createdAt: `2026-11-${String(10 + (n % 15)).padStart(2, "0")}T00:00:00.000Z`, ...over,
});
const spend = (issueId: string, usd: number): LedgerEntry => ({ at: "2026-11-20T00:00:00Z", agent: "claude", issue: issueId, inputTokens: 1, outputTokens: 1, usd });
const done = (body: string) => `## Result (Claude, done)\n\n${body}`;
const blocked = "## Result (Claude, blocked)\n\nNo access.";

test("proof: a link, and a PR link only counts with ALL PASSED", () => {
  assert.equal(hasProof("Wrote the plan."), false);
  assert.equal(hasProof("Sources: https://example.com/a"), true);
  assert.equal(hasProof("PR https://github.com/acme/app/pull/7 opened"), false);
  assert.equal(hasProof("PR https://github.com/acme/app/pull/7 — PR #7 at abc1234: ALL PASSED"), true);
});

test("counts each task once and divides all window spend by proven tasks", () => {
  const tasks = [issue(1), issue(2), issue(3), issue(4, { stateType: "started" }), issue(5, { stateType: "unstarted" }), issue(6, { stateType: "canceled" })];
  const results = new Map([
    ["ARN-1", { status: "done" as const, body: done("https://github.com/a/b/pull/1 ALL PASSED") }],
    ["ARN-2", { status: "done" as const, body: done("https://example.com/source") }],
    ["ARN-3", { status: "done" as const, body: done("No links at all") }],
    ["ARN-4", { status: "done" as const, body: done("https://example.com") }], // owner moved it back: reopened
    ["ARN-6", { status: "blocked" as const, body: blocked }],
  ]);
  const ledger = [spend("ARN-1", 0.5), spend("ARN-2", 0.25), spend("ARN-99", 0.25), spend("ARN-OLD", 9)];
  const sc = scorecard(tasks, new Set(["ARN-1", "ARN-2", "ARN-99"]), ledger, results, false);
  assert.deepEqual(sc, { windowDays: 14, worked: 6, proven: 2, unproven: 1, neededYou: 2, open: 1, spentUsd: 1, usdPerProven: 0.5, partial: false });
  assert.equal(scorecard([], new Set(), [], new Map(), false).usdPerProven, null);
});

function store(issues: Issue[], comments: Record<string, string[]>, published: string[]): TaskStore {
  return {
    listOpenAndRecent: async () => issues,
    getComments: async (id) => (comments[id] ?? []).map((body, i) => ({ body, createdAt: `2026-11-20T00:00:0${i}.000Z` })),
    comment: async () => {}, setState: async () => {}, createIssue: async () => { throw new Error("no writes expected"); },
    publishStatus: async (c) => { published.push(c); },
  };
}
const deps = (s: TaskStore, entries: LedgerEntry[], log: string[] = []): Deps => {
  const budget = new Budget({ capUsd: 0, path: null });
  for (const e of entries) budget.record({ agent: e.agent, issue: e.issue, inputTokens: e.inputTokens, outputTokens: e.outputTokens });
  return { cfg: loadConfig({ ACP_ACTIVE: "true", ACP_DEFAULT_LEAD: "claude" }), store: s, clients: {}, log: (l) => log.push(l), budget, toolEnv: () => { throw new Error("no tools"); } };
};

test("the engine puts the scorecard in its status report, counting only tasks it spent on", async () => {
  const published: string[] = [];
  const cmd = issue(10, { title: "Build it", description: COMMAND_MARKER, stateType: "started" });
  const issues = [issue(1), issue(2, { stateType: "canceled" }), issue(3), cmd, issue(4, { title: "[Question] why?" })];
  const s = store(issues, { "id-1": [done("https://example.com")], "id-2": [blocked] }, published);
  await tick(deps(s, [spend("ARN-1", 0), spend("ARN-2", 0), spend("ARN-10", 0), spend("ARN-4", 0)]));
  const sc = parseStatus(published[0])!.scorecard;
  assert.ok(sc, "scorecard present");
  assert.deepEqual([sc.worked, sc.proven, sc.neededYou, sc.open], [2, 1, 1, 0], "ARN-3 had no spend; the command and question aren't tasks");
  assert.match(published[0]!, /Scorecard, last 14 days: 1 finished with proof, 1 needed the owner/);
});

test("a scorecard read failure leaves it out and never fails the run", async () => {
  const published: string[] = [], log: string[] = [];
  const s = store([issue(1)], {}, published);
  s.getComments = async () => { throw new Error("Linear 500"); };
  const r = await tick(deps(s, [spend("ARN-1", 0)], log));
  assert.deepEqual(r.errors, []);
  assert.equal(parseStatus(published[0])!.scorecard, undefined);
  assert.ok(log.some((l) => l.includes("scorecard not computed: Linear 500")));
});

test("only the newest tasks are scored, and the card says so", async () => {
  const many = Array.from({ length: MAX_SCORED_TASKS + 5 }, (_, i) => issue(i + 1, { stateType: "unstarted" }));
  const published: string[] = [];
  await tick(deps(store(many, {}, published), many.map((i) => spend(i.identifier, 0))));
  const sc = parseStatus(published[0])!.scorecard!;
  assert.equal(sc.worked, MAX_SCORED_TASKS);
  assert.equal(sc.partial, true);
});

test("a malformed scorecard is dropped without hiding the report", () => {
  const ok = { windowDays: 14, worked: 2, proven: 1, unproven: 0, neededYou: 1, open: 0, spentUsd: 0.4, usdPerProven: 0.4, partial: false };
  assert.deepEqual(parseScorecard(ok), ok);
  for (const bad of [null, [], { ...ok, worked: 3 }, { ...ok, proven: -1, open: 2 }, { ...ok, spentUsd: "1" }, { ...ok, usdPerProven: -1 }, { ...ok, partial: "no" }]) {
    assert.equal(parseScorecard(bad), null, JSON.stringify(bad));
  }
});

test("dashboard shows finished with proof, times it needed you and cost per finished task", () => {
  const sandbox: any = {};
  vm.runInNewContext(readFileSync(new URL("../dashboard/console.js", import.meta.url), "utf8"), sandbox);
  const engine = {
    at: "2026-11-27T16:00:00.000Z", active: true, dryRun: false, lead: "claude", agentsOnline: ["claude"],
    budget: { month: "2026-11", spentUsd: 1, capUsd: 5, calls: 9, ledgerProblem: null },
    counts: { planned: 0, worked: 1, reconciled: 0, waiting: 0, errors: 0 },
    scorecard: { windowDays: 14, worked: 4, proven: 2, unproven: 1, neededYou: 1, open: 0, spentUsd: 1.2, usdPerProven: 0.6, partial: false },
  };
  const rows = sandbox.ACPConsoleCore.engineRows(engine, Date.parse("2026-11-27T16:05:00Z"));
  const get = (l: string) => rows.find((r: any) => r.label.startsWith(l));
  assert.equal(get("Finished with proof").value, "2 of 4 tasks, 1 done without proof");
  assert.equal(get("Needed you").value, "1 time (blocked, or reopened after done)");
  assert.equal(get("Cost per finished task").value, "$0.60 ($1.20 spent)");
  const none = sandbox.ACPConsoleCore.engineRows({ ...engine, scorecard: undefined }, Date.parse("2026-11-27T16:05:00Z"));
  assert.equal(none.find((r: any) => r.label.startsWith("Needed you")), undefined, "no scorecard, no rows");
});
