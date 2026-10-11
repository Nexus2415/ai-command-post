// ARN-84: one deterministic, SYNTHETIC end-to-end lifecycle of the existing ACP path.
//
// What this is: the real `tick()` entry point, claim logic, budget and policy code driven by an in-memory store and
// scripted model stubs, with a fake clock. What this is NOT: no live Linear, provider, Gemini, Eve or network call is
// made, and nothing here shows that real agents or Eve are running. The "trace" is a logical record built from the
// store writes of this fixture; in production the durable record is the Linear comments those writes become.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle as eveHandle } from "../api/eve.js";
// @ts-ignore plain-JS module served by Vercel
import { lifecycleOf } from "../api/lib/command-lifecycle.js";
import { Budget, DEFAULT_RATES, type Rate } from "../src/budget.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { COMMAND_MARKER, EXECUTOR_MARKER, RECONCILED_MARKER, RESULT_MARKER, claimStatus, claimsOn, tick, type Deps, type TickReport } from "../src/orchestrator.ts";
import { decide } from "../src/policy.ts";
import type { ChatMessage, ModelClient } from "../src/providers.ts";

type Step = "claim" | "plan" | "analysis" | "challenge" | "retry" | "reconcile" | "terminated";
interface TraceEntry {
  seq: number;
  at: string;
  /** Identifier of the root command this entry belongs to. */
  command: string;
  issue: string;
  step: Step;
  /** Executor named by a claim (`acp:<agent>`), else null. */
  executor: string | null;
  /** Id of the store comment that carries this entry, else null. */
  commentId: string | null;
  outcome: string;
}

/** In-memory TaskStore that logs every write to a trace on a deterministic clock. */
class SyntheticStore implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { id: string; body: string; createdAt: string }[]>();
  trace: TraceEntry[] = [];
  writes = 0;
  private n = 0;
  private c = 0;
  private t = Date.UTC(2026, 9, 11, 18, 0, 0);
  now(): string {
    this.t += 1000;
    return new Date(this.t).toISOString();
  }
  add(p: Partial<Issue> & { title: string }): Issue {
    this.n++;
    const i: Issue = {
      id: `i${this.n}`, identifier: `SYN-${this.n}`, description: "", url: "", priority: 3, stateType: "unstarted", stateName: "Todo",
      labels: [], assignee: null, parentId: null, childIds: [], createdAt: this.now(), ...p,
    };
    this.issues.push(i);
    if (i.parentId) this.issues.find((x) => x.id === i.parentId)!.childIds.push(i.id);
    return i;
  }
  byId(id: string): Issue {
    return this.issues.find((i) => i.id === id)!;
  }
  private root(i: Issue): Issue {
    return i.parentId ? this.byId(i.parentId) : i;
  }
  log(i: Issue, step: Step, outcome: string, extra: { executor?: string; commentId?: string } = {}): void {
    this.trace.push({ seq: this.trace.length + 1, at: this.now(), command: this.root(i).identifier, issue: i.identifier, step, executor: extra.executor ?? null, commentId: extra.commentId ?? null, outcome });
  }
  async listOpenAndRecent() {
    return this.issues.map((i) => ({ ...i, childIds: [...i.childIds] }));
  }
  async getComments(id: string) {
    return [...(this.comments.get(id) ?? [])];
  }
  async createIssue(input: { title: string; description: string; parentId?: string; priority?: number }) {
    this.writes++;
    return this.add({ title: input.title, description: input.description, parentId: input.parentId ?? null, priority: input.priority ?? 0 });
  }
  async comment(id: string, body: string) {
    this.writes++;
    const issue = this.byId(id);
    const entry = { id: `c${++this.c}`, body, createdAt: this.now() };
    this.comments.set(id, [...(this.comments.get(id) ?? []), entry]);
    const claim = new RegExp(`^${EXECUTOR_MARKER}\\s*(\\S+)`, "m").exec(body);
    if (claim) return this.log(issue, "claim", "claimed", { executor: claim[1]!, commentId: entry.id });
    if (body.startsWith("**Plan from")) return this.log(issue, "plan", "planned", { commentId: entry.id });
    if (body.startsWith(RECONCILED_MARKER)) return this.log(issue, "reconcile", "reconciled", { commentId: entry.id });
    if (body.startsWith("ACP retry")) return this.log(issue, "retry", "requeued", { commentId: entry.id });
    const result = new RegExp(`^${RESULT_MARKER} \\(([^,)]+), (done|blocked)\\)`).exec(body);
    if (result) return this.log(issue, /challenge/i.test(issue.title) ? "challenge" : "analysis", result[2]!, { commentId: entry.id });
  }
  async setState(id: string, _team: string, type: StateType) {
    this.writes++;
    this.byId(id).stateType = type;
  }
}

