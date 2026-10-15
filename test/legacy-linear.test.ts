import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/linear.js";
import { TEAM_ID, PROJECT_ID } from "../api/lib/console-state.js";

// ARN-47: the legacy adapter is read-only and fixed to the owner-console scope.
// All command creation goes through /api/intake. No external calls in these tests.
const env = { ACP_SITE_PASSWORD: "synthetic-password", LINEAR_API_KEY: "synthetic-token" };
const req = (tool: string, args: object = {}, headers: object = {}) => ({
  method: "POST", headers: { "x-acp-password": env.ACP_SITE_PASSWORD, ...headers },
  body: { tool, args },
});

test("legacy save_issue cannot write even with a valid password", async () => {
  let calls = 0;
  const neverFetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  for (const args of [
    { team: "Arnexyia", title: "[Gemini] suspended lead" },
    { team: "Arnexyia", title: "[Claude] unauthorized legacy write" },
  ]) {
    const out = await handle(req("save_issue", args), env, neverFetch);
    assert.equal(out.status, 400);
  }
  assert.equal(calls, 0);
});

test("legacy team discovery exposes only the fixed Arnexyia scope without an upstream call", async () => {
  let calls = 0;
  const neverFetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  const out = await handle(req("list_teams"), env, neverFetch);
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as any).teams, [{ name: "Arnexyia", key: "ARN" }]);
  assert.equal(calls, 0);
});

test("legacy issue reads bind team and project server-side and filter upstream leakage", async () => {
  const scoped = { identifier: "ARN-47", title: "Acceptance", url: "https://linear.app/arnexyia/issue/ARN-47",
    priority: 1, priorityLabel: "Urgent", updatedAt: "2026-10-15T00:00:00Z", completedAt: null,
    createdAt: "2026-10-01T00:00:00Z", team: { id: TEAM_ID }, project: { id: PROJECT_ID },
    state: { name: "In Progress", type: "started" }, labels: { nodes: [] }, assignee: null };
  const foreign = { ...scoped, identifier: "OTHER-1", project: { id: "foreign-project" } };
  let calls = 0;
  const fakeFetch = (async (_url: any, init: any) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.match(request.query, /^query/);
    assert.deepEqual(request.variables, { team: TEAM_ID, project: PROJECT_ID });
    assert.doesNotMatch(request.query, /mutation|issueCreate/);
    return new Response(JSON.stringify({ data: { issues: {
      nodes: [scoped, foreign], pageInfo: { hasNextPage: true },
    } } }), { status: 200 });
  }) as typeof fetch;
  const out = await handle(req("list_issues"), env, fakeFetch);
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as any).issues.map((i: any) => i.id), ["ARN-47"]);
  assert.equal((out.body as any).hasNextPage, true);
  assert.equal(calls, 1);
});

test("legacy reads reject cross-site, malformed, oversized and scope-changing requests before Linear", async () => {
  let calls = 0;
  const neverFetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  assert.equal((await handle(req("list_issues", {}, { "sec-fetch-site": "cross-site" }), env, neverFetch)).status, 403);
  assert.equal((await handle(req("list_issues", {}, { origin: "https://evil.example", host: "console.example" }), env, neverFetch)).status, 403);
  for (const args of [{ team: "Other" }, { teamId: "other" }, { project: "Other" }, { projectId: "other" }, { url: "https://other.example" }]) {
    assert.equal((await handle(req("list_issues", args), env, neverFetch)).status, 400);
  }
  assert.equal((await handle({ ...req("list_issues"), body: "{" }, env, neverFetch)).status, 400);
  assert.equal((await handle({ ...req("list_issues"), body: JSON.stringify({ tool: "list_issues", args: {}, filler: "x".repeat(9000) }) }, env, neverFetch)).status, 413);
  assert.equal(calls, 0);
});

test("legacy upstream failures are generic and never expose response details", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({
    errors: [{ message: "synthetic-token internal detail" }],
  }), { status: 500 })) as typeof fetch;
  const out = await handle(req("list_issues"), env, fakeFetch);
  assert.equal(out.status, 502);
  assert.equal(JSON.stringify(out.body).includes("synthetic-token"), false);
});

test("inherited tool names never invoke prototype methods or expose environment data", async () => {
  const secrets = { ...env, EVE_TOKEN: "synthetic-eve-token" };
  let calls = 0;
  const neverFetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  for (const tool of ["constructor", "toString", "valueOf", "__proto__"]) {
    const out = await handle(req(tool), secrets, neverFetch);
    assert.equal(out.status, 400, tool);
    assert.doesNotMatch(JSON.stringify(out.body), /synthetic-token|synthetic-password|synthetic-eve-token/);
  }
  assert.equal(calls, 0);
});
