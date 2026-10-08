import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/console.js";
import { TEAM_ID, PROJECT_ID, laneOf, ownerOf, overviewOf, safeLinearUrl } from "../api/lib/console-state.js";

const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
const req = (body: any = { action: "overview" }, headers = {}) => ({
  method: "POST", headers: { "x-acp-password": "pw", ...headers }, body,
});
const item = (id = "ARN-54", type = "started", extra = {}) => ({
  id: "uuid", identifier: id, title: "[Perplexity] Backend", url: "https://linear.app/arnexyia/issue/" + id,
  priority: 1, updatedAt: "2026-10-08T14:00:00Z", completedAt: null,
  state: { name: "In Progress", type }, team: { id: TEAM_ID }, project: { id: PROJECT_ID },
  labels: { nodes: [] }, ...extra,
});
const mock = (data: any, status = 200) => {
  const calls: any[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url, ...JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify(data), { status });
  }) as typeof fetch;
  return { f, calls };
};

test("console rejects unconfigured/unauthenticated/cross-site requests before Linear", async () => {
  const { f, calls } = mock({});
  assert.equal((await handle(req(), {}, f)).status, 503);
  assert.equal((await handle(req({}, { "x-acp-password": "bad" }), env, f)).status, 401);
  assert.equal((await handle(req({}, { "sec-fetch-site": "cross-site" }), env, f)).status, 403);
  assert.equal((await handle(req({}, { origin: "https://evil.example", host: "console.example" }), env, f)).status, 403);
  assert.equal((await handle(req({}, { origin: "null", host: "console.example" }), env, f)).status, 403);
  assert.equal(calls.length, 0);
});

test("console rejects malformed, large, wrong-method, write and scope-changing requests", async () => {
  const { f, calls } = mock({});
  for (const body of ["{", null, [], { action: "execute" }, { action: "overview", projectId: "other" },
    { action: "thread", identifier: "OTHER-1" }, { action: "thread", identifier: ["ARN-1"] }]) {
    assert.equal((await handle(req(body), env, f)).status, 400);
  }
  assert.equal((await handle({ ...req(), method: "GET" }, env, f)).status, 405);
  assert.equal((await handle(req({ action: "overview", filler: "x".repeat(9000) }), env, f)).status, 413);
  assert.equal(calls.length, 0);
});

test("overview fixes scope, filters upstream leakage, labels workload honestly and is read-only", async () => {
  const { f, calls } = mock({ data: { issues: {
    nodes: [item(), item("ARN-49", "unstarted", { title: "[Claude] UI" }),
      item("ARN-80", "started", { project: { id: "foreign" } })],
    pageInfo: { hasNextPage: true },
  } } });
  const out = await handle(req(), env, f, () => new Date("2026-10-08T15:00:00Z"));
  assert.equal(out.status, 200);
  const body: any = out.body;
  assert.deepEqual(body.lanes.active, ["ARN-54"]);
  assert.deepEqual(body.lanes.queued, ["ARN-49"]);
  assert.equal(body.issues.length, 2);
  assert.equal(body.agents.find((a: any) => a.key === "claude").nextTask, "ARN-49");
  assert.ok(body.agents.every((a: any) => a.connection === "not_verified"));
  assert.equal(body.fetchedAt, "2026-10-08T15:00:00.000Z");
  assert.equal(body.hasNextPage, true);
  assert.deepEqual(calls[0].variables, { team: TEAM_ID, project: PROJECT_ID });
  assert.match(calls[0].query, /^query /);
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(JSON.stringify(body).includes("lin\""), false);
});

test("terminal canceled and duplicate work never enters the completed lane", () => {
  assert.equal(laneOf(item("ARN-1", "completed")), "done");
  assert.equal(laneOf(item("ARN-1", "canceled")), "canceled");
  assert.equal(laneOf(item("ARN-1", "duplicate")), "canceled");
  assert.equal(laneOf(item("ARN-1", "started", { labels: { nodes: [{ name: "blocked" }] } })), "blocked");
  assert.equal(laneOf(item("ARN-1", "started", { state: { name: "In Review", type: "started" } })), "review");
  assert.equal(laneOf(item("ARN-1", "unknown")), "queued");
});

