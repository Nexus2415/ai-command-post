import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFor, titleFor } from "../src/agents.ts";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import { extractJson } from "../src/json.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { COMMAND_MARKER, latestResult, RECONCILED_MARKER, RESULT_MARKER, tick, type Deps } from "../src/orchestrator.ts";
import { decide } from "../src/policy.ts";
import { ProviderError, type ChatMessage, type ModelClient } from "../src/providers.ts";
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

// Gemini is suspended (ARN-115), so ChatGPT stands in as the free-tier executor these engine tests drive.
const TEST_RATES = { ...DEFAULT_RATES, chatgpt: { inputPerM: 0, outputPerM: 0, freeTier: true } };

function deps(store: MemoryStore, clients: Partial<Record<AgentKey, ModelClient>>, env: Record<string, string> = {}): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ...env });
  return {
    cfg,
    store,
    clients,
    budget: new Budget({ capUsd: cfg.monthlyBudgetUsd, path: null, rates: TEST_RATES }),
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


// A sub-task marked Done carries a done result, as the engine writes one; a Done sub-task without one is inconsistent.
function addDone(store: MemoryStore, p: Partial<Issue> & { title: string }): Issue {
  const k = store.add({ ...p, stateType: "completed" });
  store.comments.set(k.id, [{ body: `${RESULT_MARKER} (ChatGPT, done)\n\nok`, createdAt: "2026-10-01T00:00:00.000Z" }]);
  return k;
}

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
  const b = new Budget({ capUsd: 0.04, path: null, rates: { ...DEFAULT_RATES, claude: { inputPerM: 3, outputPerM: 15, freeTier: false } } });
  assert.equal(b.check("claude", 1_000, 1_000).ok, true); // ≈ $0.018
  b.record({ agent: "claude", issue: "T-1", inputTokens: 5_000, outputTokens: 1_000 }); // $0.03
  assert.equal(b.check("claude", 1_000, 1_000).ok, false);
  assert.ok(Math.abs(b.spentUsd() - 0.03) < 1e-9);
});

test("default rates match the checked list prices, and Perplexity's per-request search fee is counted", () => {
  assert.deepEqual([DEFAULT_RATES.claude.inputPerM, DEFAULT_RATES.claude.outputPerM], [2, 10]);
  assert.deepEqual([DEFAULT_RATES.chatgpt.inputPerM, DEFAULT_RATES.chatgpt.outputPerM], [0.25, 2]);
  assert.equal(DEFAULT_RATES.gemini.freeTier, true);
  const b = new Budget({ capUsd: 0.01, path: null });
  const r = b.check("perplexity", 10, 10);
  assert.equal(r.ok, false, "a 20-token Sonar call still costs its $0.012 search fee, over a $0.01 cap");
  b.record({ agent: "perplexity", issue: "T-1", inputTokens: 0, outputTokens: 0 });
  assert.ok(Math.abs(b.spentUsd() - 0.012) < 1e-12);
});

test("a lost or unreadable spend ledger refuses paid calls until the owner resets that month (ARN-83 F5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-ledger-"));
  const path = join(dir, "ledger.json");
  const now = new Date("2026-10-20T12:00:00Z");
  const paid = (b: Budget) => b.check("claude", 1_000, 1_000);

  // Missing at a $0 cap: nothing paid can run, so a fresh ledger is written for later.
  assert.equal(new Budget({ capUsd: 0, path, now }).ledgerProblem, null);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { month: "2026-10", entries: [] });

  // A real ledger carries over; last month's rolls over to a new month.
  const b = new Budget({ capUsd: 1, path, now });
  assert.equal(paid(b).ok, true);
  b.record({ agent: "claude", issue: "T-1", inputTokens: 1_000, outputTokens: 1_000 });
  assert.ok(new Budget({ capUsd: 1, path, now }).spentUsd() > 0);
  assert.equal(new Budget({ capUsd: 1, path, now: new Date("2026-11-02T00:00:00Z") }).spentUsd(), 0);

  for (const [setup, problem] of [
    [() => rmSync(path), "missing"],
    [() => writeFileSync(path, "{not json"), "unreadable"],
    [() => writeFileSync(path, JSON.stringify({ month: "2026-10", entries: [{ usd: -5 }] })), "unreadable"],
    [() => writeFileSync(path, JSON.stringify({ month: "2027-01", entries: [] })), "dated 2027-01"],
  ] as const) {
    setup();
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const lost = new Budget({ capUsd: 1, path, now });
    assert.match(lost.ledgerProblem ?? "", new RegExp(problem));
    assert.equal(paid(lost).ok, false, problem);
    assert.match((paid(lost) as { reason: string }).reason, /ACP_LEDGER_RESET=2026-10/);
    assert.equal(lost.check("gemini", 1_000, 1_000).ok, true, "free tier still runs");
    lost.record({ agent: "gemini", issue: "T-2", inputTokens: 1, outputTokens: 1 });
    assert.equal(existsSync(path) ? readFileSync(path, "utf8") : null, before, "an untrusted ledger is never replaced");
    assert.equal(new Budget({ capUsd: 1, path, now, resetMonth: "2026-09" }).ledgerProblem !== null, true, "a stale reset does not count");
    const reset = new Budget({ capUsd: 1, path, now, resetMonth: "2026-10" });
    assert.equal(reset.ledgerProblem, null);
    assert.equal(paid(reset).ok, true);
    assert.equal(reset.spentUsd(), 0);
  }
  rmSync(dir, { recursive: true });
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

