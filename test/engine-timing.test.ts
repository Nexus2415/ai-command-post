// The engine's first self-built PR (ARN-146 → #141, 2026-11-28) had two timing slips. github.pr_checks said ALL PASSED
// when only a skipped app check had appeared and the real test run hadn't started, so the coder distrusted it and
// reported blocked. Then the blocked task was set to Canceled, and Linear's GitHub link closed the good PR.
// These tests cover both fixes. Synthetic only: scripted model replies and a fake fetch for GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { tick, type Deps } from "../src/orchestrator.ts";
import { CHECK_WAIT_MS, runTool, type ToolEnv } from "../src/tools.ts";

const REPO = "acme/app";
const SHA = "b".repeat(40);
const PR_URL = "https://github.com/acme/app/pull/7";

function fakeGitHub(checks: any[][] = [[]]) {
  let poll = 0;
  const writes: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    if (method !== "GET") writes.push(`${method} ${u.pathname}`);
    if (u.pathname === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (u.pathname.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base" } });
    if (u.pathname === `/repos/${REPO}/pulls` && method === "POST") return Response.json({ number: 7, html_url: PR_URL });
    if (u.pathname === `/repos/${REPO}/pulls/7`) return Response.json({ head: { sha: SHA } });
    if (u.pathname.endsWith("/check-runs")) return Response.json({ check_runs: checks[Math.min(poll++, checks.length - 1)] });
    if (u.pathname.includes("/contents/")) return method === "PUT" ? Response.json({}) : new Response("{}", { status: 404 });
    return Response.json({});
  }) as unknown as typeof fetch;
  return { f, writes };
}

const check = (id: number, name: string, conclusion: string | null, slug = "github-actions") =>
  ({ id, name, status: conclusion ? "completed" : "queued", conclusion, app: { slug } });
const skipped = check(1, "Supabase Preview", "skipped", "supabase");

function checksRig(checks: any[][]) {
  const gh = fakeGitHub(checks);
  const sleeps: number[] = [];
  const env: ToolEnv = {
    githubToken: "t", dryRun: false, f: gh.f,
    policy: { allowPullRequests: true, allowedRepos: [REPO] },
    comment: async () => {}, requestApproval: async () => {},
    openedBranches: new Set(), sleep: async (ms) => { sleeps.push(ms); },
  };
  return { sleeps, call: () => runTool({ tool: "github.pr_checks", input: { repo: REPO, pr: 7 } }, ["github.pr_checks"], env) };
}

test("pr_checks keeps waiting while only a skipped check is there, and reports once the real run finishes", async () => {
  const r = checksRig([[skipped], [skipped], [skipped, check(2, "validate", null)], [skipped, check(2, "validate", "success")]]);
  const res = await r.call();
  assert.match(res.output, /ALL PASSED/);
  assert.match(res.output, /validate: success/);
  assert.ok(r.sleeps.length >= 3, `waited ${r.sleeps.length} polls`);
});

test("pr_checks never calls a skipped-only PR passed, even when the wait runs out", async () => {
  const r = checksRig([[skipped]]);
  const res = await r.call();
  assert.doesNotMatch(res.output, /ALL PASSED/);
  assert.match(res.output, /no real checks have run yet/);
  assert.match(res.output, /Call github\.pr_checks again/);
  assert.equal(r.sleeps.reduce((a, b) => a + b, 0), CHECK_WAIT_MS);
});

test("pr_checks waits one more poll after everything finishes, so a check that registers late is not missed", async () => {
  // Poll 2: Vercel finished, the test run hasn't registered yet. Poll 3: the test run shows up and later fails.
  const vercel = check(3, "Vercel", "success", "vercel");
  const r = checksRig([[], [vercel], [vercel, check(2, "validate", null)], [vercel, check(2, "validate", "failure")]]);
  const res = await r.call();
  assert.match(res.output, /FAILED/);
});

