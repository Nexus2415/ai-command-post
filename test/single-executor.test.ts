import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFor } from "../src/agents.ts";
import { Budget } from "../src/budget.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { COMMAND_MARKER, EXECUTOR_MARKER, RECONCILED_MARKER, RESULT_MARKER, claimStatus, claimsOn, tick, type Deps } from "../src/orchestrator.ts";
import type { ChatMessage, ModelClient } from "../src/providers.ts";

// Fakes only (copied from engine.test.ts so this file stays independent).
class MemoryStore implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  private n = 0;
  add(p: Partial<Issue> & { title: string }): Issue {
    this.n++;
    const i: Issue = {
      id: `i${this.n}`,
      identifier: `T-${this.n}`,
      description: "",
      url: "",
      priority: 3,
      stateType: "unstarted",
      stateName: "Todo",
      labels: [],
      assignee: null,
      parentId: null,
      childIds: [],
      createdAt: new Date(2026, 9, 1, 0, this.n).toISOString(),
      ...p,
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
  labelOverride = new Map<string, string[]>();
  async getLabels(id: string) {
    return this.labelOverride.get(id) ?? this.issues.find((i) => i.id === id)?.labels ?? [];
  }
  async createIssue(input: { title: string; description: string; parentId?: string; priority?: number }) {
    return this.add({ title: input.title, description: input.description, parentId: input.parentId ?? null, priority: input.priority ?? 0 });
  }
  async comment(id: string, body: string) {
    const list = this.comments.get(id) ?? [];
    list.push({ body, createdAt: new Date().toISOString() });
    this.comments.set(id, list);
  }
  async setState(id: string, _team: string, type: StateType) {
    this.issues.find((i) => i.id === id)!.stateType = type;
  }
}

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

function deps(store: MemoryStore, clients: Partial<Record<AgentKey, ModelClient>>, env: Record<string, string> = {}): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ...env });
  return {
    cfg,
    store,
    clients,
    budget: new Budget({ capUsd: cfg.monthlyBudgetUsd, path: null }),
    toolEnv: (issue) => ({
      dryRun: false,
      policy: { allowPullRequests: false, allowedRepos: ["acme/app"] },
      comment: (b) => store.comment(issue.id, b),
      requestApproval: (reason) => store.comment(issue.id, `APPROVAL: ${reason}`),
    }),
  };
}

const freeRates = {
  claude: { inputPerM: 0, outputPerM: 0, freeTier: true },
  chatgpt: { inputPerM: 0, outputPerM: 0, freeTier: true },
  gemini: { inputPerM: 0, outputPerM: 0, freeTier: true },
  perplexity: { inputPerM: 0, outputPerM: 0, freeTier: true },
};


const done = JSON.stringify({ final: "ok", status: "done" });
const blocked = JSON.stringify({ final: "cannot", status: "blocked" });
const claimsFor = (s: MemoryStore, id: string) => (s.comments.get(id) ?? []).filter((c) => c.body.startsWith(EXECUTOR_MARKER));

test("ACP records one executor claim and never double-claims on re-runs", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[Gemini] check docs" });
  // First run: provider fails transiently, task returns to Todo.
  const flaky: ModelClient = { async chat() { throw new Error("timeout"); } };
  await tick(deps(store, { gemini: flaky }));
  assert.equal(store.issues[0]!.stateType, "unstarted");
  // Second run picks it up again and finishes.
  await tick(deps(store, { gemini: scripted([done]) }));
  assert.equal(store.issues[0]!.stateType, "completed");
  const claims = claimsFor(store, t.id);
  assert.equal(claims.length, 1, "exactly one claim across re-runs");
  assert.match(claims[0]!.body, /acp:gemini/);
});

test("an issue claimed by a foreign executor (manual) is skipped", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[Gemini] check docs" });
  await store.comment(t.id, `${EXECUTOR_MARKER} manual`);
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { gemini: scripted([done], seen) }));
  assert.equal(seen.length, 0, "model never called");
  assert.equal(store.issues[0]!.stateType, "unstarted");
  assert.equal(claimsFor(store, t.id).length, 1);
  assert.ok(r.waiting.some((w) => w.includes("another executor")));
});

test("an Eve-claimed issue (comment or label) is never run by ACP, and Eve is never treated as having executed", async () => {
  for (const setup of ["comment", "label"] as const) {
    const store = new MemoryStore();
    const t = store.add({ title: "[Gemini] task", labels: setup === "label" ? ["executor:eve"] : [] });
    if (setup === "comment") await store.comment(t.id, `${EXECUTOR_MARKER} eve`);
    const seen: ChatMessage[][] = [];
    await tick(deps(store, { gemini: scripted([done, done], seen) }));
    assert.equal(seen.length, 0, setup);
    assert.equal(store.issues[0]!.stateType, "unstarted", "an inactive Eve claim never becomes completed");
    assert.ok(!(store.comments.get(t.id) ?? []).some((c) => c.body.includes(RESULT_MARKER)));
  }
});

