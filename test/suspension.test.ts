// ARN-115: Gemini is suspended by the owner (ARN-43 decision of 2026-10-09). These synthetic tests prove the
// suspension holds at command intake, client construction and the engine, whatever the environment says.
// Fakes only: no Linear, provider or network call is made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFor } from "../src/agents.ts";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { isSuspended, loadConfig, SUSPENDED_AGENTS, type AgentKey } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { rosterFromConfig } from "../src/manager.ts";
import { COMMAND_MARKER, runnableClients, tick, type Deps } from "../src/orchestrator.ts";
import { buildClients, type ChatMessage, type ModelClient } from "../src/providers.ts";
import { buildIssue, commandLead, handle, SUSPENDED_LEADS } from "../api/intake.js";

const ALL_KEYS = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", PERPLEXITY_API_KEY: "p" };
const neverFetch = (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch;

class MemoryStore implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  writes: string[] = [];
  private n = 0;
  add(p: Partial<Issue> & { title: string }): Issue {
    this.n++;
    const i: Issue = {
      id: `i${this.n}`, identifier: `T-${this.n}`, description: "", url: "", priority: 3, stateType: "unstarted",
      stateName: "Todo", labels: [], assignee: null, parentId: null, childIds: [],
      createdAt: new Date(2026, 9, 1, 0, this.n).toISOString(), ...p,
    };
    this.issues.push(i);
    if (i.parentId) this.issues.find((x) => x.id === i.parentId)!.childIds.push(i.id);
    return i;
  }
  async listOpenAndRecent() { return this.issues.map((i) => ({ ...i, childIds: [...i.childIds] })); }
  async getComments(id: string) { return this.comments.get(id) ?? []; }
  async createIssue(input: { title: string; description: string; parentId?: string; priority?: number }) {
    this.writes.push(`create ${input.title}`);
    return this.add({ title: input.title, description: input.description, parentId: input.parentId ?? null, priority: input.priority ?? 0 });
  }
  async comment(id: string, body: string) {
    this.writes.push(`comment ${id}`);
    const list = this.comments.get(id) ?? [];
    list.push({ body, createdAt: new Date().toISOString() });
    this.comments.set(id, list);
  }
  async setState(id: string, _team: string, type: StateType) {
    this.writes.push(`state ${id} ${type}`);
    this.issues.find((i) => i.id === id)!.stateType = type;
  }
}

/** A model stub that records every call; the suspended agent's stub must never be called. */
function recorder(reply: string, seen: ChatMessage[][]): ModelClient {
  return { async chat(messages) { seen.push(messages); return { text: reply, inputTokens: 1, outputTokens: 1 }; } };
}

const freeRates = Object.fromEntries((Object.keys(DEFAULT_RATES) as AgentKey[]).map((k) => [k, { inputPerM: 0, outputPerM: 0, freeTier: true }]));
function deps(store: MemoryStore, clients: Partial<Record<AgentKey, ModelClient>>, env: Record<string, string> = {}): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ...env });
  return {
    cfg, store, clients,
    budget: new Budget({ capUsd: 0, path: null, rates: freeRates as any }),
    toolEnv: (issue) => ({
      dryRun: false,
      policy: { allowPullRequests: false, allowedRepos: [] },
      comment: (b) => store.comment(issue.id, b),
      requestApproval: (reason) => store.comment(issue.id, `APPROVAL: ${reason}`),
    }),
  };
}
const done = JSON.stringify({ final: "ok", status: "done" });

// ---------- one source of truth ----------

test("Gemini is the suspended agent, and intake's list matches the engine's", () => {
  assert.deepEqual([...SUSPENDED_AGENTS], ["gemini"]);
  assert.deepEqual([...SUSPENDED_LEADS], [...SUSPENDED_AGENTS]);
  assert.equal(isSuspended("gemini"), true);
  for (const k of ["claude", "chatgpt", "perplexity"] as AgentKey[]) assert.equal(isSuspended(k), false);
  assert.throws(() => (SUSPENDED_AGENTS as AgentKey[]).push("claude"), "the list is frozen at runtime");
});

// ---------- intake ----------

test("intake refuses a Gemini command even when the lead and the allowlist both explicitly name Gemini", async () => {
  const site = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
  const req = (intent: string) => ({
    method: "POST", headers: { "x-acp-password": "pw", origin: "https://acp.example", host: "acp.example" },
    body: { intent, text: "Do it", idempotencyKey: "k".repeat(20) },
  });
  for (const e of [
    { ACP_DEFAULT_LEAD: "gemini", ACP_INTAKE_ALLOWED_LEADS: "gemini" },
    { ACP_DEFAULT_LEAD: " GEMINI ", ACP_INTAKE_ALLOWED_LEADS: "claude, Gemini ,chatgpt" },
    { ACP_DEFAULT_LEAD: "gemini", ACP_INTAKE_ALLOWED_LEADS: "gemini", GEMINI_API_KEY: "g" },
  ]) {
    assert.equal(commandLead(e), null, JSON.stringify(e));
    const calls: unknown[] = [];
    const f = (async (_u: string, init: any) => { calls.push(init); return new Response("{}"); }) as unknown as typeof fetch;
    const r: any = await handle(req("command"), { ...site, ...e }, f);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /Nothing was filed/);
    assert.equal(calls.length, 0, "no Linear call, so no [Gemini] issue exists");
    // No silent reroute: the refusal is not a command filed under some other lead.
    assert.doesNotMatch(JSON.stringify(r.body), /\[(Claude|ChatGPT|Perplexity)\]/);
  }
  assert.throws(() => buildIssue("command", "x", "gemini", "t"), /not authorized/);
});

