import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/lib/workspace-store.js";

// Phase 2 step 3: text files attached to messages. Fake fetch only; no real model is ever called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-10-22T12:00:00Z");

function harness() {
  const store = createMemoryStore();
  const calls: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes("anthropic")) return new Response(JSON.stringify({ content: [{ type: "text", text: "Read it" }], usage: { input_tokens: 10, output_tokens: 10 } }));
    return new Response(JSON.stringify({ choices: [{ message: { content: "Read it too" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { fetch: fakeFetch, now });
  return { calls, call };
}
async function thread(call: any) {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model: "claude" })).body.thread;
}

test("an attached text file is folded into the message and reaches the AI", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  const out = await call("chat", { threadId: t.id, content: "Summarize this", attachments: [{ name: "notes.md", text: "Line one\nLine two\n\n" }] });
  assert.equal(out.status, 200);
  const expected = "Summarize this\n\n<<<file: notes.md>>>\nLine one\nLine two\n<<<end of file>>>";
  assert.equal((out.body as any).saved.content, expected);
  assert.deepEqual(calls[0]!.body.messages, [{ role: "user", content: expected }]);
});

test("a file can be sent without typed text, saved without a reply, and compared", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  const saved = await call("add_message", { threadId: t.id, attachments: [{ name: "a.txt", text: "A" }] });
  assert.equal((saved.body as any).message.content, "<<<file: a.txt>>>\nA\n<<<end of file>>>");
  assert.equal(calls.length, 0);
  const cmp = await call("compare", { threadId: t.id, attachments: [{ name: "b.csv", text: "x,y" }], models: ["claude", "chatgpt"] });
  assert.equal(cmp.status, 200);
  assert.equal((cmp.body as any).saved.content, "<<<file: b.csv>>>\nx,y\n<<<end of file>>>");
  assert.equal(calls.length, 2);
});

test("files are limited in number, name, kind and total size, and refused before any call", async () => {
  const { call, calls } = harness();
  const t = await thread(call);
  const send = (attachments: unknown, content = "Q") => call("chat", { threadId: t.id, content, attachments });
  const f = (name: string, text = "x") => ({ name, text });
  assert.match(((await send([f("1"), f("2"), f("3"), f("4")])).body as any).error, /at most 3 files/);
  assert.match(((await send([f("bad<name>")])).body as any).error, /plain name/);
  assert.match(((await send([f("a\nb")])).body as any).error, /plain name/);
  assert.match(((await send([f("x".repeat(121))])).body as any).error, /plain name/);
  assert.match(((await send([f("bin.dat", "PNG\u0000\u0001")])).body as any).error, /isn't a text file/);
  assert.match(((await send([f("empty.txt", "  \n")])).body as any).error, /isn't a text file/);
  assert.match(((await send([f("big.txt", "y".repeat(32_000))])).body as any).error, /over 32,000 characters/);
  assert.match(((await send("not a list")).body as any).error, /at most 3 files/);
  assert.equal((await send([], "")).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(((await call("get_thread", { threadId: t.id })).body as any).messages.length, 0);
});

test("the page reads files as text, shows them as collapsible blocks, and never parses HTML", () => {
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  assert.match(js, /await file\.text\(\)/);
  assert.match(js, /el\("details", "file"\)/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|FileReader\.readAsDataURL|readAsDataURL/);
  assert.match(html, /id="cFile" multiple hidden/);
  assert.match(html, /id="cAttach"/);
});
