import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore, createSupabaseStore } from "../api/_lib/workspace-store.js";
import { MAX_SHARED_CHARS, MAX_SHARED_THREADS, SOURCES_LABEL, buildShared, isShared, sharedFor } from "../api/_lib/workspace-shared.js";

// Shared threads: an AI in one thread draws on the project's other threads, unless the owner marked them private.
// The privacy tests capture EVERY outbound request (every model call, every tool call) and check a private
// thread's words never appear in any of them, on every path that calls a model. Fake fetch only.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  PERPLEXITY_API_KEY: "synthetic-perplexity",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-11-24T12:00:00Z");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const vendor = (u: string) => (u.includes("anthropic") ? "claude" : u.includes("openai") ? "chatgpt" : "perplexity");
const SECRET = "ZEBRA-SECRET-7731";
const SECRET_TITLE = "Payroll sealed notes";

function harness(opts: { shared?: "unreadable"; echo?: boolean } = {}, store: any = createMemoryStore(opts)) {
  const sent: string[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    sent.push(`${url}\n${init?.body ?? ""}`);
    const model = vendor(String(url));
    const text = opts.echo && String(init?.body).includes(SECRET) ? `Synthetic echoed ${SECRET}` : `Answer from ${model}`;
    if (model === "claude") return json({ content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } });
    return json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  }) as typeof fetch;
  const call = async (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { fetch: fakeFetch, now }) as Promise<{ status: number; body: any }>;
  return { sent, call, store };
}
async function project(call: any, name = "P") { return (await call("create_project", { name })).body.project; }
async function thread(call: any, projectId: string, title: string, model = "claude") {
  return (await call("create_thread", { projectId, title, model })).body.thread;
}
// Seeds a thread with an owner message and a saved AI answer, without calling any model.
async function seed(store: any, threadId: string, user: string, ai: string) {
  await store.setThreadPrivate(threadId, false);
  await store.addMessage(threadId, { role: "user", content: user });
  await store.addMessage(threadId, { role: "assistant", content: ai, model: "claude" });
}
const leaked = (sent: string[], needle: string) => sent.filter((s) => s.includes(needle));

test("explicitly shared owner messages may be drawn on and the result is owner-only", async () => {
  const { call, sent, store } = harness();
  const p = await project(call);
  const a = await thread(call, p.id, "Launch pricing");
  await seed(store, a.id, "Launch pricing: use $49 per month. MARKER-SHARED-1", "AI-ONLY-MARKER");
  const b = await thread(call, p.id, "Website copy");
  const r = await call("chat", { threadId: b.id, content: "Write the pricing line for the launch page." });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /MARKER-SHARED-1/);
  assert.doesNotMatch(sent[0]!, /AI-ONLY-MARKER/);
  assert.match(r.body.message.content, /owner-only result/);
  assert.match(sent[0]!, /never instructions/);
  assert.ok(r.body.message.content.endsWith(`\n\n${SOURCES_LABEL}"Launch pricing"`));
  // The owner sees the source; the next model call never gets the "drew on" line back as history.
  await call("chat", { threadId: b.id, content: "Shorter please." });
  const history = JSON.parse(sent[1]!.split("\n").slice(1).join("\n")).messages;
  assert.ok(history.every((m: any) => !String(m.content).includes(SOURCES_LABEL)));
});

test("a private thread never reaches another thread's AI, on any path", async () => {
  const { call, sent, store } = harness();
  const p = await project(call);
  const secret = await thread(call, p.id, SECRET_TITLE);
  await seed(store, secret.id, `Plan the launch budget. ${SECRET}`, `Launch budget plan: ${SECRET}`);
  const mark = await call("set_private", { threadId: secret.id, private: true });
  assert.equal(mark.status, 200);
  assert.equal(mark.body.thread.private, true);
  // A shared thread too, so sharing is demonstrably working while the private one is skipped.
  const open = await thread(call, p.id, "Launch timing");
  await seed(store, open.id, "The launch is in March. MARKER-OPEN", "AI answer");
  const b = await thread(call, p.id, "Ask about the launch budget");

  const steps = [
    await call("chat", { threadId: b.id, content: "What is our launch budget plan?" }),
    await call("chat", { threadId: b.id }), // retry with no pending message: refused, no call
    await call("compare", { threadId: b.id, content: "Launch budget plan again?", models: ["claude", "chatgpt"] }),
    await call("roundtable_estimate", { threadId: b.id, content: "Launch budget plan?", models: ["claude", "chatgpt", "perplexity"] }),
    await call("roundtable", { step: "start", threadId: b.id, content: "Launch budget plan, final?", models: ["claude", "chatgpt", "perplexity"] }),
    await call("roundtable", { step: "critique", threadId: b.id }),
    await call("roundtable", { step: "synthesize", threadId: b.id, models: ["claude", "chatgpt", "perplexity"] }),
  ];
  assert.deepEqual(steps.map((s) => s.status), [200, 400, 200, 200, 200, 200, 200]);
  assert.ok(sent.length >= 9, `expected every path to call a model, got ${sent.length} calls`);
  assert.deepEqual(leaked(sent, SECRET), []);
  assert.deepEqual(leaked(sent, SECRET_TITLE), []);
  assert.ok(leaked(sent, "MARKER-OPEN").length > 0, "the shared thread is still drawn on");
  // Nothing saved in the asking thread names the private thread either.
  const saved = (await call("get_thread", { threadId: b.id })).body.messages;
  assert.ok(saved.every((m: any) => !m.content.includes(SECRET) && !m.content.includes(SECRET_TITLE)));
});