test("another ACP agent's claim is foreign; the earliest comment claim wins", () => {
  const claims = claimsOn([], [{ body: `${EXECUTOR_MARKER} acp:claude` }, { body: `${EXECUTOR_MARKER} acp:gemini` }]);
  assert.equal(claimStatus(claims, "gemini"), "foreign");
  assert.equal(claimStatus(claims, "claude"), "own");
  assert.equal(claimStatus(claimsOn([], [{ body: "Claimed by Gemini (AI Command Post)." }]), "gemini"), "own", "legacy claim");
  assert.equal(claimStatus([], "gemini"), "free");
});

test("blocked results are closed as canceled, never completed", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[Gemini] task" });
  await tick(deps(store, { gemini: scripted([blocked]) }));
  assert.equal(store.issues[0]!.stateType, "canceled");
  assert.ok((store.comments.get(t.id) ?? []).some((c) => c.body.includes("blocked")));
});

test("a command whose sub-tasks were all canceled/blocked is not marked completed", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Gemini] do it", description: COMMAND_MARKER, stateType: "started" });
  store.add({ title: "[Gemini] a", parentId: cmd.id, stateType: "canceled" });
  store.add({ title: "[Gemini] b", parentId: cmd.id, stateType: "duplicate" });
  await tick(deps(store, { gemini: scripted(["summary"]) }));
  assert.ok((store.comments.get(cmd.id) ?? []).some((c) => c.body.includes(RECONCILED_MARKER)));
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "canceled");
});

test("a command with at least one completed sub-task is still completed", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Gemini] do it", description: COMMAND_MARKER, stateType: "started" });
  store.add({ title: "[Gemini] a", parentId: cmd.id, stateType: "completed" });
  store.add({ title: "[Gemini] b", parentId: cmd.id, stateType: "canceled" });
  await tick(deps(store, { gemini: scripted(["summary"]) }));
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "completed");
});

test("a task owned by an offline agent is left untouched, not given to Gemini", async () => {
  for (const owner of [{ title: "[Claude] review" }, { title: "Review", labels: ["ChatGPT"] }, { title: "Review", assignee: "Claude" }]) {
    const store = new MemoryStore();
    const t = store.add(owner);
    const seen: ChatMessage[][] = [];
    await tick(deps(store, { gemini: scripted([done], seen) }, { ACP_DEFAULT_LEAD: "gemini" }));
    assert.equal(seen.length, 0, JSON.stringify(owner));
    assert.equal(store.issues[0]!.stateType, "unstarted");
    assert.equal((store.comments.get(t.id) ?? []).length, 0);
  }
});

test("explicit Gemini routing (title prefix or label) is still worked", async () => {
  for (const p of [{ title: "[Gemini] x" }, { title: "x", labels: ["gemini"] }]) {
    const store = new MemoryStore();
    store.add(p);
    await tick(deps(store, { gemini: scripted([done]) }));
    assert.equal(store.issues[0]!.stateType, "completed");
  }
});

test("documents current question behaviour: an unlabelled [Question] has no owner, so no executor runs it", async () => {
  assert.equal(agentFor({ title: "[Question] what is X?" }), null);
  const store = new MemoryStore();
  store.add({ title: "[Question] what is X?" });
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { gemini: scripted([done], seen) }, { ACP_DEFAULT_LEAD: "gemini" }));
  assert.equal(seen.length, 0);
});

test("the earliest-created claim wins even if comments arrive newest-first", () => {
  const claims = claimsOn([], [
    { body: `${EXECUTOR_MARKER} acp:gemini`, createdAt: "2026-10-08T10:00:01Z" },
    { body: `${EXECUTOR_MARKER} acp:claude`, createdAt: "2026-10-08T10:00:00Z" },
  ]);
  assert.equal(claimStatus(claims, "claude"), "own");
  assert.equal(claimStatus(claims, "gemini"), "foreign");
});

test("a failed claim read on one task does not abort the tick", async () => {
  const store = new MemoryStore();
  const bad = store.add({ title: "[Gemini] flaky read", priority: 1 });
  const cmd = store.add({ title: "[Gemini] cmd", description: COMMAND_MARKER, stateType: "started" });
  store.add({ title: "[Gemini] a", parentId: cmd.id, stateType: "completed" });
  const orig = store.getComments.bind(store);
  store.getComments = async (id: string) => { if (id === bad.id) throw new Error("linear down"); return orig(id); };
  const r = await tick(deps(store, { gemini: scripted(["summary"]) }));
  assert.ok(r.errors.some((e) => e.includes("linear down")));
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "completed", "reconciliation still ran");
});

