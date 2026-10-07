import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFor, titleFor } from "../src/agents.ts";
import { Budget } from "../src/budget.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import { extractJson } from "../src/json.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { COMMAND_MARKER, RECONCILED_MARKER, RESULT_MARKER, tick, type Deps } from "../src/orchestrator.ts";
import { decide } from "../src/policy.ts";
import type { ChatMessage, ModelClient } from "../src/providers.ts";
import { runTool } from "../src/tools.ts";

// ---------- helpers ----------

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

// ---------- agents ----------

test("agentFor reads title prefix, then labels, then assignee", () => {
  assert.equal(agentFor({ title: "[Claude] fix it" }), "claude");
  assert.equal(agentFor({ title: "[ChatGPT] plan" }), "chatgpt");
  assert.equal(agentFor({ title: "[OpenAI] plan" }), "chatgpt");
  assert.equal(agentFor({ title: "Research", labels: ["Perplexity"] }), "perplexity");
  assert.equal(agentFor({ title: "Review", assignee: "Gemini bot" }), "gemini");
  assert.equal(agentFor({ title: "Verify invitation activation path" }), null);
  assert.equal(agentFor({ title: "[Bug] Claude crashes" }), null, "a non-agent bracket prefix doesn't count, and body text isn't scanned");
});

test("titleFor replaces any existing prefix", () => {
  assert.equal(titleFor("gemini", "[Claude] check OAuth"), "[Gemini] check OAuth");
});

// ---------- budget ----------

test("$0 cap allows free-tier agents only", () => {
  const b = new Budget({ capUsd: 0, path: null });
  assert.equal(b.check("gemini", 10_000, 2_000).ok, true);
  const c = b.check("claude", 10_000, 2_000);
  assert.equal(c.ok, false);
});

test("paid calls are refused once worst-case cost would exceed the cap", () => {
  const b = new Budget({ capUsd: 0.04, path: null });
  assert.equal(b.check("claude", 1_000, 1_000).ok, true); // ≈ $0.018
  b.record({ agent: "claude", issue: "T-1", inputTokens: 5_000, outputTokens: 1_000 }); // $0.03
  assert.equal(b.check("claude", 1_000, 1_000).ok, false);
  assert.ok(Math.abs(b.spentUsd() - 0.03) < 1e-9);
});

// ---------- policy ----------

test("policy blocks red-tier intent, unknown tools, foreign repos and disabled PRs", () => {
  const ctx = { allowPullRequests: false, allowedRepos: ["acme/app"] };
  assert.equal(decide("github.read_file", { repo: "acme/app", path: "src/delete-user.ts" }, ctx).allow, true, "path words are not intent");
  assert.equal(decide("linear.comment", { body: "Please merge PR #4" }, ctx).allow, false);
  assert.equal(decide("linear.comment", { body: "Next: purchase the Business plan" }, ctx).allow, false);
  assert.equal(decide("github.delete_repo", {}, ctx).allow, false);
  assert.equal(decide("github.read_file", { repo: "other/repo", path: "x" }, ctx).allow, false);
  assert.equal(decide("github.open_pull_request", { repo: "acme/app", title: "Add tests" }, ctx).allow, false);
  assert.equal(decide("github.open_pull_request", { repo: "acme/app", title: "Add tests" }, { ...ctx, allowPullRequests: true }).allow, true);
});

test("runTool refuses tools outside the agent's kit and records approval requests", async () => {
  const notes: string[] = [];
  const env = {
    dryRun: true,
    policy: { allowPullRequests: false, allowedRepos: [] },
    comment: async () => {},
    requestApproval: async (r: string) => {
      notes.push(r);
    },
  };
  const a = await runTool({ tool: "github.open_pull_request", input: {} }, ["linear.comment"], env);
  assert.equal(a.ok, false);
  const b = await runTool({ tool: "linear.comment", input: { body: "I will now deploy to production" } }, ["linear.comment"], env);
  assert.equal(b.ok, false);
  assert.equal(notes.length, 1);
});

// ---------- json ----------