const FREE: Record<AgentKey, Rate> = {
  claude: { inputPerM: 0, outputPerM: 0, freeTier: true },
  chatgpt: { inputPerM: 0, outputPerM: 0, freeTier: true },
  gemini: { inputPerM: 0, outputPerM: 0, freeTier: true },
  perplexity: { inputPerM: 0, outputPerM: 0, freeTier: true },
};

interface Call { agent: AgentKey; at: number }

/** Scripted stub: replays fixed replies; any call beyond the script throws, so an unexpected provider call fails the test. */
function stub(agent: AgentKey, replies: (string | Error)[], calls: Call[]): ModelClient {
  return {
    async chat(_messages: ChatMessage[]) {
      calls.push({ agent, at: calls.length + 1 });
      const next = replies.shift();
      if (next === undefined) throw new Error(`unexpected ${agent} model call`);
      if (next instanceof Error) throw next;
      return { text: next, inputTokens: 100, outputTokens: 50 };
    },
  };
}

const PLAN = JSON.stringify({
  summary: "SYNTHETIC plan: one analysis, one independent challenge.",
  tasks: [
    { agent: "claude", title: "SYNTHETIC analysis of a fictional scheduling exception", description: "Fictional input only." },
    { agent: "chatgpt", title: "SYNTHETIC challenge of the analysis", description: "Fictional input only." },
  ],
});
const DONE = JSON.stringify({ final: "SYNTHETIC result, no sources.", status: "done" });

interface World {
  store: SyntheticStore;
  calls: Call[];
  budget: Budget;
  cmd: Issue;
  env: Record<string, string>;
  deps: () => Deps;
  fetchCalls: number;
  run: () => Promise<TickReport>;
}

/** A command, stub clients and a tick runner. `scripts` overrides what each stub replies. The fixture is single-executor. */
function world(scripts: Partial<Record<AgentKey, (string | Error)[]>> = {}, opts: { rates?: Record<AgentKey, Rate>; env?: Record<string, string> } = {}): World {
  const store = new SyntheticStore();
  const calls: Call[] = [];
  const cmd = store.add({ title: "[Claude] SYNTHETIC: assess a fictional scheduling exception", description: `Fictional input.\n\n${COMMAND_MARKER}` });
  const env = { ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ACP_DEFAULT_LEAD: "claude", ...opts.env };
  const budget = new Budget({ capUsd: loadConfig(env).monthlyBudgetUsd, path: null, rates: opts.rates ?? FREE });
  const clients: Partial<Record<AgentKey, ModelClient>> = {
    claude: stub("claude", scripts.claude ?? [PLAN, DONE, "SYNTHETIC reconciliation."], calls),
    chatgpt: stub("chatgpt", scripts.chatgpt ?? [DONE], calls),
  };
  const w: World = {
    store, calls, budget, cmd, env, fetchCalls: 0,
    deps: () => ({
      cfg: loadConfig(w.env), store, clients, budget,
      // No tokens are configured, so no tool that needs the network is offered to a worker.
      toolEnv: (issue) => ({ dryRun: false, policy: { allowPullRequests: false, allowedRepos: [] }, comment: (b) => store.comment(issue.id, b), requestApproval: (r) => store.comment(issue.id, `APPROVAL: ${r}`) }),
    }),
    // Each run re-reads the environment, as each scheduled engine run does. Flipping w.env between runs is the synthetic kill switch.
    async run() {
      const report = await tick(w.deps());
      if (!report.active) store.log(cmd, "terminated", report.waiting[0] ?? "engine off");
      return report;
    },
  };
  return w;
}

/** Runs `fn` with the global network call turned into a throw, and asserts nothing reached it. */
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (() => { attempts++; throw new Error("network call in a synthetic test"); }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    assert.equal(attempts, 0, "no network call may be attempted");
  }
}

