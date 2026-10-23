import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/lib/workspace-store.js";
import { OPENROUTER_FEE, estimateUsd, modelStatus } from "../api/lib/workspace-models.js";

// Phase 2 step 1: one OpenRouter key for every workspace AI. Fake fetch only; OpenRouter is never called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  OPENROUTER_API_KEY: "synthetic-openrouter",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-10-22T12:00:00Z");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const orReply = (content: string | null, usage: object, extra: object = {}) =>
  json({ choices: [{ message: { content, ...extra } }], usage });

function harness(env: Record<string, string>, respond: (url: string) => Response) {
  const store = createMemoryStore();
  const calls: { url: string; body: any; headers: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return respond(String(url));
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, { fetch: fakeFetch, now });
  return { calls, call };
}
async function thread(call: any, model: string) {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}

test("with only an OpenRouter key, Claude, ChatGPT and Perplexity are ready and Gemini stays off", () => {
  assert.deepEqual(modelStatus(base, "claude"), { ready: true, reason: null, via: "openrouter", id: "anthropic/claude-sonnet-5.5" });
  assert.equal(modelStatus(base, "chatgpt").id, "openai/gpt-5-mini");
  assert.equal(modelStatus(base, "perplexity").id, "perplexity/sonar");
  assert.deepEqual(modelStatus({ ...base, GEMINI_API_KEY: "x" }, "gemini"), { ready: false, reason: "Turned off by the owner." });
  assert.equal(modelStatus({ ...base, ACP_OPENROUTER_MODEL_CLAUDE: "anthropic/claude-opus-5.5" }, "claude").id, "anthropic/claude-opus-5.5");
  // A provider's own key wins over OpenRouter.
  assert.equal(modelStatus({ ...base, ANTHROPIC_API_KEY: "a" }, "claude").via, "direct");
  assert.deepEqual(modelStatus({}, "claude"), { ready: false, reason: "No API key added yet." });
});

test("a Claude reply goes through OpenRouter, costing the higher of its report and our rates, plus the fee", async () => {
  // Our rates: 1k in, 500 out = $0.007. OpenRouter reports $0.009, so $0.009 x 1.055 is saved.
  const { call, calls } = harness(base, () => orReply("Hi from OpenRouter", { prompt_tokens: 1000, completion_tokens: 500, cost: 0.009 }));
  const t = await thread(call, "claude");
  const out = (await call("chat", { threadId: t.id, content: "Hi" })).body as any;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0]!.headers.authorization, "Bearer synthetic-openrouter");
  assert.equal(calls[0]!.body.model, "anthropic/claude-sonnet-5.5");
  assert.equal(calls[0]!.body.max_tokens, 2048);
  assert.equal(calls[0]!.body.messages[0].role, "system");
  assert.deepEqual(calls[0]!.body.messages.slice(1), [{ role: "user", content: "Hi" }]);
  assert.equal(out.message.content, "Hi from OpenRouter");
  assert.equal(out.message.cost_usd, Math.round(0.009 * OPENROUTER_FEE * 1e6) / 1e6);

  // A missing or understated report falls back to our own rates.
  const low = harness(base, () => orReply("ok", { prompt_tokens: 1000, completion_tokens: 500, cost: 0.0001 }));
  const t2 = await thread(low.call, "claude");
  const out2 = (await low.call("chat", { threadId: t2.id, content: "Hi" })).body as any;
  assert.equal(out2.message.cost_usd, Math.round(0.007 * OPENROUTER_FEE * 1e6) / 1e6);
});

test("the worst-case check adds the OpenRouter fee and stops before the call", async () => {
  const history = [{ role: "user", content: "x".repeat(3_000) }];
  assert.equal(estimateUsd("claude", history, base), estimateUsd("claude", history) * OPENROUTER_FEE);
  // Without the fee the estimate (~$0.0225) fits a $0.0235 cap; with it (~$0.0238) it doesn't.
  const { call, calls } = harness({ ...base, ACP_WORKSPACE_MONTHLY_BUDGET_USD: "0.0235" }, () => orReply("ok", {}));
  const t = await thread(call, "claude");
  const out = await call("chat", { threadId: t.id, content: "x".repeat(3_000) });
  assert.equal(out.status, 402);
  assert.equal(calls.length, 0);
});