class Store implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  states: StateType[] = [];
  constructor() {
    this.issues.push({
      id: "i1", identifier: "T-1", title: "[Claude] Change the app", description: "x", url: "", priority: 3, stateType: "unstarted", stateName: "Todo",
      labels: [], assignee: null, parentId: null, childIds: [], createdAt: new Date(2026, 9, 1).toISOString(),
    });
  }
  async listOpenAndRecent() { return this.issues.map((i) => ({ ...i })); }
  async getComments(id: string) { return this.comments.get(id) ?? []; }
  async createIssue(): Promise<Issue> { throw new Error("not used"); }
  async comment(id: string, body: string) {
    const l = this.comments.get(id) ?? [];
    l.push({ body, createdAt: new Date().toISOString() });
    this.comments.set(id, l);
  }
  async setState(id: string, _t: string, type: StateType) {
    this.states.push(type);
    this.issues.find((i) => i.id === id)!.stateType = type;
  }
}

function engineRig(replies: string[], opts: { dryRun?: boolean; maxSteps?: string } = {}) {
  const store = new Store();
  const gh = fakeGitHub([[check(2, "validate", "failure")]]);
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: opts.dryRun ? "true" : "false", ACP_MAX_STEPS: opts.maxSteps ?? "6" });
  const free = { inputPerM: 0, outputPerM: 0, freeTier: true };
  const d: Deps = {
    cfg, store,
    clients: {
      claude: {
        async chat() {
          const text = replies.shift();
          if (text === undefined) throw new Error("no scripted reply left");
          return { text, inputTokens: 10, outputTokens: 10 };
        },
      },
    },
    budget: new Budget({ capUsd: 0, path: null, rates: { ...DEFAULT_RATES, claude: free } }),
    toolEnv: () => ({
      githubToken: "t", dryRun: opts.dryRun ?? false, f: gh.f, sleep: async () => {},
      policy: { allowPullRequests: true, allowedRepos: [REPO] },
      comment: async () => {}, requestApproval: async () => {},
    }),
  };
  const lastResult = () => (store.comments.get("i1") ?? []).map((c) => c.body).filter((b) => b.startsWith("## Result")).at(-1) ?? "";
  return { store, d, gh, lastResult };
}

const openPr = JSON.stringify({ tool: "github.open_pull_request", input: { repo: REPO, title: "Change", branch: "acp/change", files: [{ path: "src/b.ts", content: "b" }] } });
const blocked = JSON.stringify({ final: "Checks still fail.", status: "blocked" });

test("a blocked task that opened a pull request stays In Progress, so Linear does not close the PR", async () => {
  const r = engineRig([openPr, blocked]);
  await tick(r.d);
  assert.ok(r.gh.writes.some((w) => w === `POST /repos/${REPO}/pulls`), "the PR was opened");
  assert.equal(r.store.issues[0]!.stateType, "started");
  assert.ok(!r.store.states.includes("canceled"));
  assert.match(r.lastResult(), /^## Result \(.+, blocked\)/);
  assert.match(r.lastResult(), /Left In Progress, not Canceled/);
  assert.ok(r.lastResult().includes(PR_URL));
  // In Progress is not picked up again: a second run does no work and spends nothing.
  const before = r.store.comments.get("i1")!.length;
  await tick(r.d);
  assert.equal(r.store.comments.get("i1")!.length, before);
});

test("running out of steps after opening a PR also leaves the task In Progress", async () => {
  const r = engineRig([openPr, "not json", "still not json"], { maxSteps: "3" });
  await tick(r.d);
  assert.equal(r.store.issues[0]!.stateType, "started");
  assert.match(r.lastResult(), /Stopped after 3 steps/);
  assert.ok(r.lastResult().includes(PR_URL));
});

test("a blocked task with no pull request is still Canceled, as before", async () => {
  const r = engineRig([JSON.stringify({ tool: "github.pr_checks", input: { repo: REPO, pr: 7 } }), blocked]);
  await tick(r.d);
  assert.equal(r.store.issues[0]!.stateType, "canceled");
  assert.doesNotMatch(r.lastResult(), /Left In Progress/);
});

test("a dry run's would-be PR is not a real PR, so a blocked dry run is Canceled", async () => {
  const r = engineRig([openPr, blocked], { dryRun: true });
  await tick(r.d);
  assert.equal(r.store.issues[0]!.stateType, "canceled");
});

test("a done task is still Completed", async () => {
  const r = engineRig([openPr, JSON.stringify({ final: `PR ${PR_URL}: ALL PASSED`, status: "done" })]);
  await tick(r.d);
  assert.equal(r.store.issues[0]!.stateType, "completed");
});
