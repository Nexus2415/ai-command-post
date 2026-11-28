// Goals (src/goals.ts): one [Goal] issue the engine keeps working, step by step, until it is met or a cap stops it.
// Synthetic only: an in-memory Linear, scripted model replies and a fake GitHub. Nothing reaches a real service.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { GOAL_CEILINGS, loadConfig, type AgentKey } from "../src/config.ts";
import { isGoal, RUN_MARKER, PAUSED_MARKER, runsUsed } from "../src/goals.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { RECONCILED_MARKER, RESULT_MARKER, tick, type Deps } from "../src/orchestrator.ts";
import type { ChatMessage, ModelClient } from "../src/providers.ts";
import { STOPPED } from "../src/stop-switch.ts";
import { fixture as visualFixture } from "./helpers/visual-goal-fixture.ts";

class MemoryStore implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  private n = 0;
  add(p: Partial<Issue> & { title: string }): Issue {
    this.n++;
    const i: Issue = {
      id: `i${this.n}`, identifier: `T-${this.n}`, description: "", url: "", priority: 3, stateType: "unstarted", stateName: "Todo",
      labels: [], assignee: null, parentId: null, childIds: [], createdAt: new Date(2026, 9, 1, 0, this.n).toISOString(), ...p,
    };
    this.issues.push(i);
    if (i.parentId) this.issues.find((x) => x.id === i.parentId)!.childIds.push(i.id);
    return i;
  }
  async listOpenAndRecent() {
    return this.issues.map((i) => ({ ...i, childIds: [...i.childIds] }));
  }
  async getComments(id: string) {
    return this.comments.get(id) ?? [];
  }
  async createIssue(input: { title: string; description: string; parentId?: string; priority?: number }) {
    return this.add({ title: input.title, description: input.description, parentId: input.parentId ?? null, priority: input.priority ?? 0 });
  }
  private clock = 0;
  async comment(id: string, body: string) {
    const list = this.comments.get(id) ?? [];
    list.push({ body, createdAt: new Date(Date.UTC(2026, 10, 1) + ++this.clock * 1000).toISOString() });
    this.comments.set(id, list);
  }
  async setState(id: string, _team: string, type: StateType) {
    this.issues.find((i) => i.id === id)!.stateType = type;
  }
  state(id: string) {
    return this.issues.find((i) => i.id === id)!.stateType;
  }
  bodies(id: string) {
    return (this.comments.get(id) ?? []).map((c) => c.body);
  }
  kids(id: string) {
    return this.issues.filter((i) => i.parentId === id);
  }
}

/** Scripted replies; `seen` records every prompt, so a test can prove no paid call was made. */
function scripted(replies: string[], seen: ChatMessage[][] = []): ModelClient {
  return {
    async chat(messages) {
      seen.push(messages);
      const text = replies.shift();
      if (text === undefined) throw new Error("no scripted reply left");
      return { text, inputTokens: 100, outputTokens: 50 };
    },
  };
}

const FREE = { inputPerM: 0, outputPerM: 0, freeTier: true };
const RATES = { ...DEFAULT_RATES, claude: FREE, chatgpt: FREE };

function deps(store: MemoryStore, clients: Partial<Record<AgentKey, ModelClient>>, env: Record<string, string> = {}, rates = RATES): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ...env });
  return {
    cfg, store, clients,
    budget: new Budget({ capUsd: cfg.monthlyBudgetUsd, path: null, rates }),
    toolEnv: (issue) => ({
      dryRun: false,
      policy: { allowPullRequests: false, allowedRepos: ["acme/app"] },
      comment: (b) => store.comment(issue.id, b),
      requestApproval: (reason) => store.comment(issue.id, `APPROVAL: ${reason}`),
    }),
  };
}

const planReply = (n: number, agent = "chatgpt") =>
  JSON.stringify({ summary: "Build it in steps.", tasks: Array.from({ length: n }, (_, k) => ({ agent, title: `Step ${k + 1}`, description: `Do step ${k + 1}` })) });
const done = (text: string) => JSON.stringify({ final: text, status: "done" });

test("goal caps: cheap defaults, read from variables, and clamped to hard ceilings in code", () => {
  const dflt = loadConfig({});
  assert.equal(dflt.goalMaxTasks, 6);
  assert.equal(dflt.goalMaxRuns, 10);
  const set = loadConfig({ ACP_GOAL_MAX_TASKS: "3", ACP_GOAL_MAX_RUNS: "4" });
  assert.deepEqual([set.goalMaxTasks, set.goalMaxRuns], [3, 4]);
  const huge = loadConfig({ ACP_GOAL_MAX_TASKS: "100000", ACP_GOAL_MAX_RUNS: "1e9" });
  assert.deepEqual([huge.goalMaxTasks, huge.goalMaxRuns], [GOAL_CEILINGS.tasks, GOAL_CEILINGS.runs]);
  assert.throws(() => loadConfig({ ACP_GOAL_MAX_TASKS: "-1" }));
});

