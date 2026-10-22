import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/lib/workspace-store.js";
import { RATES, SUSPENDED_MODELS, MAX_HISTORY_CHARS, trimHistory } from "../api/lib/workspace-models.js";
import { DEFAULT_RATES } from "../src/budget.ts";
import { SUSPENDED_AGENTS } from "../src/config.ts";

// Phase 1 step 3: workspace chat. Fake fetch only; no real model is ever called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  PERPLEXITY_API_KEY: "synthetic-perplexity",
  GEMINI_API_KEY: "synthetic-gemini",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-10-21T12:00:00Z");

function setup(env: Record<string, string> = base, reply = anthropicReply("Hello Darius", 1000, 500)) {
  const store = createMemoryStore();
  const calls: { url: string; body: any; headers: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return reply();
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, { fetch: fakeFetch, now });
  return { store, calls, call };
}
function anthropicReply(text: string, input: number, output: number, status = 200) {
  return () => new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: input, output_tokens: output } }), { status });
}
async function thread(call: any, model = "claude") {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}

test("the website's rates and suspensions match the engine's", () => {
  assert.deepEqual(RATES, DEFAULT_RATES);
  assert.deepEqual([...SUSPENDED_MODELS], [...SUSPENDED_AGENTS]);
});

test("a message gets a reply, saved with its real tokens and cost", async () => {
  const { call, calls } = setup();
  const t = await thread(call);
  const out = await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal(out.status, 200);
  const body = out.body as any;
  assert.equal(body.saved.role, "user");
  assert.equal(body.message.role, "assistant");
  assert.equal(body.message.content, "Hello Darius");
  assert.equal(body.message.model, "claude");
  assert.equal(body.message.cost_usd, (1000 * 2 + 500 * 10) / 1e6);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0]!.headers["x-api-key"], "synthetic-anthropic");
  assert.equal(calls[0]!.body.model, "claude-sonnet-5-5");
  assert.deepEqual(calls[0]!.body.messages, [{ role: "user", content: "Hi" }]);

  await call("chat", { threadId: t.id, content: "Again" });
  assert.deepEqual(calls[1]!.body.messages.map((m: any) => m.role), ["user", "assistant", "user"], "the thread history is sent");
  const models = (await call("models", { threadId: t.id })).body as any;
  assert.equal(models.budget.threadSpent, 2 * 0.007);
  assert.equal(models.budget.monthSpent, 2 * 0.007);
});

test("nothing paid runs at the default $0 workspace budget", async () => {
  const { call, calls } = setup({ ...base, ACP_WORKSPACE_MONTHLY_BUDGET_USD: "" });
  const t = await thread(call);
  const out = await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal(out.status, 402);
  assert.match((out.body as any).error, /monthly workspace budget/);
  assert.equal(calls.length, 0);
  assert.equal(((await call("get_thread", { threadId: t.id })).body as any).messages.length, 0, "a refused message is not saved");
});

test("the monthly and per-thread caps stop the next reply before the call", async () => {
  // Each reply reports $0.21 of use (5k in, 20k out at $2/$10 per M). The worst-case estimate for the next one is
  // about $0.021 (2,048 output tokens), so $0.42 spent + $0.021 goes over a $0.44 cap.
  const { call, calls } = setup({ ...base, ACP_WORKSPACE_THREAD_BUDGET_USD: "0.44" }, anthropicReply("ok", 5_000, 20_000));
  const t = await thread(call);
  assert.equal((await call("chat", { threadId: t.id, content: "1" })).status, 200);
  assert.equal((await call("chat", { threadId: t.id, content: "2" })).status, 200);
  const third = await call("chat", { threadId: t.id, content: "3" });
  assert.equal(third.status, 402);
  assert.match((third.body as any).error, /this thread's budget \(\$0\.42 of \$0\.44 used\)/);
  assert.equal(calls.length, 2);

  const month = setup({ ...base, ACP_WORKSPACE_MONTHLY_BUDGET_USD: "0.22" }, anthropicReply("ok", 5_000, 20_000));
  const t2 = await thread(month.call);
  assert.equal((await month.call("chat", { threadId: t2.id, content: "1" })).status, 200);
  assert.equal((await month.call("chat", { threadId: t2.id, content: "2" })).status, 402);
});

test("suspended or keyless models are refused without a call", async () => {
  const { call, calls } = setup({ ...base, OPENAI_API_KEY: "" });
  const g = await thread(call, "gemini");
  const o = await thread(call, "chatgpt");
  const outG = await call("chat", { threadId: g.id, content: "Hi" });
  const outO = await call("chat", { threadId: o.id, content: "Hi" });
  assert.equal(outG.status, 409);
  assert.match((outG.body as any).error, /Turned off by the owner/);
  assert.equal(outO.status, 409);
  assert.match((outO.body as any).error, /No API key/);
  assert.equal(calls.length, 0);
  const m = (await call("models")).body as any;
  assert.deepEqual(m.models.gemini, { ready: false, reason: "Turned off by the owner.", via: null });
  assert.equal(m.models.claude.ready, true);
});

test("a provider failure keeps the user's message, hides the provider's text, and can be retried", async () => {
  let fail = true;
  const store = createMemoryStore();
  const fakeFetch = (async () => fail
    ? new Response('{"error":"key sk-secret-123 invalid"}', { status: 401 })
    : anthropicReply("Recovered", 10, 10)()) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { fetch: fakeFetch, now });
  const t = await thread(call);
  const out = await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal(out.status, 502);
  assert.doesNotMatch(JSON.stringify(out.body), /sk-secret/);
  assert.match((out.body as any).error, /Your message was saved/);
  fail = false;
  const retry = await call("chat", { threadId: t.id });
  assert.equal(retry.status, 200);
  const msgs = ((await call("get_thread", { threadId: t.id })).body as any).messages;
  assert.deepEqual(msgs.map((m: any) => [m.role, m.content]), [["user", "Hi"], ["assistant", "Recovered"]]);
  assert.equal((await call("chat", { threadId: t.id })).status, 400, "no second reply without a new message");
});