test("extractJson handles fences, prose and braces inside strings", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"tool":"x","input":{"q":"a}b"}}\n```'), { tool: "x", input: { q: "a}b" } });
  assert.deepEqual(extractJson('ok {"final":"done","status":"done"} thanks'), { final: "done", status: "done" });
  assert.equal(extractJson("no json here"), null);
});

// ---------- orchestrator ----------

test("engine off: reports waiting work and calls no model", async () => {
  const store = new MemoryStore();
  store.add({ title: "[Claude] Do a thing", description: COMMAND_MARKER });
  let calls = 0;
  const client: ModelClient = { chat: async () => (calls++, { text: "", inputTokens: 0, outputTokens: 0 }) };
  const d = deps(store, { claude: client }, { ACP_ACTIVE: "false" });
  const r = await tick(d);
  assert.equal(calls, 0);
  assert.match(r.waiting[0]!, /Engine is off/);
});

test("full loop: lead plans, workers execute with a tool, lead reconciles", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Claude] Shortlist FSM connectors", description: `**${COMMAND_MARKER}**\n\nFind options.` });

  const claude = scripted([
    JSON.stringify({
      summary: "Research then review.",
      tasks: [
        { agent: "perplexity", title: "Research FSM tools", description: "List top tools with sources" },
        { agent: "gemini", title: "Challenge the list", description: "Find gaps" },
      ],
    }),
    "## Final\nServiceTitan and Jobber lead; Gemini flagged pricing gaps.",
  ]);
  const perplexity = scripted([
    JSON.stringify({ tool: "linear.comment", input: { body: "Starting research" } }),
    JSON.stringify({ final: "ServiceTitan, Jobber. Sources: https://example.com", status: "done" }),
  ]);
  const gemini = scripted([JSON.stringify({ final: "Missing pricing data.", status: "done" })]);

  const d = deps(store, { claude, perplexity, gemini });
  d.budget.rates.claude = freeRates.claude;
  d.budget.rates.perplexity = freeRates.perplexity;

  const r1 = await tick(d);
  assert.deepEqual(r1.planned, ["T-1 → 2 sub-tasks"]);
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "started");
  const kids = store.issues.filter((i) => i.parentId === cmd.id);
  assert.deepEqual(kids.map((k) => k.title), ["[Perplexity] Research FSM tools", "[Gemini] Challenge the list"]);
  // Sub-tasks created during a tick are picked up on the next one.
  assert.equal(r1.worked.length, 0);

  const r2 = await tick(d);
  assert.equal(r2.worked.length, 2);
  assert.ok(kids.every((k) => store.issues.find((i) => i.id === k.id)!.stateType === "completed"));
  assert.ok((store.comments.get(kids[0]!.id) ?? []).some((c) => c.body === "Starting research"));
  assert.ok((store.comments.get(kids[0]!.id) ?? []).some((c) => c.body.startsWith(RESULT_MARKER)));
  assert.equal(r2.reconciled.length, 0, "reconcile waits for the next tick's fresh state");

  const r3 = await tick(d);
  assert.deepEqual(r3.reconciled, ["T-1"]);
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "completed");
  assert.ok((store.comments.get(cmd.id) ?? []).some((c) => c.body.startsWith(RECONCILED_MARKER)));
});

test("a command reconciles when its sub-tasks are completed, canceled or marked duplicate", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Claude] Tidy backlog", description: `**${COMMAND_MARKER}**`, stateType: "started" });
  store.add({ title: "[Gemini] A", parentId: cmd.id, stateType: "completed" });
  store.add({ title: "[Gemini] B", parentId: cmd.id, stateType: "canceled" });
  store.add({ title: "[Gemini] C", parentId: cmd.id, stateType: "duplicate" });
  const d = deps(store, { claude: scripted(["## Final\nDone."]) });
  d.budget.rates.claude = freeRates.claude;
  const r = await tick(d);
  assert.deepEqual(r.reconciled, ["T-1"]);
});

test("an offline lead falls back to the default lead, and its tasks go to agents that are online", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Claude] Research tools", description: `**${COMMAND_MARKER}**` });
  const gemini = scripted([JSON.stringify({ summary: "Plan.", tasks: [{ agent: "claude", title: "Review", description: "x" }] })]);
  const r = await tick(deps(store, { gemini }, { ACP_DEFAULT_LEAD: "gemini" }));
  assert.deepEqual(r.planned, ["T-1 → 1 sub-tasks"]);
  assert.deepEqual(store.issues.filter((i) => i.parentId === cmd.id).map((k) => k.title), ["[Gemini] Review"]);
  assert.ok((store.comments.get(cmd.id) ?? []).some((c) => c.body.includes("Claude isn't connected, so Gemini led instead")));
});

test("a blocked task is closed so its command can still be summarized", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Gemini] Cmd", description: `**${COMMAND_MARKER}**`, stateType: "started" });
  const task = store.add({ title: "[Gemini] Research", parentId: cmd.id });
  const d = deps(store, { gemini: scripted([JSON.stringify({ final: "No access.", status: "blocked" }), "## Summary\nBlocked."]) });
  await tick(d);
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "canceled");
  assert.deepEqual((await tick(d)).reconciled, ["T-1"]);
});

test("workers are only offered tools whose keys are configured", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Gemini] Cmd", description: `**${COMMAND_MARKER}**`, stateType: "started" });
  store.add({ title: "[Gemini] Research", parentId: cmd.id });
  const seen: ChatMessage[][] = [];
  const d = deps(store, { gemini: scripted([JSON.stringify({ final: "Done.", status: "done" })], seen) });
  await tick(d);
  const system = seen[0]![0]!.content;
  assert.ok(system.includes("linear.comment"));
  assert.ok(!system.includes("firecrawl.") && !system.includes("github."));
});

test("vercel tools are green, read-only, and need a key", async () => {
  assert.equal(decide("vercel.list_deployments", {}, { allowPullRequests: false, allowedRepos: [] }).allow, true);
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ deployments: [{ uid: "dpl_1", name: "site", state: "READY", url: "site.vercel.app", created: 0 }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { vercelToken: "t", dryRun: true, policy: { allowPullRequests: false, allowedRepos: [] }, comment: async () => {}, requestApproval: async () => {}, f };
  const r = await runTool({ tool: "vercel.list_deployments", input: { project: "site" } }, ["vercel.list_deployments"], env);
  assert.ok(r.ok && r.output.includes("dpl_1 site READY"));
  assert.ok(calls[0]!.startsWith("GET https://api.vercel.com/v6/deployments?"));
  const none = await runTool({ tool: "vercel.list_deployments", input: {} }, ["vercel.list_deployments"], { ...env, vercelToken: undefined });
  assert.ok(!none.ok && none.output.includes("VERCEL_API_KEY"));
});

test("$0 cap: paid lead cannot plan and the command stays untouched", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Claude] Anything", description: COMMAND_MARKER });
  const d = deps(store, { claude: scripted([]) });
  const r = await tick(d);
  assert.equal(r.planned.length, 0);
  assert.match(r.waiting.join(" "), /no free tier/);
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "unstarted");
  assert.equal(store.comments.size, 0);
});

test("budget-blocked worker never claims a task", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[Claude] Review PR", description: "look" });
  const d = deps(store, { claude: scripted([]) });
  const r = await tick(d);
  assert.equal(store.issues.find((i) => i.id === t.id)!.stateType, "unstarted");
  assert.match(r.waiting.join(" "), /T-1/);
});

test("worker that keeps replying with junk stops at the step limit", async () => {
  const store = new MemoryStore();
  const t = store.add({ title: "[Gemini] Summarize", description: "x" });
  const d = deps(store, { gemini: scripted(["nope", "still nope"]) }, { ACP_MAX_STEPS: "2" });
  const r = await tick(d);
  assert.match(r.worked[0]!, /step limit/);
  assert.notEqual(store.issues.find((i) => i.id === t.id)!.stateType, "completed");
});

test("one task per agent per tick, highest priority first", async () => {
  const store = new MemoryStore();
  store.add({ title: "[Gemini] Low", priority: 4 });
  const urgent = store.add({ title: "[Gemini] Urgent", priority: 1 });
  const seen: ChatMessage[][] = [];
  const d = deps(store, { gemini: scripted([JSON.stringify({ final: "ok", status: "done" })], seen) });
  const r = await tick(d);
  assert.equal(r.worked.length, 1);
  assert.match(seen[0]![1]!.content, /Urgent/);
  assert.equal(store.issues.find((i) => i.id === urgent.id)!.stateType, "completed");
});

test("issues without an AI owner are left alone", async () => {
  const store = new MemoryStore();
  store.add({ title: "Verify invitation activation path" });
  const d = deps(store, { gemini: scripted([]) });
  const r = await tick(d);
  assert.equal(r.worked.length, 0);
  assert.equal(store.comments.size, 0);
});