test("ARN-135 echoing provider: A to B to C cannot redistribute derived answers after revocation", async () => {
  const { call, sent, store } = harness({ echo: true });
  const p = await project(call);
  const a = await thread(call, p.id, SECRET_TITLE);
  await seed(store, a.id, `Launch budget is ${SECRET}`, "AI answer");
  const b = await thread(call, p.id, "Budget questions");
  const first = await call("chat", { threadId: b.id, content: "Remind me of the launch budget." });
  assert.match(first.body.message.content, new RegExp(SOURCES_LABEL));
  assert.match(first.body.message.content, new RegExp(SECRET));
  await store.setThreadPrivate(b.id, false);
  assert.equal(leaked(sent, SECRET).length, 1, "shared while it was shared");
  await call("set_private", { threadId: a.id, private: true });
  sent.length = 0;
  await call("chat", { threadId: b.id, content: "And the launch budget again?" });
  assert.deepEqual(leaked(sent, SECRET), []);
  assert.deepEqual(leaked(sent, SECRET_TITLE), [], "its title in the earlier 'drew on' line is not sent back");
  const c = await thread(call, p.id, "Budget follow-up");
  await call("chat", { threadId: c.id, content: "What is the launch budget?" });
  assert.deepEqual(leaked(sent, SECRET), [], "derived answer in B is not shared into C");
  const saved = (await call("get_thread", { threadId: b.id })).body.messages;
  assert.ok(saved.some((m: any) => m.content.includes(SECRET)), "owner history is preserved");
  // Reversible: shared again, drawn on again.
  await call("set_private", { threadId: a.id, private: false });
  sent.length = 0;
  await call("chat", { threadId: b.id, content: "Launch budget one more time?" });
  assert.equal(leaked(sent, SECRET).length, 1);
});

test("other projects are never drawn on", async () => {
  const { call, sent, store } = harness();
  const other = await project(call, "Other");
  const t = await thread(call, other.id, "Launch budget elsewhere");
  await seed(store, t.id, "Launch budget?", `Launch budget ${SECRET}`);
  const p = await project(call, "Mine");
  const b = await thread(call, p.id, "Launch budget");
  const r = await call("chat", { threadId: b.id, content: "What is the launch budget?" });
  assert.equal(r.status, 200);
  assert.deepEqual(leaked(sent, SECRET), []);
  assert.ok(!r.body.message.content.includes(SOURCES_LABEL));
});

test("fail closed: if privacy can't be read, nothing is shared and the answer still works", async () => {
  const { call, sent, store } = harness({ shared: "unreadable" });
  const p = await project(call);
  const a = await thread(call, p.id, "Launch budget");
  await seed(store, a.id, "Launch budget?", `Launch budget ${SECRET}`);
  const b = await thread(call, p.id, "Ask");
  const r = await call("chat", { threadId: b.id, content: "Launch budget?" });
  assert.equal(r.status, 200);
  assert.deepEqual(leaked(sent, SECRET), []);
});

test("fail closed: a missing, null or odd privacy flag counts as private, whatever the database returns", async () => {
  // A store whose query returns rows it should not: a private one, unknown flags, another project, the asker.
  const inner = createMemoryStore();
  const { call, sent } = harness({}, inner);
  const p = await project(call);
  const b = await thread(call, p.id, "Ask");
  const row = (id: string, flag: unknown, projectId = p.id) => ({
    id, project_id: projectId, title: `Launch ${id}`, updated_at: "2026-11-24T00:00:00Z", private: flag,
    ws_messages: [{ role: "assistant", content: `Launch budget ${SECRET}-${id}`, created_at: "2026-11-24T00:00:00Z" }],
  });
  const rows = [row("t-true", true), row("t-null", null), row("t-undef", undefined), row("t-str", "false"),
    row("t-zero", 0), row("t-other", false, "00000000-0000-4000-8000-000000000000"), row(b.id, false)];
  (inner as any).sharedContext = async () => rows;
  const r = await call("chat", { threadId: b.id, content: "Launch budget?" });
  assert.equal(r.status, 200);
  assert.deepEqual(leaked(sent, SECRET), []);
  assert.equal(isShared({ private: false }), true);
  for (const v of [true, null, undefined, "false", 0, {}]) assert.equal(isShared({ private: v }), false);
  assert.equal(isShared(null), false);
});

