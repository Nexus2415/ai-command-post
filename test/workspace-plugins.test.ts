import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/lib/workspace-store.js";
import { PLUGINS, readyTools, runTool, pluginStatus } from "../api/lib/workspace-plugins.js";
import { TEAM_ID, PROJECT_ID } from "../api/lib/console-state.js";

// Phase 1 step 4: plugins every tool-using model shares. Fake fetch only.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
  LINEAR_API_KEY: "synthetic-linear",
  GITHUB_TOKEN: "synthetic-github",
  ACP_GITHUB_REPOS: "Nexus2415/opsdesk-harmony",
  FIRECRAWL_API_KEY: "synthetic-firecrawl",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

test("every plugin only reads, and there is no fetch-any-URL tool", () => {
  const names = Object.values(PLUGINS).flatMap((p: any) => p.tools.map((t: any) => t.name));
  assert.deepEqual(names, ["linear_search_issues", "github_read_file", "github_search", "web_search"]);
  for (const n of names) assert.doesNotMatch(n, /scrape|fetch|write|create|update|delete|comment|open|merge/);
  assert.deepEqual(Object.values(pluginStatus({})).map((p: any) => p.ready), [false, false, false]);
  assert.equal(readyTools(base).length, 4);
  assert.equal(readyTools({ ...base, ACP_GITHUB_REPOS: "" }).length, 2, "GitHub needs an allowed repo list");
});

test("GitHub tools refuse repos off the allowed list and odd paths without calling GitHub", async () => {
  let calls = 0;
  const f = (async () => { calls++; return json({}); }) as typeof fetch;
  const tools = readyTools(base);
  const r1 = await runTool(base, tools, "github_read_file", { repo: "someone/else", path: "README.md" }, f);
  const r2 = await runTool(base, tools, "github_read_file", { repo: "Nexus2415/opsdesk-harmony", path: "../secrets" }, f);
  const r3 = await runTool(base, tools, "no_such_tool", {}, f);
  assert.equal(r1.ok, false); assert.match(r1.text, /not on the allowed list/);
  assert.equal(r2.ok, false);
  assert.equal(r3.ok, false);
  assert.equal(calls, 0);
});

test("tool failures go back to the model as short text, never the service's own error", async () => {
  const f = (async () => json({ message: "Bad credentials ghp_secret" }, 401)) as typeof fetch;
  const r = await runTool(base, readyTools(base), "github_search", { repo: "Nexus2415/opsdesk-harmony", query: "x" }, f);
  assert.deepEqual(r, { ok: false, text: "GitHub returned an error (401)." });
});

test("Linear search stays inside the Arnexyia board scope", async () => {
  let sent: any;
  const f = (async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    const n = { identifier: "ARN-1", title: "Kept", url: "u", state: { name: "Todo" }, assignee: null, team: { id: TEAM_ID }, project: { id: PROJECT_ID } };
    return json({ data: { issues: { nodes: [n, { ...n, identifier: "X-9", title: "Leak", project: { id: "other" } }] } } });
  }) as typeof fetch;
  const r = await runTool(base, readyTools(base), "linear_search_issues", { query: "pilot" }, f);
  assert.deepEqual(sent.variables, { team: TEAM_ID, project: PROJECT_ID, q: "pilot" });
  assert.doesNotMatch(sent.query, /mutation/);
  assert.match(r.text, /ARN-1 \[Todo\] unassigned: Kept/);
  assert.doesNotMatch(r.text, /Leak/);
});

function chatHarness(env: Record<string, string>, reply: (url: string, body: any, n: number) => Response) {
  const store = createMemoryStore();
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: any, init: any) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return reply(String(url), body, calls.length);
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, { fetch: f, now: () => new Date("2026-10-21T12:00:00Z") });
  return { call, calls };
}
async function newThread(call: any, model: string) {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}

test("Claude can call a plugin, read the result and answer; every round's cost is recorded", async () => {
  const { call, calls } = chatHarness(base, (url, _b, n) => {
    if (url.includes("firecrawl")) return json({ data: { web: [{ title: "FSM tools", url: "https://ex.com", description: "List" }] } });
    if (n === 1) return json({ content: [{ type: "tool_use", id: "tu1", name: "web_search", input: { query: "fsm tools" } }], usage: { input_tokens: 100, output_tokens: 20 } });
    return json({ content: [{ type: "text", text: "Here are the tools." }], usage: { input_tokens: 300, output_tokens: 50 } });
  });
  const t = await newThread(call, "claude");
  const out = (await call("chat", { threadId: t.id, content: "Find FSM tools" })).body as any;
  assert.equal(out.message.content, "Here are the tools.\n\nTools used: web_search");
  assert.equal(out.message.input_tokens, 400);
  assert.equal(out.message.cost_usd, (400 * 2 + 70 * 10) / 1e6);
  const [first, , second] = calls;
  assert.equal(first!.body.tools.length, 4);
  assert.equal(second!.body.messages.at(-1).content[0].type, "tool_result");
  assert.equal(second!.body.messages.at(-1).content[0].tool_use_id, "tu1");
  assert.match(second!.body.messages.at(-1).content[0].content, /FSM tools https:\/\/ex\.com/);
});

test("ChatGPT gets the same plugins as functions, and the last round may only answer", async () => {
  const { call, calls } = chatHarness(base, (url) => {
    if (url.includes("openai")) {
      return json({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    return json({ data: [] });
  });
  const t = await newThread(call, "chatgpt");
  const out = (await call("chat", { threadId: t.id, content: "Go" })).body as any;
  const modelCalls = calls.filter((c) => c.url.includes("openai"));
  assert.equal(modelCalls.length, 4, "the first call plus three tool rounds, then it stops");
  assert.equal(modelCalls[0]!.body.tools[0].type, "function");
  assert.equal(modelCalls[3]!.body.tool_choice, "none");
  assert.equal(modelCalls[1]!.body.messages.at(-1).role, "tool");
  assert.equal(out.message.input_tokens, 40);
});

test("tool rounds stop at the budget, and what was spent is still recorded", async () => {
  // Each round reports $0.022 (1k in, 2k out). Another round's worst case is about $0.021 more, which a $0.03
  // monthly cap can't hold, so the reply stops after the first call.
  const { call, calls } = chatHarness({ ...base, ACP_WORKSPACE_MONTHLY_BUDGET_USD: "0.03" }, (url) => {
    if (url.includes("firecrawl")) return json({ data: [] });
    return json({ content: [{ type: "tool_use", id: "t", name: "web_search", input: { query: "q" } }], usage: { input_tokens: 1000, output_tokens: 2000 } });
  });
  const t = await newThread(call, "claude");
  const out = (await call("chat", { threadId: t.id, content: "Go" })).body as any;
  assert.equal(calls.filter((c) => c.url.includes("anthropic")).length, 1);
  assert.match(out.message.content, /Stopped before finishing: this would go over the monthly workspace budget/);
  assert.equal(out.message.cost_usd, 0.022);
});

test("Perplexity is offered no tools", async () => {
  const { call, calls } = chatHarness({ ...base, PERPLEXITY_API_KEY: "p" }, () =>
    json({ choices: [{ message: { content: "Answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const t = await newThread(call, "perplexity");
  await call("chat", { threadId: t.id, content: "Q" });
  assert.equal(calls[0]!.body.tools, undefined);
});