test("ARN-45: a claim comment Linear doesn't confirm stops the task before any state change or model call", async () => {
  class UnconfirmedClaims extends MemoryStore {
    override async comment(_id: string, _body: string): Promise<void> {
      throw new Error("Linear did not confirm the comment; treating the write as unconfirmed");
    }
  }
  const store = new UnconfirmedClaims();
  const task = store.add({ title: "[ChatGPT] Look something up", description: "Find it." });
  let calls = 0;
  const client: ModelClient = { chat: async () => (calls++, { text: JSON.stringify({ final: "x", status: "done" }), inputTokens: 1, outputTokens: 1 }) };
  const r = await tick(deps(store, { chatgpt: client }));
  assert.equal(calls, 0, "no model call without a persisted claim");
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "unstarted", "the task is not moved to started");
  assert.ok(r.errors.some((e) => e.includes(task.identifier) && /did not confirm the comment/.test(e)), JSON.stringify(r.errors));
});

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
        { agent: "chatgpt", title: "Challenge the list", description: "Find gaps" },
      ],
    }),
    "## Final\nServiceTitan and Jobber lead; ChatGPT flagged pricing gaps.",
  ]);
  const perplexity = scripted([
    JSON.stringify({ tool: "linear.comment", input: { body: "Starting research" } }),
    JSON.stringify({ final: "ServiceTitan, Jobber. Sources: https://example.com", status: "done" }),
  ]);
  const chatgpt = scripted([JSON.stringify({ final: "Missing pricing data.", status: "done" })]);

  const d = deps(store, { claude, perplexity, chatgpt });
  d.budget.rates.claude = freeRates.claude;
  d.budget.rates.perplexity = freeRates.perplexity;

  const r1 = await tick(d);
  assert.deepEqual(r1.planned, ["T-1 → 2 sub-tasks"]);
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "started");
  const kids = store.issues.filter((i) => i.parentId === cmd.id);
  assert.deepEqual(kids.map((k) => k.title), ["[Perplexity] Research FSM tools", "[ChatGPT] Challenge the list"]);
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
  addDone(store, { title: "[ChatGPT] A", parentId: cmd.id });
  store.add({ title: "[ChatGPT] B", parentId: cmd.id, stateType: "canceled" });
  store.add({ title: "[ChatGPT] C", parentId: cmd.id, stateType: "duplicate" });
  const d = deps(store, { claude: scripted(["## Final\nDone."]) });
  d.budget.rates.claude = freeRates.claude;
  const r = await tick(d);
  assert.deepEqual(r.reconciled, ["T-1"]);
});