const perIssueClaims = (s: SyntheticStore): TraceEntry[][] => {
  const by = new Map<string, TraceEntry[]>();
  for (const t of s.trace.filter((x) => x.step === "claim")) by.set(t.issue, [...(by.get(t.issue) ?? []), t]);
  return [...by.values()];
};
const steps = (s: SyntheticStore) => s.trace.map((t) => t.step);
const claims = (s: SyntheticStore) => s.trace.filter((t) => t.step === "claim");

test("SYNTHETIC lifecycle: claim, analysis, distinct-lane challenge, reconciliation, result trace, in order", async () => {
  await offline(async () => {
    const w = world();
    const r1 = await w.run(); // plan
    const r2 = await w.run(); // both sub-tasks (one task per agent per run)
    const r3 = await w.run(); // reconcile
    await w.run(); // nothing left to do
    assert.deepEqual([r1.planned.length, r2.worked.length, r3.reconciled], [1, 2, [w.cmd.identifier]]);
    assert.deepEqual(r1.errors.concat(r2.errors, r3.errors), []);

    assert.deepEqual(steps(w.store), ["claim", "plan", "claim", "analysis", "claim", "challenge", "reconcile"]);
    // Every entry relates to the one command, carries a timestamp and outcome, and rises strictly in time.
    for (const [i, t] of w.store.trace.entries()) {
      assert.equal(t.command, w.cmd.identifier);
      assert.equal(t.seq, i + 1);
      assert.ok(t.outcome);
      assert.ok(i === 0 || t.at > w.store.trace[i - 1]!.at);
    }
    // Stable ids: each claim, result and summary is a store comment with its own id.
    const ids = w.store.trace.filter((t) => t.commentId).map((t) => t.commentId);
    assert.equal(new Set(ids).size, ids.length);
    // Exactly one claim per issue, held by one executor, and the two lanes are different executors.
    assert.ok(perIssueClaims(w.store).every((v) => v.length === 1), "one claim per issue");
    const lane = (step: Step) => claims(w.store).find((t) => t.issue === w.store.trace.find((x) => x.step === step)!.issue)!.executor;
    assert.deepEqual([lane("analysis"), lane("challenge")], ["acp:claude", "acp:chatgpt"]);
    // Model calls: plan + analysis + challenge + reconcile, each by its scripted stub and nothing else.
    assert.deepEqual(w.calls.map((c) => c.agent), ["claude", "claude", "chatgpt", "claude"]);
    // End state, read the way the console reads it (lifecycleOf over the recorded comments).
    assert.equal(w.store.byId(w.cmd.id).stateType, "completed");
    const view = lifecycleOf(
      { identifier: w.cmd.identifier, title: w.cmd.title, description: w.cmd.description, state: { type: "completed", name: "Done" }, labels: [] },
      w.store.comments.get(w.cmd.id)!,
      w.cmd.childIds.map((id) => ({ identifier: w.store.byId(id).identifier, state: { type: w.store.byId(id).stateType } })),
      { childrenComplete: true, commentsComplete: true },
    );
    assert.equal(view?.stage, "completed");
    assert.equal(w.budget.spentUsd(), 0);
  });
});

test("SYNTHETIC lifecycle: a retry or re-run never double-claims or re-executes (single-executor fixture)", async () => {
  await offline(async () => {
    const transient = Object.assign(new Error("timeout"), { status: 0 });
    // The analysis call fails once before any tool ran: the task is requeued, then succeeds on the next run.
    const w = world({ claude: [PLAN, transient, DONE, "SYNTHETIC reconciliation."] });
    await w.run();
    const r2 = await w.run();
    assert.ok(r2.waiting.some((x) => x.includes("provider/model call failed")));
    await w.run(); // analysis retried
    await w.run(); // reconcile
    const before = [w.calls.length, w.store.writes];
    await w.run();
    await w.run();
    assert.deepEqual([w.calls.length, w.store.writes], before, "completed work is never re-run or rewritten");
    assert.ok(perIssueClaims(w.store).every((v) => v.length === 1), "retry reuses the original claim");
    assert.equal(steps(w.store).filter((s) => s === "retry").length, 1);
    assert.equal(steps(w.store).filter((s) => s === "reconcile").length, 1);
    assert.equal(w.store.byId(w.cmd.id).stateType, "completed");
  });
});