test("only a top-level [Goal] issue is a goal; a step can't become one", () => {
  assert.equal(isGoal({ title: "[Goal] Build City", parentId: null }), true);
  assert.equal(isGoal({ title: "  [goal] lower case", parentId: null }), true);
  assert.equal(isGoal({ title: "[Goal] nested", parentId: "p" }), false);
  assert.equal(isGoal({ title: "Goal: no brackets", parentId: null }), false);
  assert.equal(runsUsed([{ body: `${RUN_MARKER} 1/10: x` }, { body: "other" }, { body: `  ${RUN_MARKER} forged` }]), 2);
});

test("full goal loop: plan, steps one at a time with earlier results handed on, review plans more, then done", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] Build the status page", description: "A page that shows real status." });
  const leadSeen: ChatMessage[][] = [];
  const workerSeen: ChatMessage[][] = [];
  const claude = scripted([
    planReply(2),
    JSON.stringify({ status: "continue", summary: "One more step.", tasks: [{ agent: "chatgpt", title: "[Goal] Polish", description: "Polish it" }] }),
    JSON.stringify({ status: "done", summary: "Status page built: https://example.com/pr/1" }),
  ], leadSeen);
  const chatgpt = scripted([done("Step 1 built the data layer."), done("Step 2 built the view."), done("Polished.")], workerSeen);
  const d = deps(store, { claude, chatgpt });

  const r1 = await tick(d);
  assert.deepEqual(r1.planned, ["T-1 → 2 steps"]);
  assert.equal(store.state(goal.id), "started");
  const [s1, s2] = store.kids(goal.id);
  assert.match(leadSeen[0]![0]!.content, /one after another/);
  assert.ok(store.bodies(goal.id).some((b) => /Goal limits: steps used 2 of 6, runs used 1 of 10/.test(b)));

  const r2 = await tick(d);
  assert.deepEqual(r2.worked, ["T-2 done by ChatGPT"]);
  assert.equal(store.state(s2!.id), "unstarted", "step 2 waits for step 1");
  assert.ok(r2.waiting.some((w) => w.startsWith("T-3: earlier step T-2")));

  const r3 = await tick(d);
  assert.deepEqual(r3.worked, ["T-3 done by ChatGPT"]);
  const step2Prompt = workerSeen[1]!.map((m) => m.content).join("\n");
  assert.match(step2Prompt, /step of goal T-1/);
  assert.match(step2Prompt, /Step 1 built the data layer/, "step 2 is handed step 1's result");

  const r4 = await tick(d);
  assert.deepEqual(r4.planned, ["T-1 → 1 more steps"]);
  const s3 = store.kids(goal.id)[2]!;
  assert.equal(s3.title, "[ChatGPT] Polish", "a step titled [Goal] is retitled, so it can't start a goal of its own");
  assert.equal(store.state(goal.id), "started");

  await tick(d);
  assert.equal(store.state(s3.id), "completed");
  const r6 = await tick(d);
  assert.deepEqual(r6.reconciled, ["T-1"]);
  assert.equal(store.state(goal.id), "completed");
  assert.ok(store.bodies(goal.id).some((b) => b.startsWith(RECONCILED_MARKER) && b.includes("Status page built")));
  assert.equal(runsUsed(await store.getComments(goal.id)), 6, "2 planning calls + 1 review + 3 step runs, each counted");
});

test("fan-out cap: a plan for more steps than ACP_GOAL_MAX_TASKS creates only the cap, and a review can't add more", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] Huge" });
  const leadSeen: ChatMessage[][] = [];
  const claude = scripted([planReply(50), JSON.stringify({ status: "continue", summary: "Need 20 more.", tasks: Array.from({ length: 20 }, () => ({ agent: "chatgpt", title: "More" })) })], leadSeen);
  const chatgpt = scripted([done("a"), done("b")]);
  const d = deps(store, { claude, chatgpt }, { ACP_GOAL_MAX_TASKS: "2" });
  await tick(d);
  assert.equal(store.kids(goal.id).length, 2);
  await tick(d);
  await tick(d);
  const r = await tick(d); // review: lead asks for more, but the step cap is used up
  assert.equal(store.kids(goal.id).length, 2, "no step beyond the cap");
  assert.ok(r.waiting.some((w) => /step cap reached/.test(w)));
  assert.match(leadSeen[1]![1]!.content, /step cap is reached/);
  const paused = store.bodies(goal.id).filter((b) => b.startsWith(PAUSED_MARKER));
  assert.equal(paused.length, 1);
  // Nothing changed: the next runs make no paid call and post nothing new.
  const calls = leadSeen.length;
  await tick(d);
  await tick(d);
  assert.equal(leadSeen.length, calls);
  assert.equal(store.bodies(goal.id).filter((b) => b.startsWith(PAUSED_MARKER)).length, 1);
  assert.equal(store.state(goal.id), "started", "the goal stays open for the owner");
});