test("ARN-45: a command whose sub-task list wasn't read in full is neither completed nor planned again", async () => {
  const store = new MemoryStore();
  // Visible: one completed sub-task. Not visible: a started sub-task on a page that was never read.
  const cmd = store.add({ title: "[Claude] Tidy backlog", description: `**${COMMAND_MARKER}**`, stateType: "started", childrenIncomplete: true });
  addDone(store, { title: "[ChatGPT] A", parentId: cmd.id });
  // A new command whose sub-task list came back unreadable may already have sub-tasks: it must not be planned.
  const fresh = store.add({ title: "[Claude] New work", description: `**${COMMAND_MARKER}**`, childrenIncomplete: true });
  const seen: ChatMessage[][] = [];
  const d = deps(store, { claude: scripted(["## Final\nDone.", JSON.stringify({ summary: "Plan.", tasks: [] })], seen) });
  d.budget.rates.claude = freeRates.claude;
  const r = await tick(d);
  assert.deepEqual(r.reconciled, []);
  assert.deepEqual(r.planned, []);
  assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "started", "not marked completed");
  assert.equal(store.issues.filter((i) => i.parentId === fresh.id).length, 0, "no new sub-tasks");
  assert.deepEqual(store.comments.get(cmd.id) ?? [], [], "no summary written");
  assert.equal(seen.length, 0, "no model call");
  assert.ok(r.errors.some((e) => e.startsWith("T-1:") && e.includes("couldn't be read in full")));
  assert.ok(r.errors.some((e) => e.startsWith(`${fresh.identifier}:`) && e.includes("couldn't be read in full")));
});

test("ARN-45: a command is completed only from sub-tasks that name it as their parent", async () => {
  const run = async (setup: (store: MemoryStore, cmd: Issue) => void) => {
    const store = new MemoryStore();
    const cmd = store.add({ title: "[Claude] Tidy backlog", description: `**${COMMAND_MARKER}**`, stateType: "started" });
    setup(store, cmd);
    const seen: ChatMessage[][] = [];
    const d = deps(store, { claude: scripted(["## Final\nDone."], seen) });
    d.budget.rates.claude = freeRates.claude;
    return { r: await tick(d), store, cmd, seen };
  };
  // Control: a real completed child is reconciled.
  const ok = await run((store, cmd) => { addDone(store, { title: "[ChatGPT] A", parentId: cmd.id }); });
  assert.deepEqual(ok.r.reconciled, ["T-1"]);
  const other = (store: MemoryStore) => store.add({ title: "[Claude] Other command", description: `**${COMMAND_MARKER}**`, stateType: "completed" });
  const bad: [string, (store: MemoryStore, cmd: Issue) => void][] = [
    ["a child with another parent", (store, cmd) => { const o = other(store); const k = store.add({ title: "[ChatGPT] X", parentId: o.id, stateType: "completed" }); cmd.childIds.push(k.id); }],
    ["a child with no parent", (store, cmd) => { const k = store.add({ title: "[ChatGPT] X", stateType: "completed" }); cmd.childIds.push(k.id); }],
    ["a real child plus a foreign one", (store, cmd) => {
      addDone(store, { title: "[ChatGPT] A", parentId: cmd.id });
      const k = store.add({ title: "[ChatGPT] X", stateType: "completed" }); cmd.childIds.push(k.id);
    }],
  ];
  for (const [name, setup] of bad) {
    const { r, store, cmd, seen } = await run(setup);
    assert.deepEqual(r.reconciled, [], name);
    assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "started", `${name}: not marked completed`);
    assert.deepEqual(store.comments.get(cmd.id) ?? [], [], `${name}: no summary written`);
    assert.equal(seen.length, 0, `${name}: no model call`);
    assert.ok(r.errors.some((e) => e.startsWith(`${cmd.identifier}:`) && e.includes("doesn't name this command as its parent")), name);
  }
});

test("an offline lead falls back to the default lead, and its tasks go to agents that are online", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[Claude] Research tools", description: `**${COMMAND_MARKER}**` });
  const chatgpt = scripted([JSON.stringify({ summary: "Plan.", tasks: [{ agent: "claude", title: "Review", description: "x" }] })]);
  const r = await tick(deps(store, { chatgpt }, { ACP_DEFAULT_LEAD: "chatgpt" }));
  assert.deepEqual(r.planned, ["T-1 → 1 sub-tasks"]);
  assert.deepEqual(store.issues.filter((i) => i.parentId === cmd.id).map((k) => k.title), ["[ChatGPT] Review"]);
  assert.ok((store.comments.get(cmd.id) ?? []).some((c) => c.body.includes("Claude isn't connected, so ChatGPT led instead")));
});

test("a blocked task is closed so its command can still be summarized", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[ChatGPT] Cmd", description: `**${COMMAND_MARKER}**`, stateType: "started" });
  const task = store.add({ title: "[ChatGPT] Research", parentId: cmd.id });
  const d = deps(store, { chatgpt: scripted([JSON.stringify({ final: "No access.", status: "blocked" }), "## Summary\nBlocked."]) });
  await tick(d);
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "canceled");
  assert.deepEqual((await tick(d)).reconciled, ["T-1"]);
});