test("SYNTHETIC lifecycle: a second claimant is refused; the earliest claim wins", async () => {
  await offline(async () => {
    const w = world();
    await w.run(); // plan
    const analysis = w.store.issues.find((i) => /analysis/.test(i.title))!;
    // A different executor claims the analysis task first. ACP must not run it.
    await w.store.comment(analysis.id, `${EXECUTOR_MARKER} manual`);
    const r = await w.run();
    assert.ok(r.waiting.some((x) => x.includes(analysis.identifier) && x.includes("claimed by another executor")));
    assert.equal(w.calls.filter((c) => c.agent === "claude").length, 1, "only the plan call; analysis never ran");
    assert.equal(w.store.byId(analysis.id).stateType, "unstarted");
    const winner = claimsOn([], w.store.comments.get(analysis.id)!);
    assert.equal(claimStatus(winner, "claude"), "foreign");
    assert.equal(claimStatus(winner, "chatgpt"), "foreign");
  });
});

// ARN-52 states this limit and nothing here closes it: a Linear comment is not an atomic lock. Left as `todo` so it
// shows in the report as unproven instead of being silently skipped or claimed safe. Needs a DB-level claim store.
test("UNPROVEN cross-engine atomicity: two engines racing on one task execute it once", { todo: "BLOCKED: Linear comments are not an atomic claim; needs a DB-level claim store (ARN-62/65 follow-up)" }, async () => {
  const w = world({ claude: [PLAN, DONE, "x"], chatgpt: [DONE] });
  await w.run(); // plan
  // Two engines read the claims of every task before either writes.
  const store = w.store;
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const orig = store.getComments.bind(store);
  store.getComments = async (id: string) => {
    const snapshot = await orig(id);
    if (++reads === 2) release();
    await gate;
    return snapshot;
  };
  const before = w.calls.length;
  await Promise.all([tick(w.deps()), tick(w.deps())]);
  assert.equal(w.calls.length - before, 2, "analysis and challenge each executed exactly once across both engines");
});

test("SYNTHETIC halt: ACP_ACTIVE=false between runs stops the next step, records termination, and has no side effects", async () => {
  for (const stopAfter of ["plan", "work"] as const) {
    await offline(async () => {
      const w = world();
      await w.run(); // plan
      if (stopAfter === "work") await w.run(); // analysis + challenge done, reconciliation still pending
      const calls = w.calls.length;
      const writes = w.store.writes;
      const seen = steps(w.store).length;

      w.env = { ...w.env, ACP_ACTIVE: "false" }; // synthetic kill switch
      const r = await w.run();
      assert.equal(r.active, false);
      assert.deepEqual([r.planned, r.worked, r.reconciled], [[], [], []]);
      assert.match(r.waiting[0]!, /Engine is off \(ACP_ACTIVE=false\)/);
      assert.equal(w.calls.length, calls, "zero provider calls after the stop");
      assert.equal(w.store.writes, writes, "zero store writes after the stop");
      const after = w.store.trace.slice(seen);
      assert.deepEqual(after.map((t) => t.step), ["terminated"], "the only new trace entry is the termination");
      assert.equal(after[0]!.command, w.cmd.identifier);
      assert.notEqual(w.store.byId(w.cmd.id).stateType, "completed");

      // Turning it back on resumes without a second claim on anything already claimed.
      w.env = { ...w.env, ACP_ACTIVE: "true" };
      await w.run();
      await w.run();
      assert.ok(perIssueClaims(w.store).every((v) => v.length === 1));
      assert.equal(w.store.byId(w.cmd.id).stateType, "completed");
    });
  }
});

test("SYNTHETIC halt: a missing ACP_ACTIVE defaults to off", async () => {
  await offline(async () => {
    const w = world({}, { env: { ACP_ACTIVE: "" } });
    const r = await w.run();
    assert.equal(r.active, false);
    assert.equal(w.calls.length, 0);
    assert.equal(w.store.writes, 0);
    assert.deepEqual(steps(w.store), ["terminated"]);
  });
});