test("claim order uses parsed time, not array order or string format", () => {
  const claims = claimsOn([], [
    { body: `${EXECUTOR_MARKER} acp:chatgpt` },
    { body: `${EXECUTOR_MARKER} acp:gemini`, createdAt: "2026-10-08T10:00:00.500Z" },
    { body: `${EXECUTOR_MARKER} acp:claude`, createdAt: "2026-10-08T05:00:00-05:00" },
  ]);
  // 05:00-05:00 is 10:00:00Z, earlier than 10:00:00.500Z; the undated claim sorts last.
  assert.equal(claimStatus(claims, "claude"), "own");
  const reversed = claimsOn([], [...[
    { body: `${EXECUTOR_MARKER} acp:chatgpt` },
    { body: `${EXECUTOR_MARKER} acp:gemini`, createdAt: "2026-10-08T10:00:00.500Z" },
    { body: `${EXECUTOR_MARKER} acp:claude`, createdAt: "2026-10-08T05:00:00-05:00" },
  ]].reverse());
  assert.equal(claimStatus(reversed, "claude"), "own");
});

test("a command fenced for another executor is neither planned nor reconciled", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "Do the thing", description: COMMAND_MARKER, labels: ["executor:eve"] });
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { gemini: scripted(["{}"], seen) }, { ACP_DEFAULT_LEAD: "gemini" }));
  assert.equal(seen.length, 0, "lead never called");
  assert.equal(store.issues.filter((i) => i.parentId === cmd.id).length, 0, "no sub-issues");
  assert.ok(r.waiting.some((w) => w.includes("command claimed by another executor")));

  const running = store.add({ title: "Running", description: COMMAND_MARKER, stateType: "started" });
  store.add({ title: "[Gemini] a", parentId: running.id, stateType: "completed" });
  await store.comment(running.id, `${EXECUTOR_MARKER} manual`);
  const seen2: ChatMessage[][] = [];
  await tick(deps(store, { gemini: scripted(["summary"], seen2) }));
  assert.equal(seen2.length, 0, "no reconcile call");
  assert.equal(store.issues.find((i) => i.id === running.id)!.stateType, "started");
});

test("a label added after the snapshot still fences the task at the final claim check", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[Gemini] check docs" });
  store.labelOverride.set(t.id, ["executor:manual"]);
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { gemini: scripted([done], seen) }));
  assert.equal(seen.length, 0, "model never called");
  assert.equal(claimsFor(store, t.id).length, 0, "ACP wrote no claim");
});

test("ACP claims a command for its lead before planning", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "Do the thing", description: COMMAND_MARKER });
  await tick(deps(store, { gemini: scripted(['{"summary":"s","tasks":[]}']) }, { ACP_DEFAULT_LEAD: "gemini" }));
  const claims = claimsFor(store, cmd.id);
  assert.equal(claims.length, 1);
  assert.match(claims[0]!.body, /acp:gemini/);
});

test("a command claimed by another ACP agent is not planned by the lead", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "Do the thing", description: COMMAND_MARKER });
  await store.comment(cmd.id, `${EXECUTOR_MARKER} acp:claude`);
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { gemini: scripted(["{}"], seen) }, { ACP_DEFAULT_LEAD: "gemini" }));
  assert.equal(seen.length, 0);
  assert.ok(r.waiting.some((w) => w.includes("command claimed by another executor")));
});

test("an unclaimed running command is claimed before reconciliation", async () => {
  const store = new MemoryStore();
  const running = store.add({ title: "Running", description: COMMAND_MARKER, stateType: "started" });
  store.add({ title: "[Gemini] a", parentId: running.id, stateType: "completed" });
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { gemini: scripted(["summary"], seen) }, { ACP_DEFAULT_LEAD: "gemini" }));
  const claims = claimsFor(store, running.id);
  assert.equal(claims.length, 1);
  assert.match(claims[0]!.body, /acp:gemini/);
});

test("a planned command keeps its recorded ACP lead after the active lead changes", async () => {
  const store = new MemoryStore();
  const running = store.add({ title: "Running", description: COMMAND_MARKER, stateType: "started" });
  store.add({ title: "[Gemini] a", parentId: running.id, stateType: "completed" });
  await store.comment(running.id, `${EXECUTOR_MARKER} acp:claude`);
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { gemini: scripted(["summary"], seen) }, { ACP_DEFAULT_LEAD: "gemini" }));
  assert.ok(!r.waiting.some((w) => w.includes("command claimed by another executor")));
  assert.equal(claimsFor(store, running.id).length, 1, "no second claim");
});

test("reconciliation budget preflight counts child results, so a too-large prompt leaves no claim", async () => {
  const store = new MemoryStore();
  const running = store.add({ title: "[Claude] Running", description: COMMAND_MARKER, stateType: "started" });
  const child = store.add({ title: "[Claude] a", parentId: running.id, stateType: "completed" });
  await store.comment(child.id, `${RESULT_MARKER}\n${"x".repeat(200_000)}`);
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { claude: scripted(["summary"], seen) }, { ACP_MONTHLY_BUDGET_USD: "0.05" }));
  assert.equal(seen.length, 0, "no model call");
  assert.equal(claimsFor(store, running.id).length, 0, "no stale claim");
});