test("questions are still filed, read-only, while the configured lead is the suspended Gemini", async () => {
  const calls: any[] = [];
  const f = (async (_u: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "u", identifier: "ARN-1", url: "https://linear.app/x" } } } }));
  }) as unknown as typeof fetch;
  const r: any = await handle(
    { method: "POST", headers: { "x-acp-password": "pw", origin: "https://a.example", host: "a.example" }, body: { intent: "question", text: "What is queued?", idempotencyKey: "q".repeat(20) } },
    { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin", ACP_DEFAULT_LEAD: "gemini", ACP_INTAKE_ALLOWED_LEADS: "gemini" }, f);
  assert.equal(r.status, 201);
  assert.match(calls[0].variables.input.title, /^\[Question\] /);
  assert.ok(!calls[0].variables.input.description.includes(COMMAND_MARKER));
});

test("an active, allowed lead still files commands (positive control)", () => {
  assert.equal(commandLead({ ACP_DEFAULT_LEAD: "claude", ACP_INTAKE_ALLOWED_LEADS: "claude,gemini" }), "claude");
  assert.match(buildIssue("command", "Ship it", "claude", "t").title, /^\[Claude\] /);
});

// ---------- runnable clients ----------

test("a Gemini API key never produces a runnable Gemini client; other keys still do", () => {
  const clients = buildClients(loadConfig(ALL_KEYS), neverFetch);
  assert.deepEqual(Object.keys(clients).sort(), ["chatgpt", "claude", "perplexity"]);
  assert.deepEqual(Object.keys(buildClients(loadConfig({ GEMINI_API_KEY: "g", ACP_DEFAULT_LEAD: "gemini" }), neverFetch)), []);
});

test("runnableClients drops a suspended client however the client map was built", () => {
  const seen: ChatMessage[][] = [];
  const r = runnableClients({ gemini: recorder("x", seen), claude: recorder("y", seen) });
  assert.deepEqual(Object.keys(r), ["claude"]);
});

test("the manager roster marks Gemini suspended by default, even with its key present", () => {
  const roster = rosterFromConfig(loadConfig(ALL_KEYS));
  assert.deepEqual(roster.filter((x) => x.suspended).map((x) => x.key), ["gemini"]);
});

// ---------- engine ----------

test("a suspended default lead still loads, and a disabled engine starts read-only", async () => {
  const cfg = loadConfig({ ACP_DEFAULT_LEAD: "gemini", GEMINI_API_KEY: "g" });
  assert.equal(cfg.defaultLead, "gemini");
  assert.equal(cfg.active, false);
  const store = new MemoryStore();
  store.add({ title: "[Gemini] Cmd", description: `**${COMMAND_MARKER}**` });
  const seen: ChatMessage[][] = [];
  const r = await tick({ ...deps(store, { gemini: recorder(done, seen) }), cfg });
  assert.match(r.waiting.join(" "), /Engine is off/);
  assert.equal(seen.length, 0);
  assert.deepEqual(store.writes, []);
});

test("an active engine never calls, claims or plans with Gemini, even if a Gemini client is injected", async () => {
  const store = new MemoryStore();
  const task = store.add({ title: "[Gemini] Research", labels: ["gemini"] });
  const cmd = store.add({ title: "[Gemini] Plan it", description: `**${COMMAND_MARKER}**` });
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { gemini: recorder(done, seen) }, { ACP_DEFAULT_LEAD: "gemini", GEMINI_API_KEY: "g" }));
  assert.equal(seen.length, 0, "Gemini was never called");
  assert.deepEqual(store.writes, [], "no claim, comment, child or state change");
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "unstarted");
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.childIds.length, 0);
  assert.deepEqual([r.planned, r.worked], [[], []]);
});

test("a suspended default lead is never the fallback for an offline named lead", async () => {
  const store = new MemoryStore();
  store.add({ title: "[Claude] Plan it", description: `**${COMMAND_MARKER}**` });
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { gemini: recorder('{"summary":"s","tasks":[]}', seen) }, { ACP_DEFAULT_LEAD: "gemini" }));
  assert.equal(seen.length, 0);
  assert.deepEqual(store.writes, []);
});

test("a historical [Gemini] command led by an active default lead says Gemini is suspended", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Gemini] Old command", description: `**${COMMAND_MARKER}**` });
  const gSeen: ChatMessage[][] = [];
  const cSeen: ChatMessage[][] = [];
  await tick(deps(store, {
    gemini: recorder("{}", gSeen),
    claude: recorder(JSON.stringify({ summary: "Plan.", tasks: [{ agent: "gemini", title: "Review", description: "x" }] }), cSeen),
  }, { ACP_DEFAULT_LEAD: "claude" }));
  assert.equal(gSeen.length, 0);
  assert.equal(cSeen.length, 1);
  const notes = (store.comments.get(cmd.id) ?? []).map((c) => c.body).join("\n");
  assert.match(notes, /Gemini is suspended by the owner, so Claude led instead/);
  // A planned sub-task for Gemini goes to the active lead, never to Gemini.
  assert.deepEqual(store.issues.filter((i) => i.parentId === cmd.id).map((k) => k.title), ["[Claude] Review"]);
});

test("historical [Gemini] tasks are still recognised for display", () => {
  assert.equal(agentFor({ title: "[Gemini] old task" }), "gemini");
  assert.equal(agentFor({ title: "x", labels: ["gemini"] }), "gemini");
});