test("SYNTHETIC fail closed: a missing result trace is never read as completed", () => {
  const issue = { identifier: "SYN-1", title: "[Claude] SYNTHETIC", description: COMMAND_MARKER, state: { type: "completed", name: "Done" }, labels: [] as string[] };
  const complete = { childrenComplete: true, commentsComplete: true };
  assert.equal(lifecycleOf(issue, [], [], complete)?.stage, "unknown", "Done with no recorded result");
  assert.equal(lifecycleOf(issue, null, [], complete)?.stage, "unknown", "comments unreadable");
  const withSummary = [{ id: "s", body: `${RECONCILED_MARKER} (Claude)\n\nok`, createdAt: "2026-10-11T18:00:00Z" }];
  assert.equal(lifecycleOf(issue, withSummary, [], { childrenComplete: true, commentsComplete: false })?.stage, "unknown", "older comments not loaded");
  assert.equal(lifecycleOf(issue, withSummary, [], complete)?.stage, "completed");
});

test("SYNTHETIC fail closed: an unknown or unavailable tool is refused and nothing runs", async () => {
  const ctx = { allowPullRequests: false, allowedRepos: [] };
  for (const tool of ["slack.post_message", "github.merge_pull_request", "vercel.deploy", ""]) {
    const d = decide(tool, {}, ctx);
    assert.equal(d.allow, false, tool);
    assert.equal(d.tier, "red", tool);
  }
  await offline(async () => {
    const attempt = JSON.stringify({ tool: "github.merge_pull_request", input: { repo: "acme/app", number: 1 } });
    const blocked = JSON.stringify({ final: "SYNTHETIC: tool refused, stopping.", status: "blocked" });
    const w = world({ claude: [PLAN, attempt, blocked, "SYNTHETIC reconciliation."] });
    await w.run();
    await w.run();
    const analysis = w.store.issues.find((i) => /analysis/.test(i.title))!;
    assert.equal(w.store.byId(analysis.id).stateType, "canceled", "blocked, never completed");
    assert.ok(w.store.trace.some((t) => t.step === "analysis" && t.outcome === "blocked"));
  });
});

test("SYNTHETIC budget: $0 refuses every paid path with no provider call and no stale claim", async () => {
  await offline(async () => {
    // Real default rates: claude and chatgpt have no free tier, so a $0 cap refuses them.
    const w = world({}, { rates: DEFAULT_RATES });
    assert.equal(w.budget.capUsd, 0);
    for (const agent of ["claude", "chatgpt", "perplexity"] as const) {
      const c = w.budget.check(agent, 10, 10);
      assert.equal(c.ok, false, agent);
    }
    assert.equal(w.budget.check("gemini", 10, 10).ok, true, "the free tier stays allowed; no Gemini call is made here");
    const r = await w.run();
    assert.equal(w.calls.length, 0, "no stub was called");
    assert.equal(w.store.writes, 0, "no claim, plan or state change was written");
    assert.deepEqual(r.planned, []);
    assert.ok(r.waiting.some((x) => x.includes("cannot plan") && x.includes("monthly cap is $0")));
    assert.equal(w.budget.spentUsd(), 0);
  });
});

test("SYNTHETIC Eve: dispatch stays disabled (503) with defaults and unsupported even when fully configured; nothing is sent", async () => {
  let sent = 0;
  const f = (async () => { sent++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const headers = { "x-acp-password": "pw", origin: "https://acp.test", host: "acp.test", "sec-fetch-site": "same-origin" };
  const body = { action: "dispatch", intent: "command", text: "SYNTHETIC", idempotencyKey: "abcdefghij0123456789" };
  const req = { method: "POST", headers, body };
  const defaults = await eveHandle(req, { ACP_SITE_PASSWORD: "pw" }, f);
  assert.equal(defaults.status, 503);
  assert.equal((defaults.body as any).status, "disabled");
  // Even with every gate open (fake values only), dispatch is unsupported rather than sent.
  const open = { ACP_SITE_PASSWORD: "pw", ACP_EVE_ACTIVE: "true", ACP_EVE_BUDGET_USD: "5", EVE_BASE_URL: "https://eve.test", EVE_TOKEN: "synthetic-not-a-secret" };
  const configured = await eveHandle(req, open, f);
  assert.equal(configured.status, 503);
  assert.equal((configured.body as any).status, "unsupported");
  assert.equal(sent, 0);
});