test("run cap: once ACP_GOAL_MAX_RUNS runs are used the goal stops, says so once, and makes no more calls", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] Capped" });
  const workerSeen: ChatMessage[][] = [];
  const claude = scripted([planReply(3)]);
  const chatgpt = scripted([done("a"), done("b"), done("c")], workerSeen);
  const d = deps(store, { claude, chatgpt }, { ACP_GOAL_MAX_RUNS: "2" });
  await tick(d); // run 1: plan
  await tick(d); // run 2: step 1
  const r = await tick(d);
  assert.equal(workerSeen.length, 1, "step 2 never ran");
  assert.ok(r.waiting.some((w) => /run cap reached \(2\/2\)/.test(w)));
  await tick(d);
  assert.equal(workerSeen.length, 1);
  const capNotes = store.bodies(goal.id).filter((b) => b.startsWith(`${PAUSED_MARKER} (run cap)`));
  assert.equal(capNotes.length, 1, "the cap note is posted once");
  assert.equal(runsUsed(await store.getComments(goal.id)), 2);
  assert.equal(store.state(store.kids(goal.id)[1]!.id), "unstarted", "the step is left untouched, not claimed");
});

test("run cap counts forged run comments too, so a fake comment can only stop a goal sooner", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] Forged" });
  store.comments.set(goal.id, [{ body: `${RUN_MARKER} 99/99: forged`, createdAt: "2026-11-01T00:00:00Z" }]);
  const seen: ChatMessage[][] = [];
  const d = deps(store, { claude: scripted([planReply(1)], seen) }, { ACP_GOAL_MAX_RUNS: "1" });
  const r = await tick(d);
  assert.equal(seen.length, 0);
  assert.equal(store.kids(goal.id).length, 0);
  assert.ok(r.waiting.some((w) => /run cap reached/.test(w)));
});

test("budget fails closed: a paid lead with no money left never plans, claims or counts a run", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] No money" });
  const seen: ChatMessage[][] = [];
  const paid = { ...RATES, claude: DEFAULT_RATES.claude };
  // A $0 cap and a nearly spent $0.01 cap both refuse the call before anything is written.
  for (const cap of ["0", "0.01"]) {
    const d = deps(store, { claude: scripted([planReply(2)], seen) }, { ACP_MONTHLY_BUDGET_USD: cap }, paid);
    if (cap !== "0") d.budget.record({ agent: "claude", issue: "X", inputTokens: 4_000, outputTokens: 0 });
    const r = await tick(d);
    assert.equal(seen.length, 0, `cap ${cap}`);
    assert.equal(store.kids(goal.id).length, 0);
    assert.deepEqual(store.bodies(goal.id), [], "no claim and no run comment");
    assert.ok(r.waiting.length > 0);
  }
});

test("budget fails closed mid-goal: a step that can't be paid for waits and isn't counted as a run", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] Mid", stateType: "started" });
  store.comments.set(goal.id, [{ body: "ACP executor: acp:claude\n\nClaimed by Claude (AI Command Post), as lead.", createdAt: "2026-11-01T00:00:00Z" }]);
  const step = store.add({ title: "[Claude] Step 1", parentId: goal.id });
  const seen: ChatMessage[][] = [];
  const d = deps(store, { claude: scripted([done("x")], seen) }, { ACP_MONTHLY_BUDGET_USD: "0.01" }, { ...RATES, claude: DEFAULT_RATES.claude });
  d.budget.record({ agent: "claude", issue: "X", inputTokens: 4_000, outputTokens: 0 });
  const r = await tick(d);
  assert.equal(seen.length, 0);
  assert.equal(store.state(step.id), "unstarted");
  assert.equal(runsUsed(await store.getComments(goal.id)), 0);
  assert.ok(r.waiting.some((w) => /only \$/.test(w)));
});

