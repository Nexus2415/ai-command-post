import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/lib/workspace-store.js";
import { mergeTurns } from "../api/lib/workspace-models.js";

// Phase 2 step 2: side-by-side answers. Fake fetch only; no real model is ever called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  PERPLEXITY_API_KEY: "synthetic-perplexity",
  FIRECRAWL_API_KEY: "synthetic-firecrawl",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-10-22T12:00:00Z");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

function harness(env: Record<string, string> = base, respond?: (url: string) => Response) {
  const store = createMemoryStore();
  const calls: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const u = String(url);
    if (respond) return respond(u);
    if (u.includes("anthropic")) return json({ content: [{ type: "text", text: "Claude says" }], usage: { input_tokens: 1000, output_tokens: 500 } });
    return json({ choices: [{ message: { content: u.includes("openai") ? "ChatGPT says" : "Perplexity says" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, { fetch: fakeFetch, now });
  return { calls, call };
}
async function thread(call: any, model = "claude") {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}

test("one message goes to several AIs and each answer is saved with its AI and cost", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  const out = await call("compare", { threadId: t.id, content: "Which is better?", models: ["claude", "chatgpt", "perplexity"] });
  assert.equal(out.status, 200);
  const body = out.body as any;
  assert.equal(body.saved.content, "Which is better?");
  assert.deepEqual(body.messages.map((m: any) => [m.model, m.content]), [["claude", "Claude says"], ["chatgpt", "ChatGPT says"], ["perplexity", "Perplexity says"]]);
  assert.equal(body.messages[0].cost_usd, 0.007);
  assert.deepEqual(body.failed, []);
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.body.tools, undefined, "plugins stay off when comparing");
  assert.equal(calls.filter((c) => c.url.includes("firecrawl")).length, 0);
});

test("a later message sends the side-by-side answers back labelled, as one turn", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  await call("compare", { threadId: t.id, content: "Q1", models: ["claude", "chatgpt"] });
  await call("chat", { threadId: t.id, content: "Q2" });
  const last = calls.at(-1)!;
  assert.equal(last.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(last.body.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.equal(last.body.messages[1].content, "Answer from Claude:\nClaude says\n\nAnswer from ChatGPT:\nChatGPT says");
  assert.deepEqual(mergeTurns([{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "c", model: "claude" }]),
    [{ role: "user", content: "a\n\nb" }, { role: "assistant", content: "c" }]);
});

test("compare needs 2 or 3 ready AIs and refuses before saving anything", async () => {
  const { call, calls } = harness({ ...base, GEMINI_API_KEY: "synthetic-gemini", OPENAI_API_KEY: "" });
  const t = await thread(call);
  assert.equal((await call("compare", { threadId: t.id, content: "Q", models: ["claude"] })).status, 400);
  assert.equal((await call("compare", { threadId: t.id, content: "Q", models: ["claude", "chatgpt", "perplexity", "gemini"] })).status, 400);
  assert.equal((await call("compare", { threadId: t.id, content: "Q", models: ["claude", "nope"] })).status, 400);
  const off = await call("compare", { threadId: t.id, content: "Q", models: ["claude", "gemini"] });
  assert.equal(off.status, 409);
  assert.match((off.body as any).error, /Gemini isn't available: Turned off by the owner/);
  const keyless = await call("compare", { threadId: t.id, content: "Q", models: ["claude", "chatgpt"] });
  assert.match((keyless.body as any).error, /ChatGPT isn't available: No API key/);
  assert.equal(calls.length, 0);
  assert.equal(((await call("get_thread", { threadId: t.id })).body as any).messages.length, 0);
});

test("the caps cover every AI's worst case together, before any call", async () => {
  // Worst cases: Claude ~$0.0206 and ChatGPT ~$0.0041, so $0.024 holds either alone but not both (~$0.0247).
  const { call, calls } = harness({ ...base, ACP_WORKSPACE_MONTHLY_BUDGET_USD: "0.024" });
  const t = await thread(call);
  const out = await call("compare", { threadId: t.id, content: "Q", models: ["claude", "chatgpt"] });
  assert.equal(out.status, 402);
  assert.match((out.body as any).error, /monthly workspace budget/);
  assert.equal(calls.length, 0);
  assert.equal((await call("chat", { threadId: t.id, content: "Q" })).status, 200, "Claude alone fits");
});

test("one AI failing keeps the other answers and hides the provider's error text", async () => {
  const { call } = harness(base, (url) => url.includes("openai")
    ? json({ error: "key sk-secret-9 invalid" }, 401)
    : json({ content: [{ type: "text", text: "Claude says" }], usage: { input_tokens: 10, output_tokens: 10 } }));
  const t = await thread(call);
  const out = await call("compare", { threadId: t.id, content: "Q", models: ["claude", "chatgpt"] });
  assert.equal(out.status, 200);
  const body = out.body as any;
  assert.deepEqual(body.messages.map((m: any) => m.model), ["claude"]);
  assert.deepEqual(body.failed, [{ model: "chatgpt", error: "The AI provider returned an error (401)." }]);
  assert.doesNotMatch(JSON.stringify(body), /sk-secret/);
});

test("the workspace page shows side-by-side answers in columns and offers other ready AIs", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  assert.match(js, /post\("compare"/);
  assert.match(js, /el\("div", "cmp"\)/);
  assert.match(html, /id="cCompare"/);
  assert.match(html, /\.cmp\{display:grid/);
});
