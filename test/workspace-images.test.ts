import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";
import { IMAGE_TOKENS, MAX_IN_CONTEXT, PDF_TOKENS_PER_PAGE, checkUpload, pdfPages } from "../api/_lib/workspace-files.js";
import { estimateUsd } from "../api/_lib/workspace-models.js";

// Images and PDFs in a thread. Synthetic files and a fake fetch only; no real model is ever called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-11-25T12:00:00Z");

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 7)]).toString("base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString("base64");
const pdf = (pages: number) => Buffer.from("%PDF-1.7\n" + Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page >> endobj\n`).join("") + "2 0 obj << /Type /Pages >> endobj\n%%EOF", "latin1").toString("base64");

function harness(env: Record<string, string>, store = createMemoryStore()) {
  const calls: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes("anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "text", text: "I see it" }], usage: { input_tokens: 10, output_tokens: 10 } }));
    return new Response(JSON.stringify({ choices: [{ message: { content: "I see it too" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, { fetch: fakeFetch, now });
  return { calls, call, store };
}
async function thread(call: any, model = "claude") {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}
const up = async (call: any, threadId: string, name: string, mime: string, data: string) => (await call("upload_file", { threadId, name, mime, data })).body.file;

test("uploads are checked: kind, real contents, size, page count and name", () => {
  assert.equal(checkUpload({ name: "a.png", mime: "image/png", data: PNG }).kind, "image");
  assert.equal(checkUpload({ name: "a.pdf", mime: "application/pdf", data: pdf(4) }).pages, 4);
  const bad = (args: object, re: RegExp) => assert.throws(() => checkUpload(args), re);
  bad({ name: "a.svg", mime: "image/svg+xml", data: PNG }, /Only images/);
  bad({ name: "a.png", mime: "image/png", data: JPEG }, /isn't really/);
  bad({ name: "a.pdf", mime: "application/pdf", data: PNG }, /isn't really a PDF/);
  bad({ name: "a.png", mime: "image/png", data: "not base64!" }, /one piece/);
  bad({ name: "a<b>.png", mime: "image/png", data: PNG }, /plain name/);
  bad({ name: "a#b.png", mime: "image/png", data: PNG }, /plain name/);
  bad({ name: "big.pdf", mime: "application/pdf", data: pdf(31) }, /31 pages/);
  bad({ name: "huge.png", mime: "image/png", data: Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(1_500_001)]).toString("base64") }, /too big/);
  // A PDF whose pages can't be counted is counted by size, high.
  assert.equal(pdfPages(Buffer.from("%PDF-1.7 " + "x".repeat(65_000))), 3);
});

test("an image and a PDF reach Claude as image and document blocks, and the message keeps only markers", async () => {
  const { call, calls } = harness({ ...base, ANTHROPIC_API_KEY: "synthetic-anthropic" });
  const t = await thread(call);
  const img = await up(call, t.id, "photo.png", "image/png", PNG);
  const doc = await up(call, t.id, "rfq.pdf", "application/pdf", pdf(2));
  assert.deepEqual([img.pages, doc.pages], [0, 2]);
  const out = await call("chat", { threadId: t.id, content: "What's in these?", files: [img.id, doc.id] });
  assert.equal(out.status, 200);
  const saved = (out.body as any).saved.content;
  assert.equal(saved, `What's in these?\n\n<<<attached image: photo.png #${img.id}>>>\n<<<attached PDF, 2 pages: rfq.pdf #${doc.id}>>>`);
  assert.doesNotMatch(saved, /base64|PNG/);
  const content = calls[0]!.body.messages.at(-1).content;
  assert.deepEqual(content.map((c: any) => c.type), ["image", "document", "text"]);
  assert.deepEqual(content[0].source, { type: "base64", media_type: "image/png", data: PNG });
  assert.equal(content[1].source.media_type, "application/pdf");
  assert.equal(content[2].text, saved);
});

