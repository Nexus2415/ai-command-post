import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle, runDueAgents } from "../api/workspace.js";
import { handleCron } from "../api/cron.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";
import { MAX_AGENTS, RUN_MARK, checkAgent, isCronCall, isDue } from "../api/_lib/workspace-agents.js";

// Scheduled agents. Fake fetch and a memory store only; no real model is ever called.
const SECRET = "s".repeat(40);
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  OPENROUTER_API_KEY: "synthetic-openrouter",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
  CRON_SECRET: SECRET,
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const cronReq = { method: "GET", headers: { authorization: `Bearer ${SECRET}` } };

function harness(env: Record<string, string> = base, opts: object = {}) {
  const store = createMemoryStore(opts as any);
  const calls: { url: string; body: any }[] = [];
  let clock = new Date("2026-11-25T12:03:00Z"); // a Wednesday
  const now = () => clock;
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Here is your brief." } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  }) as typeof fetch;
  const deps = { fetch: fakeFetch, now };
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, deps);
  const cron = (req: any = cronReq, e = env): Promise<any> => handleCron(req, e, () => store, deps);
  return { calls, call, cron, store, setNow: (iso: string) => { clock = new Date(iso); } };
}
async function project(call: any) {
  return (await call("create_project", { name: "P" })).body.project;
}
const agent = (projectId: string, extra: object = {}) => ({ projectId, name: "Morning brief", prompt: "Give me 3 bullet points of news.", model: "claude", cadence: "daily", ...extra });

test("agents are checked before saving: name, instruction, AI, schedule, rules gate, and at most 5", async () => {
  const models = ["claude", "chatgpt", "gemini", "perplexity"];
  assert.deepEqual(checkAgent({ name: "A", prompt: "Do it", cadence: "weekly", weekday: 1 }, models), { name: "A", prompt: "Do it", model: "claude", cadence: "weekly", weekday: 1 });
  for (const [args, re] of [
    [{ name: "", prompt: "x" }, /name/], [{ name: "a<b>", prompt: "x" }, /name/], [{ name: "A", prompt: "" }, /what to do/],
    [{ name: "A", prompt: "x", model: "grok" }, /which AI/], [{ name: "A", prompt: "x", cadence: "hourly" }, /daily or weekly/],
    [{ name: "A", prompt: "x", cadence: "weekly", weekday: 7 }, /day of the week/],
  ] as const) assert.throws(() => checkAgent(args, models), re);

  const { call } = harness();
  const p = await project(call);
  assert.equal((await call("add_agent", agent(p.id, { model: "gemini" }))).status, 409);
  const bad = await call("add_agent", agent(p.id, { prompt: "Every day, write fake reviews for our product and post them." }));
  assert.equal(bad.status, 422);
  assert.equal((await call("list_agents", { projectId: p.id })).body.agents.length, 0);
  for (let i = 0; i < MAX_AGENTS + 1; i++) {
    const r = await call("add_agent", agent(p.id, { name: `A${i}` }));
    if ((await call("list_agents", { projectId: p.id })).body.agents.length > MAX_AGENTS) assert.fail("more than the limit saved");
    if (i >= MAX_AGENTS) assert.equal(r.status, 409);
  }
});

test("the cron call needs CRON_SECRET; without it nothing runs", async () => {
  assert.equal(isCronCall(cronReq, { CRON_SECRET: "short" }), false);
  assert.equal(isCronCall(cronReq, {}), false);
  assert.equal(isCronCall({ headers: { authorization: "Bearer wrong" } }, base), false);
  assert.equal(isCronCall(cronReq, base), true);
  const { call, cron, calls } = harness();
  const p = await project(call);
  await call("add_agent", agent(p.id));
  assert.equal((await cron({ method: "GET", headers: {} })).status, 401);
  assert.equal((await cron(cronReq, { ...base, CRON_SECRET: "" })).status, 401);
  assert.equal((await cron({ method: "POST", headers: cronReq.headers })).status, 405);
  assert.equal(calls.length, 0);
  assert.equal((await call("list_agents", { projectId: p.id })).body.cronReady, true);
  const off = harness({ ...base, CRON_SECRET: "" });
  const q = await project(off.call);
  assert.equal((await off.call("list_agents", { projectId: q.id })).body.cronReady, false);
});