test("workers are only offered tools whose keys are configured", async () => {
  const store = new MemoryStore();
  const cmd = store.add({ title: "[ChatGPT] Cmd", description: `**${COMMAND_MARKER}**`, stateType: "started" });
  store.add({ title: "[ChatGPT] Research", parentId: cmd.id });
  const seen: ChatMessage[][] = [];
  const d = deps(store, { chatgpt: scripted([JSON.stringify({ final: "Done.", status: "done" })], seen) });
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
  const t = store.add({ title: "[ChatGPT] Summarize", description: "x" });
  const d = deps(store, { chatgpt: scripted(["nope", "still nope"]) }, { ACP_MAX_STEPS: "2" });
  const r = await tick(d);
  assert.match(r.worked[0]!, /step limit/);
  assert.notEqual(store.issues.find((i) => i.id === t.id)!.stateType, "completed");
});

test("one task per agent per tick, highest priority first", async () => {
  const store = new MemoryStore();
  store.add({ title: "[ChatGPT] Low", priority: 4 });
  const urgent = store.add({ title: "[ChatGPT] Urgent", priority: 1 });
  const seen: ChatMessage[][] = [];
  const d = deps(store, { chatgpt: scripted([JSON.stringify({ final: "ok", status: "done" })], seen) });
  const r = await tick(d);
  assert.equal(r.worked.length, 1);
  assert.match(seen[0]![1]!.content, /Urgent/);
  assert.equal(store.issues.find((i) => i.id === urgent.id)!.stateType, "completed");
});

test("issues without an AI owner are left alone", async () => {
  const store = new MemoryStore();
  store.add({ title: "Verify invitation activation path" });
  const d = deps(store, { chatgpt: scripted([]) });
  const r = await tick(d);
  assert.equal(r.worked.length, 0);
  assert.equal(store.comments.size, 0);
});


test("provider failure before any tool returns task to Todo for safe retry", async () => {
  const store = new MemoryStore();
  const task = store.add({ title: "[ChatGPT] Review PR", description: "review" });
  let calls = 0;
  const chatgpt: ModelClient = {
    async chat() {
      calls += 1;
      if (calls === 1) throw new Error("chatgpt 503: temporarily unavailable");
      return { text: JSON.stringify({ final: "Review complete.", status: "done" }), inputTokens: 100, outputTokens: 20 };
    },
  };
  const d = deps(store, { chatgpt });

  const first = await tick(d);
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "unstarted");
  assert.match(first.waiting.join(" "), /failed before any tool ran/);
  assert.ok(!(store.comments.get(task.id) ?? []).some((c) => c.body.startsWith(RESULT_MARKER)));

  const second = await tick(d);
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "completed");
  assert.equal(second.worked.length, 1);
});

test("provider failure after a tool call stops replay and closes task blocked", async () => {
  const store = new MemoryStore();
  const task = store.add({ title: "[ChatGPT] Review PR", description: "review" });
  let calls = 0;
  const chatgpt: ModelClient = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return { text: JSON.stringify({ tool: "linear.comment", input: { body: "Internal checkpoint" } }), inputTokens: 100, outputTokens: 20 };
      }
      throw new Error("chatgpt 503: temporarily unavailable");
    },
  };
  const d = deps(store, { chatgpt });

  const r = await tick(d);
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "canceled");
  assert.match(r.worked.join(" "), /blocked after tool call/);
  const comments = store.comments.get(task.id) ?? [];
  assert.ok(comments.some((c) => c.body === "Internal checkpoint"));
  assert.ok(comments.some((c) => c.body.startsWith(RESULT_MARKER) && c.body.includes("automatic replay was stopped")));
});

test("permanent provider error closes the task blocked instead of retrying forever", async () => {
  const store = new MemoryStore();
  const task = store.add({ title: "[ChatGPT] Review PR", description: "review" });
  let calls = 0;
  const chatgpt: ModelClient = {
    async chat() {
      calls += 1;
      throw new ProviderError("chatgpt", 401, "invalid API key");
    },
  };
  const d = deps(store, { chatgpt });
  await tick(d);
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "canceled");
  assert.ok((store.comments.get(task.id) ?? []).some((c) => c.body.startsWith(RESULT_MARKER) && c.body.includes("Permanent provider error")));
  await tick(d);
  assert.equal(calls, 1);
});

