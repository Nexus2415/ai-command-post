import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/console.js";
import { TEAM_ID, PROJECT_ID } from "../api/lib/console-state.js";
// @ts-ignore plain-JS module served by Vercel
import { lifecycleOf } from "../api/lib/command-lifecycle.js";
import { COMMAND_MARKER, RESULT_MARKER, RECONCILED_MARKER, EXECUTOR_MARKER } from "../src/orchestrator.ts";

// Synthetic fixtures only (ARN-71). Nothing here reaches Linear, a model provider or Eve.
const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
const desc = `Run a search.\n\n${COMMAND_MARKER} by the owner.`;
const cmd = (state: any, extra: any = {}) => ({
  id: "uuid", identifier: "ARN-900", title: "[Gemini] Test run: search", url: "https://linear.app/arnexyia/issue/ARN-900",
  priority: 0, updatedAt: "2026-10-09T09:50:00Z", completedAt: null, description: desc,
  state, team: { id: TEAM_ID }, project: { id: PROJECT_ID }, labels: { nodes: [] }, ...extra,
});
const backlog = { name: "Backlog", type: "backlog" };
const c = (id: string, body: string, createdAt = "2026-10-09T10:00:00Z") => ({ id, body, createdAt });
const life = (issue: any, comments: any[] = [], children: any = []): any =>
  lifecycleOf({ ...issue, labels: issue.labels.nodes.map((l: any) => l.name) }, comments, children);

test("JS markers match the engine's markers", () => {
  const src = readFileSync("api/lib/command-lifecycle.js", "utf8");
  for (const m of [COMMAND_MARKER, RESULT_MARKER, RECONCILED_MARKER]) assert.ok(src.includes(JSON.stringify(m)), m);
  assert.ok(src.includes("^" + EXECUTOR_MARKER), EXECUTOR_MARKER);
});

test("ARN-70 clone: [Gemini], Backlog, no comments is queued and not verified, never running or Gemini online", () => {
  const l = life(cmd(backlog));
  assert.equal(l.stage, "queued");
  assert.match(l.detail, /Execution not verified/);
  assert.doesNotMatch(l.label + l.detail, /running|online|completed|Gemini/i);
});

test("a claim comment shows claimed with a provenance caveat, not that the AI is online", () => {
  const l = life(cmd({ name: "In Progress", type: "started" }), [c("k", `${EXECUTOR_MARKER} acp:gemini`)],
    [{ identifier: "ARN-901", state: { type: "unstarted" } }]);
  assert.equal(l.stage, "claimed");
  assert.match(l.detail, /doesn't prove the AI is running/);
  assert.deepEqual(l.evidence, [{ kind: "comment", commentId: "k" }, { kind: "issue", issue: "ARN-901" }]);
  assert.equal(life(cmd(backlog), [c("k", "Claimed by Gemini (AI Command Post).")]).stage, "claimed");
});

test("completed needs both a terminal state and a recorded result", () => {
  const done = { name: "Done", type: "completed" };
  const ok = life(cmd(done), [c("s", `${RECONCILED_MARKER}\n\nAnswer: 50.`)]);
  assert.equal(ok.stage, "completed");
  assert.deepEqual(ok.evidence, [{ kind: "comment", commentId: "s" }]);
  assert.equal(life(cmd(done), [c("r", `${RESULT_MARKER} (Gemini, done)\n\n50`)]).stage, "completed");
  // Done without any result, or a result on an open issue, fails closed.
  assert.equal(life(cmd(done)).stage, "unknown");
  assert.equal(life(cmd(backlog), [c("r", `${RESULT_MARKER} (Gemini, done)\n\n50`)]).stage, "unknown");
  // A later blocked result contradicts an earlier done result.
  assert.equal(life(cmd(done), [c("a", `${RESULT_MARKER} (Gemini, done)\n\nx`, "2026-10-09T10:00:00Z"),
    c("b", `${RESULT_MARKER} (Gemini, blocked)\n\ny`, "2026-10-09T11:00:00Z")]).stage, "unknown");
});

test("blocked shows the recorded reason; canceled is never done; contradictions are unknown", () => {
  const b = life(cmd(backlog), [c("r", `${RESULT_MARKER} (Gemini, blocked)\n\nGemini has no API key configured`)]);
  assert.equal(b.stage, "blocked");
  assert.deepEqual(b.evidence, [{ kind: "comment", commentId: "r" }]);
  assert.equal(life(cmd({ name: "Blocked", type: "unstarted" })).stage, "blocked");
  assert.equal(life(cmd({ name: "Canceled", type: "canceled" }), [c("r", `${RESULT_MARKER} (Gemini, done)\n\nx`)]).stage, "canceled");
  assert.equal(life(cmd({ name: "In Progress", type: "started" })).stage, "unknown");
  assert.equal((lifecycleOf as any)({ ...cmd(backlog), labels: [] }, null, []).stage, "unknown");
});

test("questions stay read-only even with agent labels, assignees and a claim", () => {
  const q = cmd(backlog, { title: "[Question] What is queued?", labels: { nodes: [{ name: "gemini" }] }, assignee: { name: "Claude" } });
  const l = life(q, [c("k", `${EXECUTOR_MARKER} acp:gemini`)]);
  assert.equal(l.stage, "question");
  assert.match(l.label, /read-only/);
});

test("issues the console didn't file get no command lifecycle", () => {
  assert.equal(life(cmd(backlog, { description: "Ordinary task" })), null);
});

test("thread endpoint returns the lifecycle with one read-only Linear query and no side effects", async () => {
  const calls: any[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: { issue: {
      ...cmd(backlog), children: { nodes: [] },
      comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
    } } }), { status: 200 });
  }) as typeof fetch;
  const r: any = await handle({ method: "POST", headers: { "x-acp-password": "pw" }, body: { action: "thread", identifier: "ARN-900" } }, env, f);
  assert.equal(r.status, 200);
  assert.equal(r.body.lifecycle.stage, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.doesNotMatch(calls[0].body.query, /mutation/i);
});

test("lifecycle code has no write, model or Eve path", () => {
  const src = readFileSync("api/lib/command-lifecycle.js", "utf8");
  assert.doesNotMatch(src, /fetch\(|mutation|^import\s|\beve\b|anthropic|openai|generativelanguage/im);
});
