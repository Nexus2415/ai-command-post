import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";
import { LIGHT_RATES, RATES, costUsd, estimateUsd, mergeTurns, modelStatus, openRouterIdOk, routeTier } from "../api/_lib/workspace-models.js";

// Smart routing: simple questions go to the same vendor's light model. Fake fetch only; no real model is called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  OPENROUTER_API_KEY: "synthetic-openrouter",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-11-25T12:00:00Z");

function harness(env: Record<string, string> = base) {
  const store = createMemoryStore();
  const calls: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes("anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "text", text: "Paris." }], usage: { input_tokens: 1000, output_tokens: 100 } }));
    return new Response(JSON.stringify({ choices: [{ message: { content: "Paris." } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, { fetch: fakeFetch, now });
  return { calls, call };
}
async function thread(call: any, model = "claude") {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}

test("only short, plain questions are routed light; anything in doubt gets the full model", () => {
  for (const q of ["What's the capital of France?", "Translate 'good morning' to Spanish", "Is 17 a prime number?", "Spell 'necessary'"]) {
    assert.equal(routeTier("claude", q), "light", q);
  }
  for (const q of [
    "Analyze our Q3 numbers", "Draft a reply to this customer", "Why did revenue drop?", "Review this contract clause",
    "Help me plan the launch", "x".repeat(281), "a?\nb?\nc?\nd?", "One? Two? Three?",
    "Summarize\n\n<<<file: a.txt>>>\nhi\n<<<end of file>>>",
  ]) assert.equal(routeTier("claude", q), "full", q.slice(0, 40));
  assert.equal(routeTier("claude", "Hi there", { historyChars: 6_001 }), "full");
  assert.equal(routeTier("claude", "Hi there", { files: true }), "full");
  // Perplexity has no lighter model; Gemini stays suspended either way.
  assert.equal(routeTier("perplexity", "Hi there"), "full");
  assert.equal(routeTier("gemini", "Hi there"), "full");
  assert.equal(modelStatus(base, "gemini", "light").ready, false);
});

test("the light models are the same vendor's, and much cheaper", () => {
  assert.equal(modelStatus(base, "claude", "light").id, "anthropic/claude-haiku-5.5");
  assert.equal(modelStatus(base, "chatgpt", "light").id, "openai/gpt-5-nano");
  assert.equal(modelStatus({ ANTHROPIC_API_KEY: "k" }, "claude", "light").id, "claude-haiku-5-5");
  assert.equal(modelStatus({ OPENAI_API_KEY: "k" }, "chatgpt", "light").id, "gpt-5-nano");
  // An override that points at another vendor is refused (ARN-126 still holds for the light slot).
  assert.equal(modelStatus({ ...base, ACP_OPENROUTER_MODEL_CLAUDE_LIGHT: "google/gemini-2.5-flash" }, "claude", "light").ready, false);
  assert.ok(openRouterIdOk("claude", "anthropic/claude-haiku-5.5"));
  for (const m of ["claude", "chatgpt"] as const) {
    assert.ok(costUsd(m, 1000, 1000, "light") * 4 < costUsd(m, 1000, 1000));
    assert.ok(estimateUsd(m, [{ content: "hi" }], base, "light") < estimateUsd(m, [{ content: "hi" }], base));
  }
  assert.ok(Object.keys(LIGHT_RATES).every((m) => m in RATES));
});

test("with routing on, a simple question goes to the light model, is costed at its rates and says so", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  const out = await call("chat", { threadId: t.id, content: "What's the capital of France?", routing: true });
  assert.equal(out.status, 200);
  assert.equal((out.body as any).tier, "light");
  assert.equal(calls[0]!.body.model, "anthropic/claude-haiku-5.5");
  const msg = (out.body as any).message;
  assert.match(msg.content, /Answered by the light model \(smart routing\): Claude Haiku/);
  assert.ok(Math.abs(Number(msg.cost_usd) - costUsd("claude", 1000, 100, "light") * 1.055) < 1e-6);
  // The note never goes back to a model.
  assert.doesNotMatch(mergeTurns([{ role: "assistant", content: msg.content, model: "claude" }])[0]!.content, /smart routing/);
});

test("routing off (or not sent), a hard question, or Perplexity: the full model, with no note", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  for (const args of [{ content: "What's the capital of France?" }, { content: "Analyze our pricing strategy", routing: true }]) {
    const out = await call("chat", { threadId: t.id, ...args });
    assert.equal((out.body as any).tier, "full");
    assert.doesNotMatch((out.body as any).message.content, /smart routing/);
  }
  assert.deepEqual(calls.map((c) => c.body.model), ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"]);
  const p = await thread(call, "perplexity");
  await call("chat", { threadId: p.id, content: "Hi there", routing: true });
  assert.equal(calls.at(-1)!.body.model, "perplexity/sonar");
});

test("the page has the Smart toggle, on by default, and sends it with every one-AI question", () => {
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  assert.match(html, /id="cSmart" aria-pressed="true"/);
  assert.match(js, /post\("chat", \{ threadId, content: text, attachments, files: picked, routing: smart\(\) \}/);
  assert.match(js, /post\("chat", \{ threadId, routing: smart\(\) \}/);
  assert.doesNotMatch(js, /localStorage|sessionStorage/);
});

test("with an image in the thread, even a short follow-up gets the full model", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 7)]).toString("base64");
  const f = (await call("upload_file", { threadId: t.id, name: "a.png", mime: "image/png", data: png })).body.file;
  await call("chat", { threadId: t.id, content: "Hi", files: [f.id], routing: true });
  const out = await call("chat", { threadId: t.id, content: "What color is it?", routing: true });
  assert.equal((out.body as any).tier, "full");
  assert.deepEqual(calls.map((c) => c.body.model), ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"]);
});