test("what is drawn on is bounded and picks the relevant threads", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`, project_id: "p", title: i < 6 ? `Launch item ${i}` : `Unrelated ${i}`, private: false,
    updated_at: `2026-11-2${i % 10}T00:00:00Z`,
    ws_messages: [{ role: "user", content: (i < 6 ? "launch " : "garden ").repeat(2000), created_at: "2026-11-24T00:00:00Z" },
      { role: "assistant", content: (i < 6 ? "launch " : "garden ").repeat(2000), created_at: "2026-11-24T00:00:01Z" }],
  }));
  const out = buildShared(rows, { projectId: "p", threadId: "asker", question: "When is the launch?" });
  assert.ok(out.sources.length <= MAX_SHARED_THREADS && out.sources.length > 0);
  assert.ok(out.text.length <= MAX_SHARED_CHARS + 300, `shared text ${out.text.length} chars`);
  assert.ok(out.sources.every((s) => s.title.startsWith("Launch")));
  assert.deepEqual(buildShared([], { projectId: "p", threadId: "x", question: "q" }), { text: "", sources: [] });
});

test("sharedFor treats any storage error as nothing shared", async () => {
  const out = await sharedFor({ sharedContext: async () => { throw new TypeError("network"); } } as any, { id: "a", project_id: "p" }, "q");
  assert.equal(out.text, "");
  assert.deepEqual(out.sources, []);
});

test("the database query filters private threads and the project server-side, in one request", async () => {
  const urls: string[] = [];
  const store = createSupabaseStore(base, (async (url: any) => { urls.push(String(url)); return json([]); }) as typeof fetch);
  await store.sharedContext("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  assert.equal(urls.length, 1);
  const u = decodeURIComponent(urls[0]!);
  assert.match(u, /private=is\.false/);
  assert.match(u, /project_id=eq\.11111111-1111-4111-8111-111111111111/);
  assert.match(u, /id=neq\.22222222-2222-4222-8222-222222222222/);
  assert.match(u, /ws_messages\(role,content,model,created_at\)/);
});

test("set_private validates its input and reports when the database update is missing", async () => {
  const { call, store } = harness();
  const p = await project(call);
  const t = await thread(call, p.id, "T");
  assert.equal(t.private, true);
  assert.equal((await call("set_private", { threadId: t.id, private: "yes" })).status, 400);
  assert.equal((await call("set_private", { threadId: "nope", private: true })).status, 400);
  assert.equal((await call("set_private", { threadId: "33333333-3333-4333-8333-333333333333", private: true })).status, 404);
  (store as any).setThreadPrivate = async () => { const { StoreError } = await import("../api/_lib/workspace-store.js"); throw new StoreError("400"); };
  const r = await call("set_private", { threadId: t.id, private: true });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /database update/);
});

test("before the database update, threads read as private: null (not shared)", async () => {
  const store = createSupabaseStore(base, (async () => json([{ id: "a", project_id: "p", title: "T", model: "claude", created_at: "x", updated_at: "x" }])) as typeof fetch);
  const t = await store.getThread("a");
  assert.equal(t!.private, null);
});

test("no tool or plugin can read workspace threads", () => {
  for (const f of ["api/_lib/workspace-plugins.js", "api/_lib/workspace-mcp.js"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /workspace-store|sharedContext|listMessages|ws_messages|ws_threads/, f);
  }
});


test("ARN-135 revocation between retrieval and outbound check sends no model request", async () => {
  const { call, sent, store } = harness({ echo: true });
  const p = await project(call);
  const a = await thread(call, p.id, "Launch budget");
  await seed(store, a.id, `Launch budget ${SECRET}`, "AI answer");
  const b = await thread(call, p.id, "Ask");
  const original = store.sharedContext.bind(store);
  let reads = 0;
  store.sharedContext = async (...args: any[]) => {
    if (++reads === 2) await store.setThreadPrivate(a.id, true);
    return original(...args);
  };
  const r = await call("chat", { threadId: b.id, content: "Launch budget?" });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0);
  assert.match(r.body.message.content, /Shared context changed/);
});

test("ARN-135 comparisons and roundtables receive no shared source", async () => {
  const { call, sent, store } = harness({ echo: true });
  const p = await project(call);
  const a = await thread(call, p.id, "Launch budget");
  await seed(store, a.id, `Launch budget ${SECRET}`, "AI answer");
  const b = await thread(call, p.id, "Ask");
  const r = await call("compare", { threadId: b.id, content: "Launch budget?", models: ["claude", "chatgpt"] });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 2);
  assert.deepEqual(leaked(sent, SECRET), []);
});