test("through OpenRouter Claude gets the plugins as functions, and Perplexity gets none but keeps its sources", async () => {
  const env = { ...base, FIRECRAWL_API_KEY: "synthetic-firecrawl" };
  let round = 0;
  const { call, calls } = harness(env, (url) => {
    if (url.includes("firecrawl")) return json({ data: [] });
    if (round++ === 0) {
      return orReply(null, { prompt_tokens: 10, completion_tokens: 5 },
        { tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] });
    }
    return orReply("Done", { prompt_tokens: 10, completion_tokens: 5 },
      { annotations: [{ type: "url_citation", url_citation: { url: "https://example.com/b" } }, { type: "url_citation", url_citation: { url: "javascript:alert(1)" } }] });
  });
  const c = await thread(call, "claude");
  const out = (await call("chat", { threadId: c.id, content: "Go" })).body as any;
  const modelCalls = calls.filter((x) => x.url.includes("openrouter"));
  assert.equal(modelCalls.length, 2);
  assert.equal(modelCalls[0]!.body.tools[0].type, "function");
  assert.equal(modelCalls[1]!.body.messages.at(-1).role, "tool");
  assert.equal(modelCalls[1]!.body.messages.at(-1).tool_call_id, "c1");
  assert.match(out.message.content, /Sources:\n- https:\/\/example\.com\/b/);
  assert.doesNotMatch(out.message.content, /javascript:/);
  assert.match(out.message.content, /Tools used: web_search/);

  const p = await thread(call, "perplexity");
  await call("chat", { threadId: p.id, content: "Q" });
  const last = calls.filter((x) => x.url.includes("openrouter")).at(-1)!;
  assert.equal(last.body.model, "perplexity/sonar");
  assert.equal(last.body.tools, undefined);
});

test("the models list says which AIs run through OpenRouter, and an OpenRouter error text is never shown", async () => {
  const { call } = harness({ ...base, OPENAI_API_KEY: "synthetic-openai" }, () => json({ error: { message: "key sk-or-secret has no credits" } }, 402));
  const m = (await call("models")).body as any;
  assert.equal(m.models.claude.via, "openrouter");
  assert.equal(m.models.chatgpt.via, "direct");
  assert.equal(m.models.gemini.via, null);
  const t = await thread(call, "claude");
  const out = await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal(out.status, 502);
  assert.doesNotMatch(JSON.stringify(out.body), /sk-or-secret/);
  assert.match((out.body as any).error, /\(402\)/);
});

test("ARN-126: an OpenRouter slot only reaches its own vendor, so suspended Gemini can't run under another name", async () => {
  for (const [model, v] of [["claude", "CLAUDE"], ["chatgpt", "CHATGPT"], ["perplexity", "PERPLEXITY"]] as const) {
    for (const id of ["google/gemini-2.5-flash", "google/gemini-2.5-pro:free", "openrouter/auto", "gemini-2.5-flash", "anthropic/../google/gemini", ""]) {
      if (!id) continue;
      const s = modelStatus({ ...base, [`ACP_OPENROUTER_MODEL_${v}`]: id }, model);
      assert.equal(s.ready, false, `${model} -> ${id}`);
    }
  }
  // Each slot's own vendor still works, and a model can't borrow another approved vendor either.
  assert.equal(modelStatus({ ...base, ACP_OPENROUTER_MODEL_CHATGPT: "openai/gpt-5" }, "chatgpt").ready, true);
  assert.equal(modelStatus({ ...base, ACP_OPENROUTER_MODEL_PERPLEXITY: "perplexity/sonar-pro" }, "perplexity").ready, true);
  assert.equal(modelStatus({ ...base, ACP_OPENROUTER_MODEL_CLAUDE: "openai/gpt-5" }, "claude").ready, false);

  const env = { ...base, ACP_OPENROUTER_MODEL_CLAUDE: "google/gemini-2.5-flash" };
  const { call, calls } = harness(env, () => orReply("should not happen", { prompt_tokens: 1, completion_tokens: 1 }));
  const t = await thread(call, "claude");
  const out = await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal(out.status, 409);
  assert.match((out.body as any).error, /anthropic\/ model/);
  assert.equal(calls.length, 0, "nothing is sent to OpenRouter");
});