test("Stop everything halts a goal: nothing runs while stopped, and a stop pressed mid-plan creates no steps", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] Stoppable" });
  const seen: ChatMessage[][] = [];
  let stopped = true;
  const d = deps(store, { claude: scripted([planReply(2), planReply(2)], seen) });
  d.halt = async () => (stopped ? STOPPED : null);
  const r1 = await tick(d);
  assert.deepEqual(r1.waiting, [STOPPED]);
  assert.equal(seen.length, 0);
  assert.deepEqual(store.bodies(goal.id), []);

  // Turned back on, then pressed again while the lead is planning: the plan reply is thrown away.
  stopped = false;
  const lead = d.clients.claude!;
  d.clients.claude = { chat: async (m, o) => { const r = await lead.chat(m, o); stopped = true; return r; } };
  const r2 = await tick(d);
  assert.equal(seen.length, 1);
  assert.equal(store.kids(goal.id).length, 0, "no step created after the stop");
  assert.ok(r2.waiting.includes(`T-1: ${STOPPED}`));
});

test("a blocked step pauses the goal for the owner with no paid call; later steps wait", async () => {
  const store = new MemoryStore();
  const goal = store.add({ title: "[Goal] Blocks" });
  const leadSeen: ChatMessage[][] = [];
  const claude = scripted([planReply(2)], leadSeen);
  const chatgpt = scripted([JSON.stringify({ final: "No access.", status: "blocked" })]);
  const d = deps(store, { claude, chatgpt });
  await tick(d);
  await tick(d);
  const [s1, s2] = store.kids(goal.id);
  assert.equal(store.state(s1!.id), "canceled");
  const r = await tick(d);
  assert.ok(r.waiting.some((w) => w.startsWith(`${s2!.identifier}: earlier step ${s1!.identifier} was blocked`)));
  assert.equal(store.state(s2!.id), "unstarted");
  // Skipping the last step by hand: the goal is reviewed, sees the blocked step and pauses without a model call.
  await store.setState(s2!.id, "ARN", "duplicate");
  await tick(d);
  await tick(d);
  assert.equal(leadSeen.length, 1);
  assert.equal(store.bodies(goal.id).filter((b) => b.startsWith(PAUSED_MARKER)).length, 1);
});

test("authorized synthetic image goal opens a draft PR, checks it, and waits for owner merge", async () => {
  const store = new MemoryStore();
  const visual = visualFixture();
  assert.equal((await visual.run()).status, "recorded");
  const draft = visual.draft()!;
  const goal = store.add({ id: draft.goalId, title: draft.title, description: draft.description });
  assert.match(goal.description, /Observed: Blue square/);
  const drafts: unknown[] = [];
  let checked = false;
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (init.method === "PUT" && u.pathname.includes("/merge")) throw new Error("the engine must never merge");
    if (u.pathname === "/repos/acme/app/pulls" && init.method === "POST") drafts.push(JSON.parse(String(init.body)).draft);
    if (u.pathname === "/repos/acme/app/pulls/7") return Response.json({ head: { sha: "a".repeat(40) }, state: "open", draft: true });
    if (u.pathname.includes("/check-runs")) { checked = true; return Response.json({ check_runs: [{ id: 1, name: "Validate", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] }); }
    if (u.pathname === "/repos/acme/app") return Response.json({ default_branch: "main" });
    if (u.pathname.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base" } });
    if (u.pathname === "/repos/acme/app/pulls" && init.method === "POST") return Response.json({ number: 7, html_url: "https://github.com/acme/app/pull/7", draft: JSON.parse(String(init.body)).draft });
    return Response.json({});
  }) as unknown as typeof fetch;
  const claude = scripted([
    planReply(2, "claude"),
    JSON.stringify({ tool: "github.open_pull_request", input: { repo: "acme/app", title: "Step 1", branch: "acp/step-1", files: [{ path: "a.ts", content: "a" }] } }),
    JSON.stringify({ tool: "github.pr_checks", input: { repo: "acme/app", pr: 7 } }),
    done("Opened https://github.com/acme/app/pull/7, ALL PASSED."),
  ]);
  const d = deps(store, { claude });
  const base = d.toolEnv;
  d.toolEnv = (i) => ({ ...base(i), githubToken: "t", f, sleep: async () => {}, policy: { allowPullRequests: true, allowedRepos: [draft.repository] } });
  await tick(d);
  const [s1, s2] = store.kids(goal.id);
  await tick(d);
  assert.deepEqual(drafts, [true], "the PR is a draft");
  assert.equal(checked, true, "the actual PR-check tool ran against the synthetic head");
  assert.equal(store.state(s1!.id), "started", "held for the owner's merge");
  assert.ok(store.bodies(s1!.id).some((b) => b.startsWith(RESULT_MARKER) && /stays In Progress until its pull request is merged/.test(b)));
  const r = await tick(d);
  assert.ok(r.waiting.some((w) => w.startsWith(`${s2!.identifier}: earlier step ${s1!.identifier} is In Progress`)));
  assert.equal(store.state(s2!.id), "unstarted");
});