test("transient provider errors are retried a bounded number of times, then blocked", async () => {
  const store = new MemoryStore();
  const task = store.add({ title: "[ChatGPT] Review PR", description: "review" });
  let calls = 0;
  const chatgpt: ModelClient = {
    async chat() {
      calls += 1;
      throw new ProviderError("chatgpt", 503, "busy");
    },
  };
  const d = deps(store, { chatgpt });
  for (let i = 0; i < 6; i++) await tick(d);
  assert.equal(calls, 4);
  assert.equal(store.issues.find((i) => i.id === task.id)!.stateType, "canceled");
});

test("ARN-45: a sub-task's result is the newest real result header by time, never array order or a quote", () => {
  const done = { body: `${RESULT_MARKER} (ChatGPT, done)\n\nFirst pass.`, createdAt: "2026-11-02T10:00:00.000Z" };
  const blocked = { body: `${RESULT_MARKER} (ChatGPT, blocked)\n\nSource went away.`, createdAt: "2026-11-02T10:05:00.000Z" };
  const chat = { body: "Thanks, looking at this.", createdAt: "2026-11-02T10:10:00.000Z" };
  const perms = [[done, blocked, chat], [done, chat, blocked], [blocked, done, chat], [blocked, chat, done], [chat, done, blocked], [chat, blocked, done]];
  for (const p of perms) assert.equal(latestResult(p, "T-9"), blocked.body, "the later blocked result wins in every order");
  // A later ordinary comment quoting or mentioning a result header is not a result.
  const quotes = [
    `> ${RESULT_MARKER} (Claude, done)\n> All good.`,
    `Copying the earlier note:\n${RESULT_MARKER} (Claude, done)`,
    `${RESULT_MARKER}s look fine to me`,
    `${RESULT_MARKER} (Claude, done) and more on the same line`,
  ].map((body) => ({ body, createdAt: "2026-11-02T11:00:00.000Z" }));
  assert.equal(latestResult([blocked, ...quotes], "T-9"), blocked.body);
  assert.equal(latestResult(quotes, "T-9"), undefined, "a quote-only thread has no result");
  assert.equal(latestResult([], "T-9"), undefined);
  // A result with no readable time can't be placed, and two different results at the same newest time conflict.
  for (const createdAt of [undefined, "", "not a date"]) {
    assert.throws(() => latestResult([done, { body: blocked.body, createdAt }], "T-9"), /T-9 has a result without a readable time/);
  }
  const sameTime = { body: `${RESULT_MARKER} (Claude, done)\n\nOther view.`, createdAt: blocked.createdAt };
  assert.throws(() => latestResult([done, blocked, sameTime], "T-9"), /T-9 has two different results posted at the same time/);
  assert.throws(() => latestResult([sameTime, blocked, done], "T-9"), /two different results/);
  // An older tie doesn't matter once a newer result exists; an identical repeat isn't a conflict.
  const later = { body: `${RESULT_MARKER} (Claude, done)\n\nFinal.`, createdAt: "2026-11-02T12:00:00.000Z" };
  assert.equal(latestResult([blocked, sameTime, later], "T-9"), later.body);
  assert.equal(latestResult([blocked, { ...blocked }], "T-9"), blocked.body);
});

