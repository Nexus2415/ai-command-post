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
