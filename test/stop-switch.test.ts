import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore, createSupabaseStore } from "../api/_lib/workspace-store.js";

// "Stop everything": one switch that halts all AI activity in the workspace, and fails closed.
// Fake fetch only; no real model or service is ever called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  FIRECRAWL_API_KEY: "synthetic-firecrawl",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-11-24T12:00:00Z");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const claude = (content: any[]) => json({ content, usage: { input_tokens: 1000, output_tokens: 500 } });

function harness(control: boolean | "unreadable" = false, onModel: (n: number, store: any) => Response = () => claude([{ type: "text", text: "Hi" }])) {
  const store = createMemoryStore({ control: control as any });
  const calls: string[] = [];
  let n = 0;
  const fakeFetch = (async (url: any) => {
    calls.push(String(url));
    if (String(url).includes("anthropic")) return onModel(n++, store);
    if (String(url).includes("firecrawl")) return json({ data: { web: [{ title: "r", url: "https://example.com", description: "d" }] } });
    return json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { fetch: fakeFetch, now });
  return { calls, call, store };
}
async function thread(call: any, model = "claude") {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}

test("Stop everything halts every kind of AI work at once, and reading still works", async () => {
  const { call, calls, store } = harness();
  const t = await thread(call);
  await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal(calls.length, 1);

  const s = await call("set_control", { stopped: true });
  assert.deepEqual(s.body, { stopped: true, reason: (s.body as any).reason });
  assert.match((s.body as any).reason, /owner pressed Stop everything/);

  for (const [action, args] of [
    ["chat", { threadId: t.id, content: "Again" }],
    ["chat", { threadId: t.id }],
    ["compare", { threadId: t.id, content: "Q", models: ["claude", "chatgpt"] }],
    ["roundtable", { step: "start", threadId: t.id, content: "Q", models: ["claude", "chatgpt"] }],
    ["roundtable", { step: "critique", threadId: t.id }],
    ["roundtable", { step: "synthesize", threadId: t.id }],
    ["check", { threadId: t.id }],
    ["roundtable", { step: "join", threadId: t.id, model: "chatgpt" }],
  ] as const) {
    const out = await call(action, args);
    assert.equal(out.status, 423, `${action} ${JSON.stringify(args)}`);
    assert.match((out.body as any).error, /Everything is stopped/);
  }
  assert.equal(calls.length, 1, "nothing reached any AI or tool after Stop");
  assert.equal((await store.listMessages(t.id)).length, 2, "nothing new was saved either");

  // The owner can still read everything, and the page learns it's stopped.
  assert.equal((await call("get_thread", { threadId: t.id })).status, 200);
  assert.equal(((await call("models", { threadId: t.id })).body as any).control.stopped, true);

  // Only the owner turns it back on.
  assert.equal((await call("set_control", { stopped: "no" })).status, 400);
  assert.deepEqual((await call("set_control", { stopped: false })).body, { stopped: false, reason: null });
  assert.equal((await call("chat", { threadId: t.id, content: "Back" })).status, 200);
});

test("fail closed: if the switch can't be read, everything counts as stopped", async () => {
  const { call, calls, store } = harness("unreadable");
  const p = (await call("create_project", { name: "P" })).body as any;
  const t = (await call("create_thread", { projectId: p.project.id, title: "T", model: "claude" })).body as any;
  const out = await call("chat", { threadId: t.thread.id, content: "Hi" });
  assert.equal(out.status, 423);
  assert.match((out.body as any).error, /can't be read right now.*fail-safe/);
  assert.equal(calls.length, 0);
  assert.equal(((await call("control")).body as any).stopped, true);
  store._setControl(false);
  assert.equal(((await call("control")).body as any).stopped, false);
});

test("fail closed in the real store: a missing row, a missing table or an outage all read as stopped", async () => {
  const run = async (respond: () => Response) => {
    const store = createSupabaseStore(base, (async () => respond()) as typeof fetch);
    const out = await handle({ method: "POST", headers, body: { action: "control" } }, base, () => store, { fetch: (async () => respond()) as typeof fetch, now });
    return (out.body as any).stopped;
  };
  assert.equal(await run(() => json([])), true, "no row");
  assert.equal(await run(() => json({ message: "relation ws_control does not exist" }, 404)), true, "no table");
  assert.equal(await run(() => json([{ stopped: null }])), true, "odd value");
  assert.equal(await run(() => json([{ stopped: false, updated_at: "x" }])), false, "running");
});

test("pressing Stop during a reply stops it before the next tool call or model call", async () => {
  // First model call asks for a web search; the owner presses Stop while that call is out.
  const { call, calls } = harness(false, (n, store) => {
    if (n === 0) { store._setControl(true); return claude([{ type: "tool_use", id: "t1", name: "web_search", input: { query: "crm tools" } }]); }
    return claude([{ type: "text", text: "should not happen" }]);
  });
  const t = await thread(call);
  const out = await call("chat", { threadId: t.id, content: "Research CRMs" });
  assert.equal(out.status, 200);
  assert.equal(calls.filter((u) => u.includes("firecrawl")).length, 0, "the tool did not run");
  assert.equal(calls.filter((u) => u.includes("anthropic")).length, 1, "no further model call");
  const m = (out.body as any).message;
  assert.match(m.content, /\[Stopped by the owner\] The reply was cut short/);
  assert.equal(m.cost_usd, 0.007, "the call already made is still recorded");
});

test("the switch is on the dashboard and the workspace page, and its script only writes plain text", () => {
  const read = (f: string) => readFileSync(new URL(`../dashboard/${f}`, import.meta.url), "utf8");
  for (const page of ["index.html", "workspace.html"]) {
    const html = read(page);
    assert.match(html, /id="stopSwitch"/, page);
    assert.match(html, /<script src="stop-switch\.js"><\/script>/, page);
  }
  const js = read("stop-switch.js");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(js, /Stop everything/);
  assert.match(js, /Turn AI back on/);
  assert.doesNotMatch(js, /localStorage|sessionStorage/, "the password is never stored");
  assert.match(read("workspace.js"), /c\.abort\(\)/, "the workspace cancels its waiting requests on Stop");
});