test("through OpenRouter, files go as image_url and file parts, with the free PDF text parser", async () => {
  const { call, calls } = harness({ ...base, OPENROUTER_API_KEY: "synthetic-openrouter" });
  const t = await thread(call);
  const img = await up(call, t.id, "photo.jpg", "image/jpeg", JPEG);
  const doc = await up(call, t.id, "rfq.pdf", "application/pdf", pdf(1));
  assert.equal((await call("chat", { threadId: t.id, files: [img.id, doc.id] })).status, 200);
  const body = calls[0]!.body;
  assert.deepEqual(body.plugins, [{ id: "file-parser", pdf: { engine: "pdf-text" } }]);
  const parts = body.messages.at(-1).content;
  assert.equal(parts[1].image_url.url, `data:image/jpeg;base64,${JPEG}`);
  assert.deepEqual(parts[2].file, { filename: "rfq.pdf", file_data: `data:application/pdf;base64,${pdf(1)}` });
  // A text-only question afterwards still shows the newest files to the AI.
  await call("chat", { threadId: t.id, content: "And the date?" });
  const again = calls[1]!.body.messages;
  assert.equal(again.at(-1).content, "And the date?");
  assert.ok(again.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "image_url")));
});

test("only the thread's newest files go to the AI, and a file from another thread is refused", async () => {
  const { call, calls } = harness({ ...base, ANTHROPIC_API_KEY: "synthetic-anthropic" });
  const t = await thread(call);
  const ids = [];
  for (let i = 0; i < MAX_IN_CONTEXT + 1; i++) {
    const f = await up(call, t.id, `p${i}.png`, "image/png", PNG);
    ids.push(f.id);
    await call("add_message", { threadId: t.id, files: [f.id] });
  }
  await call("chat", { threadId: t.id, content: "Compare them" });
  const images = calls[0]!.body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((c: any) => c.type === "image");
  assert.equal(images.length, MAX_IN_CONTEXT);

  const other = await thread(call);
  const before = calls.length;
  const r = await call("chat", { threadId: other.id, content: "Peek", files: [ids[0]] });
  assert.equal(r.status, 400);
  assert.match((r.body as any).error, /isn't in this thread/);
  assert.equal((await call("get_file", { threadId: other.id, fileId: ids[0] })).status, 404);
  assert.equal((await call("chat", { threadId: t.id, content: "x", files: ids })).status, 400);
  assert.equal(calls.length, before);
  assert.equal(((await call("get_file", { threadId: t.id, fileId: ids[0] })).body as any).file.data, PNG);
});

test("Perplexity never gets the files; it is told it can't open them", async () => {
  const { call, calls } = harness({ ...base, PERPLEXITY_API_KEY: "synthetic-perplexity" });
  const t = await thread(call, "perplexity");
  const img = await up(call, t.id, "photo.png", "image/png", PNG);
  assert.equal((await call("chat", { threadId: t.id, content: "What is it?", files: [img.id] })).status, 200);
  const last = calls[0]!.body.messages.at(-1);
  assert.equal(typeof last.content, "string");
  assert.match(last.content, /can't open attached files/);
  assert.doesNotMatch(JSON.stringify(calls[0]!.body), new RegExp(PNG.slice(0, 20).replace(/[+/]/g, "\\$&")));
});

test("file tokens count against the caps before any call; big uploads only fit the upload action", async () => {
  assert.ok(estimateUsd("claude", [{ content: "x", files: [{ mime: "application/pdf", pages: 30 }] }] as any) >
    estimateUsd("claude", [{ content: "x" }]) + (30 * PDF_TOKENS_PER_PAGE * 2) / 1e6 - 1e-9);
  assert.ok(IMAGE_TOKENS > 0);
  const { call, calls } = harness({ ...base, ANTHROPIC_API_KEY: "synthetic-anthropic", ACP_WORKSPACE_THREAD_BUDGET_USD: "0.1" });
  const t = await thread(call);
  const doc = await up(call, t.id, "long.pdf", "application/pdf", pdf(30));
  const r = await call("chat", { threadId: t.id, content: "Summarize", files: [doc.id] });
  assert.equal(r.status, 402);
  assert.equal(calls.length, 0);
  // A text-only question of the same length fits.
  assert.equal((await call("chat", { threadId: t.id, content: "Summarize" })).status, 200);

  const big = "x".repeat(70_000);
  const raw = (action: string) => handle({ method: "POST", headers, body: JSON.stringify({ action, args: { threadId: t.id, content: big } }) }, base, () => createMemoryStore(), { now });
  assert.equal((await raw("chat")).status, 413);
  assert.notEqual((await raw("upload_file")).status, 413);
});

test("the page shrinks images, shows files through blob links, and never parses HTML", () => {
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  assert.match(js, /createImageBitmap/);
  assert.match(js, /URL\.createObjectURL/);
  assert.match(js, /post\("upload_file"/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB/);
  assert.match(html, /application\/pdf/);
});
