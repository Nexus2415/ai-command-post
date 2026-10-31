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

test("console shows canceled as its own lane, never folded into done", () => {
  assert.deepEqual({ ...core.laneCounts(overview) }, { done: 1, active: 1, queued: 0, blocked: 0, review: 0, canceled: 1 });
  assert.equal(core.laneIssues(overview, "done").length, 1);
  assert.equal(core.laneIssues(overview, "canceled")[0].id, "ARN-3");
  assert.deepEqual({ ...core.laneCounts(null) }, { done: 0, active: 0, queued: 0, blocked: 0, review: 0, canceled: 0 });
});

test("tab counts always match the issue list, even if a reply's lanes disagree with it", () => {
  const zero = { done: 0, active: 0, queued: 0, blocked: 0, review: 0, canceled: 0 };
  // Missing lanes but a real issue: Active still counts it.
  assert.deepEqual({ ...core.laneCounts({ issues: [{ id: "ARN-9", lane: "active" }], lanes: {} }) }, { ...zero, active: 1 });
  // A phantom lane ID with no matching issue counts nothing.
  assert.deepEqual({ ...core.laneCounts({ issues: [], lanes: { done: ["ARN-GHOST"] } }) }, zero);
  for (const k of core.TABS) assert.equal(core.laneCounts(overview)[k], core.laneIssues(overview, k).length);
});

test("owner question labels distinguish issue creation from execution; Codex is named", () => {
  assert.equal(core.ownerLabel({ title: "[Question] status?", owner: null }), "Owner question · no execution");
  assert.equal(core.ownerLabel({ title: "Do it", owner: null }), "Unclaimed");
  assert.equal(core.ownerLabel({ title: "[Codex] x", owner: "codex" }), "Codex");
  assert.match(core.QUESTION_EXPLANATION, /Submitting a question creates a Linear issue/);
  assert.match(core.QUESTION_EXPLANATION, /does not authorize agents to execute tools/);
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

// ---- ARN-53 static checks (source inspection, not behaviour) ----
const html = readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
const code = src.replace(/^\s*\/\/.*$/gm, ""); // comments stripped

test("static: console never builds HTML from data or persists the password", () => {
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /(localStorage|sessionStorage)\.setItem/);
  assert.doesNotMatch(html, /setItem\(\s*["']acp\.pw|lsSet\(\s*["']acp\.pw/);
  assert.doesNotMatch(src, /\.href\s*=(?!\s*href\b)/, "links only via safeUrl()");
});

test("static: fetches are relative /api/console and /api/intake only", () => {
  const paths = [...src.matchAll(/post\(\s*"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(paths)].sort(), ["/api/console", "/api/intake"]);
  assert.equal((src.match(/fetch\(/g) || []).length, 1);
  assert.doesNotMatch(src, /https?:\/\/(?!\/)/);
});

test("static: question toggle does not mislabel persistent issue creation as read-only", () => {
  assert.match(html, /Question <span class="mono note">no agent execution<\/span>/);
  assert.doesNotMatch(html, /Question <span[^>]+>read-only<\/span>/);
  assert.match(src, /\? QUESTION_EXPLANATION/);
});

test("static: route compatibility — every element id console.js uses exists in index.html", () => {
  assert.match(html, /<script src="console\.js"><\/script>/);
  const ids = new Set([...src.matchAll(/\$\("([A-Za-z]+)"\)/g)].map(m => m[1]));
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /id="cIntent"[^]*data-intent="command"[^]*data-intent="question"/);
});

test("static: small screens — viewport meta, no fixed widths over 375px outside collapsing media queries", () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /@media \(max-width:640px\)/);
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const wide = [...css.matchAll(/(?<![-\w])(min-)?width:\s*(\d+)px/g)].filter(m => Number(m[2]) > 375);
  assert.deepEqual(wide.map(m => m[0]), []);
});

test("static: no engine-live or spend claim outside the hidden legacy chip", () => {
  for (const line of html.split("\n").filter(l => /engine live|spend|online/i.test(l))) assert.match(line, /data-legacy/, line);
  assert.doesNotMatch(src, /engine (is )?live|spending|\$\d/i);
});
