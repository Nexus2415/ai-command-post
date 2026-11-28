// The first live engine run (ARN-146, 2026-11-28) used all 20 replies without writing code: replies with file edits
// were cut off at the output limit, the coder read files one per reply, and it couldn't see how many replies it had
// left. These tests cover the fixes. Synthetic only: scripted model replies and a fake fetch for GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "../src/agents.ts";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { repliesLeftNote, stepTokensFor, tick, type Deps } from "../src/orchestrator.ts";
import { decide } from "../src/policy.ts";
import { anthropicClient, chatCompletionsClient, geminiClient, type ChatMessage, type ModelClient } from "../src/providers.ts";
import { runTool, TOOL_DOCS, type ToolEnv } from "../src/tools.ts";

const REPO = "acme/app";

class Store implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  add(title: string): Issue {
    const i: Issue = {
      id: "i1", identifier: "T-1", title, description: "x", url: "", priority: 3, stateType: "unstarted", stateName: "Todo",
      labels: [], assignee: null, parentId: null, childIds: [], createdAt: new Date(2026, 9, 1).toISOString(),
    };
    this.issues.push(i);
    return i;
  }
  async listOpenAndRecent() { return this.issues.map((i) => ({ ...i })); }
  async getComments(id: string) { return this.comments.get(id) ?? []; }
  async createIssue(): Promise<Issue> { throw new Error("not used"); }
  async comment(id: string, body: string) {
    const l = this.comments.get(id) ?? [];
    l.push({ body, createdAt: new Date().toISOString() });
    this.comments.set(id, l);
  }
  async setState(id: string, _t: string, type: StateType) { this.issues.find((i) => i.id === id)!.stateType = type; }
}

function fakeGitHub(files: Record<string, string>) {
  return (async (url: string) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.split("/contents/")[1] ?? "");
    if (files[p] !== undefined) return Response.json({ sha: "s", content: Buffer.from(files[p]).toString("base64") });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

function rig(replies: { text: string; truncated?: boolean }[], maxSteps = "4") {
  const store = new Store();
  const task = store.add("[Claude] Change the app");
  const seen: ChatMessage[][] = [];
  const limits: number[] = [];
  const claude: ModelClient = {
    async chat(messages, { maxOutputTokens }) {
      seen.push(messages.map((m) => ({ ...m })));
      limits.push(maxOutputTokens);
      const r = replies.shift();
      if (!r) throw new Error("no scripted reply left");
      return { text: r.text, inputTokens: 10, outputTokens: 10, truncated: r.truncated };
    },
  };
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ACP_MAX_STEPS: maxSteps });
  const free = { inputPerM: 0, outputPerM: 0, freeTier: true };
  const d: Deps = {
    cfg, store, clients: { claude },
    budget: new Budget({ capUsd: 0, path: null, rates: { ...DEFAULT_RATES, claude: free } }),
    toolEnv: () => ({
      githubToken: "t", dryRun: false, f: fakeGitHub({ "a.ts": "A", "b.ts": "B" }),
      policy: { allowPullRequests: false, allowedRepos: [REPO] },
      comment: async () => {}, requestApproval: async () => {},
    }),
  };
  return { store, task, seen, limits, d };
}

test("a coder gets room for file edits in one reply; other agents keep the smaller limit", () => {
  assert.equal(stepTokensFor("claude"), 8_000);
  assert.equal(stepTokensFor("perplexity"), 2_500);
});

test("a cut-off reply is named as cut off, with how to send less, and the worker sees replies left", async () => {
  const r = rig([
    { text: '{"tool":"github.open_pull_request","input":{"files":[{"path":"x","content":"very long', truncated: true },
    { text: JSON.stringify({ final: "Stopped.", status: "blocked" }) },
  ]);
  await tick(r.d);
  assert.equal(r.limits[0], 8_000);
  const nudge = r.seen[1]!.at(-1)!.content;
  assert.match(nudge, /cut off at the 8000-token output limit/);
  assert.match(nudge, /"edits" instead of whole files/);
  assert.match(nudge, /\(3 replies left\.\)/);
});

test("a reply that is simply not JSON keeps the plain nudge", async () => {
  const r = rig([{ text: "I think I will look around." }, { text: JSON.stringify({ final: "ok", status: "done" }) }]);
  await tick(r.d);
  assert.match(r.seen[1]!.at(-1)!.content, /^Your reply was not valid JSON in the required shape/);
});

