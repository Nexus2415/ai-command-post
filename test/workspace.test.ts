import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore, createSupabaseStore, workspaceConfigured } from "../api/lib/workspace-store.js";

// Phase 1 workspace storage. Fakes only: the memory store and a fake fetch for the REST adapter.
const env = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
};
const headers = { "x-acp-password": env.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const req = (action: string, args: object = {}, extra: object = {}) =>
  ({ method: "POST", headers: { ...headers, ...extra }, body: { action, args } });

function harness() {
  const store = createMemoryStore();
  return (action: string, args: object = {}, extra: object = {}) => handle(req(action, args, extra), env, () => store);
}

test("projects, threads and messages round-trip in order", async () => {
  const call = harness();
  const p = (await call("create_project", { name: "  Arnexyia launch  " })).body as any;
  assert.equal(p.project.name, "Arnexyia launch");
  const t1 = (await call("create_thread", { projectId: p.project.id, title: "Pricing", model: "gemini" })).body as any;
  const t2 = (await call("create_thread", { projectId: p.project.id, title: "Hiring" })).body as any;
  assert.equal(t2.thread.model, "claude", "Claude is the default model");

  await call("add_message", { threadId: t1.thread.id, content: "First" });
  await call("add_message", { threadId: t1.thread.id, content: "Second" });

  const threads = (await call("list_threads", { projectId: p.project.id })).body as any;
  assert.deepEqual(threads.threads.map((t: any) => t.title), ["Pricing", "Hiring"], "the newest activity comes first");

  const got = (await call("get_thread", { threadId: t1.thread.id })).body as any;
  assert.deepEqual(got.messages.map((m: any) => [m.role, m.content]), [["user", "First"], ["user", "Second"]]);
  assert.equal(((await call("list_projects")).body as any).projects.length, 1);
});

test("clients can only post their own messages, never a model's reply", async () => {
  const call = harness();
  const p = (await call("create_project", { name: "P" })).body as any;
  const t = (await call("create_thread", { projectId: p.project.id, title: "T" })).body as any;
  await call("add_message", { threadId: t.thread.id, content: "Hi", role: "assistant", cost_usd: -5, model: "gemini" });
  const [m] = ((await call("get_thread", { threadId: t.thread.id })).body as any).messages;
  assert.equal(m.role, "user");
  assert.equal(m.cost_usd, 0);
  assert.equal(m.model, null);
});

test("bad input is refused before storage is touched", async () => {
  const call = harness();
  const p = (await call("create_project", { name: "P" })).body as any;
  const cases: [string, object, number][] = [
    ["create_project", { name: "" }, 400],
    ["create_project", { name: "x".repeat(121) }, 400],
    ["create_thread", { projectId: "not-an-id", title: "T" }, 400],
    ["create_thread", { projectId: p.project.id, title: "T", model: "grok" }, 400],
    ["create_thread", { projectId: "00000000-0000-4000-8000-000000000000", title: "T" }, 404],
    ["list_threads", { projectId: "1;drop table ws_projects" }, 400],
    ["get_thread", { threadId: "00000000-0000-4000-8000-000000000000" }, 404],
    ["add_message", { threadId: "00000000-0000-4000-8000-000000000000", content: "x" }, 404],
    ["delete_project", {}, 400],
  ];
  for (const [action, args, status] of cases) {
    assert.equal((await call(action, args)).status, status, `${action} ${JSON.stringify(args)}`);
  }
});

test("password, origin, method and setup are checked first", async () => {
  let made = 0;
  const makeStore = () => { made++; return createMemoryStore(); };
  const ok = req("list_projects");
  assert.equal((await handle({ ...ok, headers: { ...headers, "x-acp-password": "wrong" } }, env, makeStore)).status, 401);
  assert.equal((await handle({ ...ok, headers: { ...headers, origin: "https://evil.example" } }, env, makeStore)).status, 403);
  assert.equal((await handle({ ...ok, headers: { "x-acp-password": env.ACP_SITE_PASSWORD } }, env, makeStore)).status, 403);
  assert.equal((await handle({ ...ok, method: "GET" }, env, makeStore)).status, 405);
  assert.equal((await handle(ok, { ...env, ACP_WORKSPACE_DB_KEY: "" }, makeStore)).status, 503);
  assert.equal((await handle(ok, { ...env, ACP_WORKSPACE_DB_URL: "http://plain.example" }, makeStore)).status, 503);
  assert.equal((await handle(ok, { ...env, ACP_SITE_PASSWORD: "" }, makeStore)).status, 503);
  assert.equal(made, 0);
  assert.equal(workspaceConfigured(env), true);
});

test("the REST adapter sends the key only in headers and hides database errors", async () => {
  const seen: { url: string; init: any }[] = [];
  const fake = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    if (String(url).includes("ws_threads")) return new Response('{"message":"relation secret_internal does not exist"}', { status: 500 });
    return new Response(JSON.stringify([{ id: "00000000-0000-4000-8000-000000000001", name: "P", created_at: "x" }]), { status: 201 });
  }) as typeof fetch;
  const store = createSupabaseStore(env, fake);
  const p = await store.createProject("P");
  assert.equal(p.name, "P");
  assert.equal(seen[0]!.url, "https://synthetic.supabase.co/rest/v1/ws_projects?select=id,name,created_at");
  assert.equal(seen[0]!.init.headers.apikey, env.ACP_WORKSPACE_DB_KEY);
  assert.equal(seen[0]!.init.headers.prefer, "return=representation");
  assert.ok(!seen[0]!.url.includes(env.ACP_WORKSPACE_DB_KEY));

  const out = await handle(req("list_threads", { projectId: p.id }), env, () => createSupabaseStore(env, fake));
  assert.equal(out.status, 502);
  assert.doesNotMatch(JSON.stringify(out.body), /secret_internal/);
});

test("the schema keeps the workspace locked to the server", () => {
  const sql = readFileSync(new URL("../db/workspace.sql", import.meta.url), "utf8");
  for (const t of ["ws_projects", "ws_threads", "ws_messages"]) {
    assert.match(sql, new RegExp(`alter table ${t} enable row level security`));
  }
  assert.match(sql, /revoke all on ws_projects, ws_threads, ws_messages from anon, authenticated/);
  assert.doesNotMatch(sql, /create policy/i, "no policies: only the service key reaches these tables");
  assert.match(sql, /model in \('claude', 'chatgpt', 'gemini', 'perplexity'\)/);
});

test("the workspace page renders untrusted text safely and keeps the password out of storage", () => {
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(js, /fetch\("\/api\/workspace"/);
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  assert.match(html, /<script src="workspace\.js"><\/script>/);
  assert.match(readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8"), /href="\/workspace\.html"/);
});
