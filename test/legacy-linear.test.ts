import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/linear.js";

// ARN-76: the legacy adapter is read-only. All command creation goes through the
// explicitly authorized /api/intake endpoint. No external calls in these tests.
const env = { ACP_SITE_PASSWORD: "synthetic-password", LINEAR_API_KEY: "synthetic-token" };
const req = (tool: string, args: object = {}) => ({
  method: "POST", headers: { "x-acp-password": env.ACP_SITE_PASSWORD },
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

test("legacy read operations remain available", async () => {
  let calls = 0;
  const fakeFetch = (async (_url: any, init: any) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.match(request.query, /^\{ teams/);
    assert.doesNotMatch(request.query, /mutation|issueCreate/);
    return new Response(JSON.stringify({ data: { teams: { nodes: [{ name: "Arnexyia", key: "ARN" }] } } }), { status: 200 });
  }) as typeof fetch;
  const out = await handle(req("list_teams"), env, fakeFetch);
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as any).teams, [{ name: "Arnexyia", key: "ARN" }]);
  assert.equal(calls, 1);
});