test("ChatGPT and Perplexity use chat completions; Perplexity's search fee and sources are kept", async () => {
  const reply = () => new Response(JSON.stringify({
    choices: [{ message: { content: "Answer" } }], usage: { prompt_tokens: 100, completion_tokens: 50 },
    citations: ["https://example.com/a"],
  }));
  const { call, calls } = setup(base, reply);
  const p = await thread(call, "perplexity");
  const out = (await call("chat", { threadId: p.id, content: "Q" })).body as any;
  assert.equal(calls[0]!.url, "https://api.perplexity.ai/chat/completions");
  assert.equal(calls[0]!.body.max_tokens, 2048);
  assert.match(out.message.content, /Sources:\n- https:\/\/example\.com\/a/);
  assert.equal(out.message.cost_usd, Math.round(((100 + 50) / 1e6 + 0.012) * 1e6) / 1e6);
  const c = await thread(call, "chatgpt");
  await call("chat", { threadId: c.id, content: "Q" });
  assert.equal(calls[1]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[1]!.body.max_completion_tokens, 2048);
  assert.equal(calls[1]!.headers.authorization, "Bearer synthetic-openai");
});

test("history is trimmed to the newest messages and starts with the user", () => {
  const big = "x".repeat(MAX_HISTORY_CHARS / 2);
  const h = trimHistory([
    { role: "user", content: big }, { role: "assistant", content: big }, { role: "user", content: "latest" },
  ]);
  assert.deepEqual(h.map((m) => m.content), ["latest"]);
});

test("project notes reach every model's instructions, and only that project's", async () => {
  const { call, calls } = setup();
  const p = (await call("create_project", { name: "With notes" })).body as any;
  const other = (await call("create_project", { name: "Other" })).body as any;
  await call("add_note", { projectId: p.project.id, content: "Pilot clients are in South Florida." });
  await call("add_note", { projectId: other.project.id, content: "Unrelated note" });
  const t = (await call("create_thread", { projectId: p.project.id, title: "T" })).body as any;
  await call("chat", { threadId: t.thread.id, content: "Hi" });
  assert.match(calls[0]!.body.system, /Project notes from the owner[\s\S]*- Pilot clients are in South Florida\./);
  assert.doesNotMatch(calls[0]!.body.system, /Unrelated/);

  const notes = ((await call("list_notes", { projectId: p.project.id })).body as any).notes;
  assert.equal((await call("delete_note", { noteId: notes[0].id })).status, 200);
  assert.equal((await call("delete_note", { noteId: notes[0].id })).status, 404);
  await call("chat", { threadId: t.thread.id, content: "Again" });
  assert.doesNotMatch(calls[1]!.body.system, /Project notes/);
});

test("a project holds at most 20 notes of up to 2,000 characters", async () => {
  const { call } = setup();
  const p = (await call("create_project", { name: "P" })).body as any;
  assert.equal((await call("add_note", { projectId: p.project.id, content: "x".repeat(2001) })).status, 400);
  for (let i = 0; i < 20; i++) assert.equal((await call("add_note", { projectId: p.project.id, content: `n${i}` })).status, 200);
  assert.equal((await call("add_note", { projectId: p.project.id, content: "one more" })).status, 409);
});
