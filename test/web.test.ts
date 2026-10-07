import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/linear.js";

const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
const req = (tool: string, args: object = {}, password = "pw") => ({ method: "POST", headers: { "x-acp-password": password }, body: { tool, args } });

function fakeLinear(reply: (query: string, vars: any) => any) {
  const calls: { query: string; vars: any; auth: string }[] = [];
  const f = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, vars: variables, auth: init.headers.authorization });
    return new Response(JSON.stringify({ data: reply(query, variables) }), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

test("website refuses everything until a password and Linear key are set", async () => {
  const { f, calls } = fakeLinear(() => ({}));
  assert.equal((await handle(req("list_teams"), {}, f)).status, 503);
  assert.equal((await handle(req("list_teams", {}, "nope"), env, f)).status, 401);
  assert.equal((await handle(req("list_teams", {}, ""), env, f)).status, 401);
  assert.equal(calls.length, 0);
});

test("website lists issues in the dashboard's shape", async () => {
  const { f, calls } = fakeLinear(() => ({
    issues: {
      nodes: [{ identifier: "ARN-1", title: "[Gemini] x", url: "u", priority: 2, priorityLabel: "High", updatedAt: "t", completedAt: null, createdAt: "c",
        state: { name: "Todo", type: "unstarted" }, labels: { nodes: [{ name: "gemini" }] }, assignee: null }],
      pageInfo: { hasNextPage: false },
    },
  }));
  const out = await handle(req("list_issues", { team: "Arnexyia" }), env, f);
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as any).issues[0], {
    id: "ARN-1", title: "[Gemini] x", url: "u", status: "Todo", statusType: "unstarted", priority: { value: 2, name: "High" },
    labels: ["gemini"], assignee: null, updatedAt: "t", completedAt: null, createdAt: "c",
  });
  assert.equal(calls[0]!.auth, "lin");
  assert.equal(calls[0]!.vars.n, "Arnexyia");
});

test("website only creates new command issues, with a clamped priority", async () => {
  const { f, calls } = fakeLinear((q) => (q.includes("teams") ? { teams: { nodes: [{ id: "T1" }] } } : { issueCreate: { issue: { identifier: "ARN-9", url: "u" } } }));
  const out = await handle(req("save_issue", { team: "Arnexyia", title: "Do it", description: "**Command issued from AI Command Post**", priority: 99, id: "ARN-1" }), env, f);
  assert.deepEqual(out.body, { identifier: "ARN-9", url: "u" });
  assert.deepEqual(calls[1]!.vars.i, { teamId: "T1", title: "Do it", description: "**Command issued from AI Command Post**", priority: 0 });
  assert.equal((await handle(req("delete_issue"), env, f)).status, 400);
});
