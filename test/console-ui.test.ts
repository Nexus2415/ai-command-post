import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../dashboard/console.js", import.meta.url), "utf8");
const sandbox: any = {};
vm.runInNewContext(src, sandbox);
const core = sandbox.ACPConsoleCore;

const overview = {
  issues: [{ id: "ARN-1", lane: "active" }, { id: "ARN-2", lane: "done" }, { id: "ARN-3", lane: "canceled" }],
  lanes: { active: ["ARN-1"], queued: [], review: [], blocked: [], done: ["ARN-2"], canceled: ["ARN-3"] },
  agents: [{ key: "claude", connection: "not_verified", active: ["ARN-1"], queued: [], blocked: [], review: [], nextTask: null }],
};

test("console counts the five lanes and never folds canceled into done", () => {
  assert.deepEqual({ ...core.laneCounts(overview) }, { done: 1, active: 1, queued: 0, blocked: 0, review: 0 });
  assert.equal(core.laneIssues(overview, "done").length, 1);
  assert.deepEqual({ ...core.laneCounts(null) }, { done: 0, active: 0, queued: 0, blocked: 0, review: 0 });
});

test("roster shows workload and never claims an agent is online", () => {
  const row = core.rosterRow(overview.agents[0]);
  assert.equal(row.connection, "Connection not verified");
  assert.equal(row.active, 1);
  assert.equal(core.connectionLabel(undefined), "Connection not verified");
  assert.doesNotMatch(src, /["']online["']/i);
});

test("intake body validates intent and text; 404 is reported, not faked", () => {
  assert.deepEqual({ ...core.intakeBody("question", "  why? ") }, { intent: "question", text: "why?" });
  assert.throws(() => core.intakeBody("command", "  "));
  assert.throws(() => core.intakeBody("delete", "x"));
  assert.match(core.errorMessage(404, {}, "intake"), /Nothing was sent/);
  assert.equal(core.isIssueId("ARN-49"), true);
  assert.equal(core.isIssueId("ARN-0"), false);
});

test("console never assigns innerHTML", () => {
  assert.doesNotMatch(src, /\.innerHTML\s*=/);
});
