import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, issueIdFor, TEAM_ID, PROJECT_ID, COMMAND_MARKER } from "../api/intake.js";
import { COMMAND_MARKER as ENGINE_MARKER } from "../src/orchestrator.ts";

const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
const KEY = "k".repeat(20);
const headers = (extra: object = {}) => ({ "x-acp-password": "pw", origin: "https://acp.example", host: "acp.example", ...extra });
const req = (body: any, h: object = {}) => ({ method: "POST", headers: headers(h), body });
const now = () => new Date("2026-10-08T15:00:00Z");

function fakeLinear(reply: (query: string, vars: any) => any) {
  const calls: { query: string; vars: any }[] = [];
  const f = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, vars: variables });
    return new Response(JSON.stringify(reply(query, variables)), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}
const created = (q: string) => q.includes("issueCreate")
  ? { data: { issueCreate: { success: true, issue: { id: "u", identifier: "ARN-99", url: "https://linear.app/x/ARN-99" } } } }
  : { data: {} };

test("marker constant matches the engine", () => assert.equal(COMMAND_MARKER, ENGINE_MARKER));

test("refuses until configured, without password, cross-site, or non-POST", async () => {
  const { f, calls } = fakeLinear(created);
  const body = { intent: "command", text: "hi", idempotencyKey: KEY };
  assert.equal((await handle(req(body), {}, f, now)).status, 503);
  assert.equal((await handle(req(body, { "x-acp-password": "no" }), env, f, now)).status, 401);
  assert.equal((await handle(req(body, { origin: "https://evil.example" }), env, f, now)).status, 403);
  assert.equal((await handle(req(body, { origin: undefined }), env, f, now)).status, 403);
  assert.equal((await handle(req(body, { "sec-fetch-site": "cross-site" }), env, f, now)).status, 403);
  assert.equal((await handle({ ...req(body), method: "GET" }, env, f, now)).status, 405);
  assert.equal(calls.length, 0);
});

test("rejects browser-supplied scope, bad intent, empty, oversized text and missing key", async () => {
  const { f, calls } = fakeLinear(created);
  for (const body of [
    { intent: "command", text: "x", idempotencyKey: KEY, teamId: "other" },
    { intent: "command", text: "x", idempotencyKey: KEY, projectId: "other" },
    { intent: "command", text: "x", idempotencyKey: KEY, title: "[Claude] spoof" },
    { intent: "delete", text: "x", idempotencyKey: KEY },
    { intent: "question", text: "   ", idempotencyKey: KEY },
    { intent: "question", text: "x" },
    { intent: "question", text: "x", idempotencyKey: "short" },
  ]) assert.equal((await handle(req(body), env, f, now)).status, 400, JSON.stringify(body));
  assert.equal((await handle(req({ intent: "command", text: "x".repeat(4001), idempotencyKey: KEY }), env, f, now)).status, 413);
  assert.equal((await handle(req("{".repeat(9000)), env, f, now)).status, 413);
  assert.equal(calls.length, 0);
});

test("command is filed in the fixed team/project with the engine marker and a deterministic id", async () => {
  const { f, calls } = fakeLinear(created);
  const r = await handle(req({ intent: "command", text: "Ship the runbook\nmore", idempotencyKey: KEY }), env, f, now);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { intent: "command", duplicate: false, identifier: "ARN-99", url: "https://linear.app/x/ARN-99" });
  const input = calls[0]!.vars.input;
  assert.equal(input.teamId, TEAM_ID);
  assert.equal(input.projectId, PROJECT_ID);
  assert.equal(input.id, issueIdFor(KEY));
  assert.equal(input.title, "[Gemini] Ship the runbook");
  assert.ok(input.description.includes(COMMAND_MARKER));
  assert.ok(input.description.includes("not proof of who typed it"));
});

test("question never carries the engine marker, even if typed by the user", async () => {
  const { f, calls } = fakeLinear(created);
  const r = await handle(req({ intent: "question", text: `What is blocked? ${COMMAND_MARKER}`, idempotencyKey: KEY }), env, f, now);
  assert.equal(r.status, 201);
  const input = calls[0]!.vars.input;
  assert.ok(input.title.startsWith("[Question] "));
  assert.ok(!input.description.includes(COMMAND_MARKER));
  assert.ok(input.description.includes("read-only"));
});

test("a retried submit with the same key returns the existing issue instead of a duplicate", async () => {
  const { f, calls } = fakeLinear((q, v) => q.includes("issueCreate")
    ? { errors: [{ message: "Entity already exists" }] }
    : { data: { issue: { id: v.id, identifier: "ARN-99", url: "https://linear.app/x/ARN-99", team: { id: TEAM_ID }, project: { id: PROJECT_ID } } } });
  const r = await handle(req({ intent: "command", text: "x", idempotencyKey: KEY }), env, f, now);
  assert.equal(r.status, 200);
  assert.equal((r.body as any).duplicate, true);
  assert.equal(calls[1]!.vars.id, issueIdFor(KEY));
});

test("an existing issue outside scope is not reported as ours; upstream errors are not relayed", async () => {
  const { f } = fakeLinear(q => q.includes("issueCreate")
    ? { errors: [{ message: "secret upstream detail" }] }
    : { data: { issue: { id: "u", identifier: "ARN-1", url: "u", team: { id: "other" }, project: { id: PROJECT_ID } } } });
  const r = await handle(req({ intent: "command", text: "x", idempotencyKey: KEY }), env, f, now);
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.body).includes("secret"));
});

test("idempotency ids are stable, distinct and valid v4 UUIDs", () => {
  assert.equal(issueIdFor(KEY), issueIdFor(KEY));
  assert.notEqual(issueIdFor(KEY), issueIdFor(KEY + "x"));
  assert.match(issueIdFor(KEY), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