test("ARN-45: the lead summarizes each sub-task from its newest result; an ambiguous result stops the summary", async () => {
  const run = async (comments: { body: string; createdAt: string }[]) => {
    const store = new MemoryStore();
    const cmd = store.add({ title: "[Claude] Tidy backlog", description: `**${COMMAND_MARKER}**`, stateType: "started" });
    const kid = store.add({ title: "[ChatGPT] A", parentId: cmd.id, stateType: "canceled" });
    store.comments.set(kid.id, comments);
    const seen: ChatMessage[][] = [];
    const d = deps(store, { claude: scripted(["## Final\nDone."], seen) });
    d.budget.rates.claude = freeRates.claude;
    return { r: await tick(d), store, cmd, seen };
  };
  const done = { body: `${RESULT_MARKER} (ChatGPT, done)\n\nSTALE-DONE`, createdAt: "2026-11-02T10:00:00.000Z" };
  const blocked = { body: `${RESULT_MARKER} (ChatGPT, blocked)\n\nLATEST-BLOCKED`, createdAt: "2026-11-02T10:05:00.000Z" };
  const quote = { body: `> ${RESULT_MARKER} (ChatGPT, done)\n> QUOTED-DONE`, createdAt: "2026-11-02T10:10:00.000Z" };
  // Newest-first page order: the stale done result and the quote come last in the array but must not be chosen.
  const ok = await run([quote, blocked, done]);
  assert.deepEqual(ok.r.reconciled, ["T-1"]);
  const prompt = ok.seen[0]!.map((m) => m.content).join("\n");
  assert.ok(prompt.includes("LATEST-BLOCKED"), "the newest real result is summarized");
  assert.ok(!prompt.includes("STALE-DONE") && !prompt.includes("QUOTED-DONE"), "stale or quoted results are not");
  // Two different results at the same time: no model call, no summary, command left open, error reported.
  const clash = { body: `${RESULT_MARKER} (ChatGPT, done)\n\nCLASH`, createdAt: blocked.createdAt };
  const bad = await run([done, blocked, clash]);
  assert.deepEqual(bad.r.reconciled, []);
  assert.equal(bad.seen.length, 0, "no model call");
  assert.deepEqual(bad.store.comments.get(bad.cmd.id) ?? [], [], "no summary written");
  assert.equal(bad.store.issues.find((i) => i.id === bad.cmd.id)!.stateType, "started");
  assert.ok(bad.r.errors.some((e) => e.startsWith("T-1:") && e.includes("two different results")));
});

test("ARN-45: a command is not completed from a Done sub-task whose newest result is missing or blocked", async () => {
  const at = (m: number) => `2026-11-02T10:0${m}:00.000Z`;
  const done = (m: number) => ({ body: `${RESULT_MARKER} (ChatGPT, done)\n\nok`, createdAt: at(m) });
  const blocked = (m: number) => ({ body: `${RESULT_MARKER} (ChatGPT, blocked)\n\nno`, createdAt: at(m) });
  const quote = (m: number) => ({ body: `> ${RESULT_MARKER} (ChatGPT, done)`, createdAt: at(m) });
  type Kid = { state: StateType; comments: { body: string; createdAt: string }[] };
  const run = async (kids: Kid[]) => {
    const store = new MemoryStore();
    const cmd = store.add({ title: "[Claude] Tidy backlog", description: `**${COMMAND_MARKER}**`, stateType: "started" });
    kids.forEach((k, i) => store.comments.set(store.add({ title: `[ChatGPT] ${i}`, parentId: cmd.id, stateType: k.state }).id, k.comments));
    const seen: ChatMessage[][] = [];
    const d = deps(store, { claude: scripted(["## Final\nDone."], seen) });
    d.budget.rates.claude = freeRates.claude;
    return { r: await tick(d), store, cmd, seen };
  };
  const bad: [string, Kid[], RegExp][] = [
    ["Done with no result", [{ state: "completed", comments: [] }], /is missing/],
    ["Done with only a quoted result", [{ state: "completed", comments: [quote(1)] }], /is missing/],
    ["Done whose newest result is blocked", [{ state: "completed", comments: [done(1), blocked(2)] }], /says blocked/],
    ["Done and canceled, neither with a result", [{ state: "completed", comments: [] }, { state: "canceled", comments: [] }], /is missing/],
  ];
  for (const [name, kids, why] of bad) {
    const { r, store, cmd, seen } = await run(kids);
    assert.deepEqual(r.reconciled, [], name);
    assert.equal(seen.length, 0, `${name}: no model call`);
    assert.deepEqual(store.comments.get(cmd.id) ?? [], [], `${name}: no summary written`);
    assert.equal(store.issues.find((i) => i.id === cmd.id)!.stateType, "started", `${name}: command left open`);
    assert.ok(r.errors.some((e) => e.startsWith("T-1:") && e.includes("is marked Done but its newest result") && why.test(e)), name);
  }
  // Controls: a Done sub-task whose newest result is done completes the command (even after an earlier blocked);
  // a canceled sub-task with a blocked result still closes the command as canceled.
  const ok = await run([{ state: "completed", comments: [blocked(1), done(2)] }]);
  assert.deepEqual(ok.r.reconciled, ["T-1"]);
  assert.equal(ok.store.issues.find((i) => i.id === ok.cmd.id)!.stateType, "completed");
  const off = await run([{ state: "canceled", comments: [blocked(1)] }]);
  assert.deepEqual(off.r.reconciled, ["T-1"]);
  assert.equal(off.store.issues.find((i) => i.id === off.cmd.id)!.stateType, "canceled");
});