test("agent recognition is anchored and next queued task respects actual priority", () => {
  assert.equal(ownerOf("[ChatGPT] Plan"), "chatgpt");
  assert.equal(ownerOf("quoted [Claude] unrelated"), null);
  const body = overviewOf([
    item("ARN-100", "unstarted", { priority: 0 }),
    item("ARN-52", "unstarted", { priority: 2 }),
    item("ARN-54", "unstarted", { priority: 1 }),
  ], "t");
  assert.equal(body.agents.find(a => a.key === "perplexity")?.nextTask, "ARN-54");
});

test("ownership preserves engine prefix precedence, whitespace, aliases, labels and assignees", () => {
  assert.equal(ownerOf("  [Claude] UI"), "claude");
  assert.equal(ownerOf("[OpenAI] Plan"), "chatgpt");
  assert.equal(ownerOf({ title: "No prefix", labels: { nodes: [{ name: "gemini" }] } }), "gemini");
  assert.equal(ownerOf({ title: "No prefix", assignee: { name: "Perplexity" } }), "perplexity");
  assert.equal(ownerOf({ title: "[ChatGPT] Plan", labels: { nodes: [{ name: "claude" }] } }), "chatgpt");
  const o = overviewOf([
    item("ARN-49", "started", { title: "UI", assignee: { name: "Claude" } }),
    item("ARN-50", "unstarted", { title: "Intake", labels: { nodes: [{ name: "claude" }] } }),
  ], "t");
  assert.deepEqual(o.agents.find(a => a.key === "claude")?.active, ["ARN-49"]);
  assert.equal(o.agents.find(a => a.key === "claude")?.nextTask, "ARN-50");
});

test("thread checks team and project after issue lookup and cannot reveal a foreign issue", async () => {
  for (const issue of [null, item("ARN-1", "started", { team: { id: "other" } }),
    item("ARN-1", "started", { project: { id: "other" } })]) {
    const { f } = mock({ data: { issue } });
    assert.equal((await handle(req({ action: "thread", identifier: "ARN-1" }), env, f)).status, 404);
  }
});

test("thread preserves comment text without claiming agent identity or unsafe URLs", async () => {
  const { f } = mock({ data: { issue: {
    ...item(), description: "Test only", comments: {
      nodes: [{ id: "c", body: "<script>do not render as HTML</script>", user: { name: "Darius Williams" },
        url: "javascript:alert(1)", createdAt: "t", updatedAt: "t" }], pageInfo: { hasPreviousPage: true },
    },
  } } });
  const result: any = await handle(req({ action: "thread", identifier: "ARN-54" }), env, f);
  assert.equal(result.status, 200);
  assert.equal(result.body.comments[0].authorVerifiedAsAgent, false);
  assert.equal(result.body.comments[0].url, null);
  assert.equal(result.body.hasPreviousPage, true);
  assert.equal(result.body.comments[0].body, "<script>do not render as HTML</script>");
});

test("URL sanitizer rejects lookalikes, credentials, and non-HTTPS links", () => {
  for (const url of ["javascript:alert(1)", "https://linear.app.evil/x", "https://pw@linear.app/x", "http://linear.app/x"]) {
    assert.equal(safeLinearUrl(url), null);
  }
  assert.equal(safeLinearUrl("https://linear.app/arnexyia/issue/ARN-1"), "https://linear.app/arnexyia/issue/ARN-1");
});

test("upstream errors and malformed replies are sanitized; no false empty success", async () => {
  for (const data of [{ errors: [{ message: "secret lin pw" }] }, { data: {} }]) {
    const { f } = mock(data);
    const result = await handle(req(), env, f);
    assert.equal(result.status, 502);
    assert.equal(JSON.stringify(result.body).includes("secret"), false);
  }
});
