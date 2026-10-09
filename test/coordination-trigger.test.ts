import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../scripts/coordination-event-preflight.mjs";
const repo = "Nexus2415/ai-command-post";
const owner = "Nexus2415";
const message = "/arnexyia handoff ARN-63 codex";
const event = (body = message, login = owner) => ({
  action: "created",
  issue: { number: 31 },
  comment: { body, user: { login } },
});

test("accepts only exact owner-authored handoff marker", () => {
  assert.deepEqual(classifyEvent(event(), repo, owner), { accepted: true, issue: "ARN-63", agent: "codex", action: "record-only" });
  assert.equal(classifyEvent(event("/arnexyia handoff ARN-63 claude"), repo, owner).agent, "claude");
});

test("never accepts third-party actors or comments", () => {
  assert.equal(classifyEvent(event(), repo, "external").accepted, false);
  assert.equal(classifyEvent(event(message, "external"), repo, owner).accepted, false);
  assert.equal(classifyEvent(event(), "other/repo", owner).accepted, false);
});

test("rejects malformed commands, extra instructions and unrecognized agents", () => {
  for (const body of ["/arnexyia handoff ARN-63 codex execute", "/arnexyia handoff ARN-63 hacker", "/arnexyia handoff ARN-abc claude", "@codex review", ""]) {
    assert.equal(classifyEvent(event(body), repo, owner).accepted, false, body);
  }
});

test("rejects noncomment, edited and missing payloads", () => {
  assert.equal(classifyEvent(null, repo, owner).accepted, false);
  assert.equal(classifyEvent({ ...event(), action: "edited" }, repo, owner).accepted, false);
  assert.equal(classifyEvent({ ...event(), comment: null }, repo, owner).accepted, false);
});