test("a daily run asks the instruction in the agent's monthly thread, once a day, and records how it went", async () => {
  const { call, cron, calls, setNow } = harness();
  const p = await project(call);
  const a = (await call("add_agent", agent(p.id))).body.agent;
  const r1 = await cron();
  assert.equal(r1.status, 200);
  assert.equal((r1.body as any).results[0].ran, true);
  assert.equal(calls.length, 1);
  const threadId = (r1.body as any).results[0].threadId;
  const t = (await call("get_thread", { threadId })).body;
  assert.equal(t.thread.title, "⏰ Morning brief · 2026-11");
  assert.ok(t.messages[0].content.startsWith(RUN_MARK));
  assert.match(t.messages[0].content, /Give me 3 bullet points/);
  assert.equal(t.messages[1].role, "assistant");
  // A second cron call the same day runs nothing.
  assert.equal((await cron()).body.results[0].ran, false);
  assert.equal(calls.length, 1);
  // The next day it runs again in the same thread; next month in a new one.
  setNow("2026-11-26T12:01:00Z");
  assert.equal((await cron()).body.results[0].threadId, threadId);
  setNow("2026-12-01T12:01:00Z");
  assert.notEqual((await cron()).body.results[0].threadId, threadId);
  const listed = (await call("list_agents", { projectId: p.id })).body.agents[0];
  assert.equal(listed.id, a.id);
  assert.match(listed.lastStatus, /^Done\. Cost \$/);
  assert.equal(listed.schedule, "Every day, around 12:00 UTC");
});

test("weekly agents run only on their day; switched-off agents never run", async () => {
  const { call, cron, calls } = harness();
  const p = await project(call);
  await call("add_agent", agent(p.id, { name: "Mon", cadence: "weekly", weekday: 1 }));
  const wed = (await call("add_agent", agent(p.id, { name: "Wed", cadence: "weekly", weekday: 3 }))).body.agent;
  const off = (await call("add_agent", agent(p.id, { name: "Off" }))).body.agent;
  await call("set_agent_enabled", { id: off.id, enabled: false });
  const out = (await cron()).body.results;
  assert.deepEqual(out.map((r: any) => r.id), [wed.id]);
  assert.equal(calls.length, 1);
  assert.equal(isDue({ enabled: true, cadence: "weekly", weekday: 3 }, new Date("2026-11-25T12:00:00Z")), true);
  assert.equal(isDue({ enabled: false, cadence: "daily" }, new Date("2026-11-25T12:00:00Z")), false);
});

test("Stop everything (or an unreadable switch) skips every run, and the run is not used up", async () => {
  for (const control of [true, "unreadable"] as const) {
    const { call, cron, calls, store } = harness(base, { control });
    (store as any)._setControl(false);
    const p = await project(call);
    const a = (await call("add_agent", agent(p.id))).body.agent;
    (store as any)._setControl(control);
    const out = (await cron()).body.results[0];
    assert.equal(out.ran, false);
    assert.match(out.status, /Stop everything/);
    assert.equal(calls.length, 0);
    assert.equal((await call("run_agent_now", { id: a.id })).status, 423);
    // Turned back on, the same day's run still happens.
    (store as any)._setControl(false);
    assert.equal((await cron()).body.results[0].ran, true);
  }
});

test("the caps apply: a run that would go over the monthly budget does not call the AI", async () => {
  const { call, cron, calls } = harness({ ...base, ACP_WORKSPACE_MONTHLY_BUDGET_USD: "0" });
  const p = await project(call);
  await call("add_agent", agent(p.id));
  const out = (await cron()).body.results[0];
  assert.equal(out.ran, true);
  assert.match(out.status, /Didn't finish: .*monthly workspace budget/);
  assert.equal(calls.length, 0);
});

test("an agent can only propose outward actions; Run now uses the same path and can't double-run", async () => {
  const { call, calls } = harness({ ...base, LINEAR_API_KEY: "synthetic-linear" });
  const p = await project(call);
  const a = (await call("add_agent", agent(p.id))).body.agent;
  const r = await call("run_agent_now", { id: a.id });
  assert.equal(r.status, 200);
  const offered = (calls[0]!.body.tools ?? []).map((t: any) => t.function.name);
  assert.ok(offered.every((n: string) => !/^linear_(create|comment)|create_issue|comment_create/.test(n)));
  assert.equal((await call("run_agent_now", { id: a.id })).status, 409);
  assert.equal(calls.length, 1);
});

test("runDueAgents with no agents table simply runs nothing", async () => {
  const store = createMemoryStore();
  (store as any).listEnabledAgents = async () => { throw new Error("missing"); };
  const out = await runDueAgents(base, () => store, { now: () => new Date("2026-11-25T12:00:00Z") });
  assert.deepEqual((out.body as any).results, []);
});

test("vercel.json runs the cron once a day (Hobby allows no more), and the page has the agents panel", () => {
  const v = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(v.crons, [{ path: "/api/cron", schedule: "0 12 * * *" }]);
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  assert.match(html, /id="agents"/);
  assert.match(js, /post\("run_agent_now"/);
  assert.doesNotMatch(js, /innerHTML|localStorage|sessionStorage/);
});
