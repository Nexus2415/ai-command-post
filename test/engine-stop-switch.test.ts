import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { RESULT_MARKER, tick, type Deps } from "../src/orchestrator.ts";
import type { ChatMessage, ModelClient } from "../src/providers.ts";
import { STOPPED, UNREADABLE, haltReason, stopSwitchFrom } from "../src/stop-switch.ts";

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

const ENV = { ACP_WORKSPACE_DB_URL: "https://x.supabase.co", ACP_WORKSPACE_DB_KEY: "service-role-test" };
const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, json: async () => body });

test("switch: unset store means not connected", () => {
  assert.equal(stopSwitchFrom({}), null);
  assert.equal(stopSwitchFrom({ ACP_WORKSPACE_DB_URL: "https://x.supabase.co" }), null);
});

test("switch: only an explicit stopped=false lets the engine go on", async () => {
  assert.equal(await stopSwitchFrom(ENV, answer(200, [{ stopped: false }]))!(), null);
  assert.equal(await stopSwitchFrom(ENV, answer(200, [{ stopped: true }]))!(), STOPPED);
  assert.equal(await stopSwitchFrom(ENV, answer(200, [{ stopped: "false" }]))!(), STOPPED);
});

test("switch: fails closed on a missing row, an error, a bad body, a throw or a bad URL", async () => {
  assert.equal(await stopSwitchFrom(ENV, answer(200, []))!(), UNREADABLE);
  assert.equal(await stopSwitchFrom(ENV, answer(500, { message: "down" }))!(), UNREADABLE);
  assert.equal(await stopSwitchFrom(ENV, answer(200, { not: "a list" }))!(), UNREADABLE);
  assert.equal(await stopSwitchFrom(ENV, async () => { throw new Error("timeout"); })!(), UNREADABLE);
  assert.equal(await stopSwitchFrom({ ...ENV, ACP_WORKSPACE_DB_URL: "http://evil.example/x" }, answer(200, [{ stopped: false }]))!(), UNREADABLE);
  assert.equal(await haltReason(async () => { throw new Error("boom"); }), UNREADABLE);
});

test("switch: reads row 1 of ws_control with the service key and no other request", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const check = stopSwitchFrom(ENV, async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, json: async () => [{ stopped: false }] };
  })!;
  await check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://x.supabase.co/rest/v1/ws_control?select=stopped&id=eq.1");
  assert.equal(seen[0]!.headers["apikey"], "service-role-test");
});

const TEST_RATES = { ...DEFAULT_RATES, chatgpt: { inputPerM: 0, outputPerM: 0, freeTier: true } };
function deps(store: MemoryStore, clients: Partial<Record<AgentKey, ModelClient>>, halt?: Deps["halt"]): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false" });
  return {
    cfg,
    store,
    clients,
    budget: new Budget({ capUsd: cfg.monthlyBudgetUsd, path: null, rates: TEST_RATES }),
    ...(halt ? { halt } : {}),
    toolEnv: (issue) => ({
      dryRun: false,
      policy: { allowPullRequests: false, allowedRepos: ["acme/app"] },
      comment: (b) => store.comment(issue.id, `TOOL: ${b}`),
      requestApproval: (reason) => store.comment(issue.id, `APPROVAL: ${reason}`),
    }),
  };
}
const done = JSON.stringify({ final: "ok", status: "done" });
const toolCall = JSON.stringify({ tool: "linear.comment", input: { body: "side effect" } });
const toolWrites = (s: MemoryStore, id: string) => (s.comments.get(id) ?? []).filter((c) => c.body.startsWith("TOOL:"));

test("engine: a stopped switch ends the run before any claim, model call or Linear write", async () => {
  for (const reason of [STOPPED, UNREADABLE]) {
    const store = new MemoryStore();
    const t = store.add({ title: "[ChatGPT] check docs" });
    const seen: ChatMessage[][] = [];
    const r = await tick(deps(store, { chatgpt: scripted([done], seen) }, async () => reason));
    assert.equal(seen.length, 0, "model never called");
    assert.equal(store.comments.get(t.id), undefined, "no claim or comment written");
    assert.equal(store.issues[0]!.stateType, "unstarted");
    assert.ok(r.waiting.includes(reason));
  }
});

test("engine: a throwing switch counts as stopped", async () => {
  const store = new MemoryStore();
  store.add({ title: "[ChatGPT] check docs" });
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { chatgpt: scripted([done], seen) }, async () => { throw new Error("db down"); }));
  assert.equal(seen.length, 0);
  assert.ok(r.waiting.includes(UNREADABLE));
});

test("engine: an open switch changes nothing", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[ChatGPT] check docs" });
  await tick(deps(store, { chatgpt: scripted([toolCall, done]) }, async () => null));
  assert.equal(store.issues[0]!.stateType, "completed");
  assert.equal(toolWrites(store, t.id).length, 1);
});

test("engine: Stop pressed mid-task blocks the next tool call; the task goes back to Todo when no tool ran yet", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[ChatGPT] check docs" });
  let checks = 0;
  // Open for the run start and the first model call, stopped from the tool boundary on.
  const halt = async () => (++checks <= 2 ? null : STOPPED);
  const r = await tick(deps(store, { chatgpt: scripted([toolCall, done]) }, halt));
  assert.equal(toolWrites(store, t.id).length, 0, "tool never ran");
  assert.equal(store.issues[0]!.stateType, "unstarted");
  assert.ok(r.waiting.some((w) => w.includes(STOPPED)));
});

test("engine: Stop pressed after a tool ran blocks the next model call and never replays", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[ChatGPT] check docs" });
  let checks = 0;
  // Open for run start, model call 1 and tool 1; stopped before model call 2.
  const halt = async () => (++checks <= 3 ? null : STOPPED);
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { chatgpt: scripted([toolCall, toolCall, done], seen) }, halt));
  assert.equal(seen.length, 1, "no model call after Stop");
  assert.equal(toolWrites(store, t.id).length, 1, "only the tool call before Stop ran");
  assert.equal(store.issues[0]!.stateType, "canceled");
  assert.ok((store.comments.get(t.id) ?? []).some((c) => c.body.includes(`${RESULT_MARKER} (`) && c.body.includes("blocked")));
});
