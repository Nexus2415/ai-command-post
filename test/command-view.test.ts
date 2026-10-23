import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Command tree view (dashboard/command.js): pure helpers run in a sandbox with no DOM.
const src = readFileSync(new URL("../dashboard/command.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../dashboard/command.html", import.meta.url), "utf8");
const sandbox: any = {};
vm.runInNewContext(src, sandbox);
const core = sandbox.ACPCommandCore;

const issue = (id: string, lane: string, owner: string | null, extra: object = {}) =>
  ({ id, lane, owner, kind: "task", title: id + " title", url: "https://linear.app/x/issue/" + id, priority: 0, updatedAt: "2026-10-22T10:00:00Z", ...extra });
const overview = { issues: [
  issue("ARN-1", "active", "claude"), issue("ARN-2", "done", "claude"), issue("ARN-3", "queued", "claude", { priority: 1 }),
  issue("ARN-4", "blocked", "chatgpt"), issue("ARN-5", "done", "perplexity"), issue("ARN-6", "canceled", "claude"),
  issue("ARN-7", "queued", null), issue("ARN-8", "queued", null, { kind: "question", title: "[Question] why?" }),
  issue("ARN-9", "review", "codex", { updatedAt: "2026-10-22T12:00:00Z" }),
] };

test("agent stats come from Linear lanes; canceled work and owner questions are not counted", () => {
  const c = core.agentStats(overview, "claude");
  assert.deepEqual([c.active, c.queued, c.blocked, c.review, c.done, c.total], [1, 1, 0, 0, 1, 3]);
  assert.equal(c.percent, 33);
  assert.equal(c.status, "running");
  assert.equal(core.agentStats(overview, "chatgpt").status, "blocked", "blocked outranks everything");
  assert.equal(core.agentStats(overview, "perplexity").status, "complete");
  assert.equal(core.agentStats(overview, "gemini").status, "idle");
  assert.equal(core.agentStats(overview, "none").total, 1, "the [Question] issue is not unclaimed work");
  assert.equal(core.agentStats(null, "claude").percent, 0);
});

test("completion rate leaves canceled out, and an empty board is 0%, not 100%", () => {
  const t = core.totals(overview);
  assert.equal(t.canceled, 1);
  assert.equal(t.counted, 7);
  assert.equal(t.rate, Math.round((2 / 7) * 100));
  assert.equal(core.totals({ issues: [] }).rate, 0);
});

test("queue puts blocked first, then active, then urgent queued work; activity is newest first", () => {
  assert.deepEqual([...core.queue(overview, 6)].map((i: any) => i.id), ["ARN-4", "ARN-1", "ARN-9", "ARN-3", "ARN-7"]);
  assert.equal(core.activity(overview, 1)[0].id, "ARN-9");
  assert.equal(core.queue(overview, 2).length, 2);
});

test("only Linear https links are rendered", () => {
  assert.equal(core.safeUrl("https://linear.app/a/issue/ARN-1"), "https://linear.app/a/issue/ARN-1");
  assert.equal(core.safeUrl("javascript:alert(1)"), null);
  assert.equal(core.safeUrl("https://evil.example/linear.app"), null);
  assert.equal(core.safeUrl("http://linear.app/x"), null);
});

test("static: read-only, no HTML built from data, no stored password, no 'online' claim", () => {
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /(localStorage|sessionStorage)\.setItem/);
  assert.deepEqual([...code.matchAll(/fetch\(\s*"([^"]+)"/g)].map(m => m[1]), ["/api/console"], "only the read-only console endpoint");
  assert.doesNotMatch(code, /action:\s*"(?!overview)/, "overview is the only action sent");
  assert.doesNotMatch(src + html, /["']online["']|systems operational/i);
  assert.match(html, /<script src="command\.js"><\/script>/);
  assert.match(readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8"), /href="\/command\.html"/);
});