test("tool results count down, and the last reply is called out", async () => {
  const read = JSON.stringify({ tool: "github.read_file", input: { repo: REPO, path: "a.ts" } });
  const r = rig([{ text: read }, { text: read }, { text: JSON.stringify({ final: "ok", status: "done" }) }], "3");
  await tick(r.d);
  assert.match(r.seen[1]!.at(-1)!.content, /\(2 replies left\.\)$/);
  assert.match(r.seen[2]!.at(-1)!.content, /1 reply left: make it your final report/);
  assert.equal(repliesLeftNote(0), "");
});

test("the coder's instructions point it at list_tree once and read_files for several files", async () => {
  const r = rig([{ text: JSON.stringify({ final: "ok", status: "done" }) }]);
  await tick(r.d);
  const system = r.seen[0]![0]!.content;
  assert.match(system, /github\.read_files/);
  assert.match(system, /You have at most 4 replies/);
});

test("read_files reads several files in one call, reports a missing one, and stays in the allowed repo", async () => {
  const env: ToolEnv = {
    githubToken: "t", dryRun: false, f: fakeGitHub({ "a.ts": "AAA", "b.ts": "B".repeat(20_000) }),
    policy: { allowPullRequests: false, allowedRepos: [REPO] },
    comment: async () => {}, requestApproval: async () => {},
  };
  const res = await runTool({ tool: "github.read_files", input: { repo: REPO, paths: ["a.ts", "b.ts", "gone.ts"] } }, ["github.read_files"], env);
  assert.equal(res.ok, true, res.output);
  assert.match(res.output, /=== a\.ts ===\nAAA/);
  assert.match(res.output, /=== b\.ts ===\nB+\n…\[cut here; read the rest with github\.read_file/);
  assert.match(res.output, /=== gone\.ts ===\nERROR:/);
  assert.ok(res.output.length <= 12_000 + 100);
  for (const bad of [[], ["a", "b", "c", "d", "e", "f"], [1]]) {
    const out = await runTool({ tool: "github.read_files", input: { repo: REPO, paths: bad } }, ["github.read_files"], env);
    assert.equal(out.ok, false, JSON.stringify(bad));
  }
  assert.equal(decide("github.read_files", { repo: "other/repo", paths: ["a.ts"] }, env.policy).allow, false);
  assert.equal(decide("github.read_files", { repo: REPO, paths: ["a.ts"] }, env.policy).tier, "green");
  assert.ok(AGENTS.claude.tools.includes("github.read_files") && TOOL_DOCS["github.read_files"]);
});

test("read_files refuses a path that climbs out of the repo, like read_file", async () => {
  const env: ToolEnv = {
    githubToken: "t", dryRun: false, f: fakeGitHub({}),
    policy: { allowPullRequests: false, allowedRepos: [REPO] },
    comment: async () => {}, requestApproval: async () => {},
  };
  const res = await runTool({ tool: "github.read_files", input: { repo: REPO, paths: ["../secrets"] } }, ["github.read_files"], env);
  assert.match(res.output, /=== \.\.\/secrets ===\nERROR:/);
});

test("each provider reports a reply cut off at the output limit", async () => {
  const fake = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
  const msgs: ChatMessage[] = [{ role: "user", content: "q" }];
  const a = await anthropicClient("k", "m", fake({ id: "synthetic-1", model: "m", content: [{ type: "text", text: "{" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 5 } })).chat(msgs, { maxOutputTokens: 5 });
  assert.equal(a.truncated, true);
  const o = await chatCompletionsClient("openai", "https://x", "k", "m", fake({ id: "synthetic-2", model: "m", choices: [{ message: { content: "{" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 } })).chat(msgs, { maxOutputTokens: 5 });
  assert.equal(o.truncated, true);
  const g = await geminiClient("k", "m", fake({ candidates: [{ content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" }] })).chat(msgs, { maxOutputTokens: 5 });
  assert.equal(g.truncated, true);
  const done = await anthropicClient("k", "m", fake({ id: "synthetic-3", model: "m", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } })).chat(msgs, { maxOutputTokens: 5 });
  assert.equal(done.truncated, false);
});
