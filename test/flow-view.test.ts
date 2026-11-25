import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { REFUSAL_MARK, STOP_MARK, refusalText } from "../api/_lib/workspace-rules.js";
import { CRITIQUE_MARK, SYNTHESIS_MARK } from "../api/_lib/workspace-roundtable.js";

// Workflow flow chart (dashboard/flow-view.js): the pure helpers run in a sandbox with no DOM, where the script
// must define its helpers and touch nothing else. The chart is a view of saved messages; it makes no requests.
const src = readFileSync(new URL("../dashboard/flow-view.js", import.meta.url), "utf8");
const sandbox: any = {};
vm.runInNewContext(src, sandbox);
const core = sandbox.ACPFlowCore;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

let seq = 0;
const msg = (role: string, content: string, model: string | null = null, cost = 0) =>
  ({ id: "m" + ++seq, role, content, model, cost_usd: cost, input_tokens: 10, output_tokens: 20, created_at: "2026-11-24T05:00:00Z" });

test("the chart reads the same markers the server writes", () => {
  assert.deepEqual(plain(core.MARKS), { REFUSAL_MARK, STOP_MARK, CRITIQUE_MARK, SYNTHESIS_MARK });
});

test("the script makes no requests and has no write path", () => {
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|innerHTML|insertAdjacentHTML/);
  assert.equal(sandbox.ACPFlow, undefined, "the DOM part does not run without a document");
});

test("a finished roundtable becomes question, rules check, three steps and the cost", () => {
  const ms = [
    msg("user", "Two pricing plans or three?"),
    msg("assistant", "Three.\n\nWeb activity (audit, times UTC, total $0.002):\n- 05:00:01 search: \"pricing\" ($0.001)\n- 05:00:02 read: https://example.com/p ($0.001)", "claude", 0.004),
    msg("assistant", "Two.", "chatgpt", 0.003),
    msg("assistant", CRITIQUE_MARK + "\nB is right.", "claude", 0.002),
    msg("assistant", CRITIQUE_MARK + "\nA is right.", "chatgpt", 0.002),
    msg("assistant", SYNTHESIS_MARK + "\nStart with two.", "claude", 0.003),
  ];
  const turns = core.turnsOf(ms);
  assert.equal(turns.length, 1);
  const f = plain(core.buildFlow(turns[0], null));
  assert.equal(f.question.text, "Two pricing plans or three?");
  assert.equal(f.gate.state, "passed");
  assert.deepEqual(f.rows.map((r: any) => r.label), ["Step 1 of 3 · First answers", "Step 2 of 3 · Reviewing each other", "Step 3 of 3 · Final answer"]);
  assert.deepEqual(f.rows.map((r: any) => r.nodes.length), [2, 2, 1]);
  assert.equal(f.rows[2].nodes[0].text, "Start with two.", "the marker is stripped");
  const claude = f.rows[0].nodes[0];
  assert.equal(claude.text, "Three.", "the web audit is split off the answer");
  assert.equal(claude.web.length, 2);
  assert.equal(claude.web[1].target, "https://example.com/p");
  assert.equal(f.tools.web.length, 2);
  assert.equal(Math.round(f.usd * 1000), 14);
  assert.equal(f.current, "Finished");
});

test("a refused message shows the rules check as refused, with the reason, and nothing after it", () => {
  const rule = { reason: "Fraud, forgery or deceiving people" };
  const ms = [msg("user", "hello"), msg("assistant", "hi", "claude"), msg("assistant", refusalText("request", rule))];
  const turns = core.turnsOf(ms);
  assert.equal(turns.length, 2, "the refused message starts its own question");
  const f = plain(core.buildFlow(turns[1], null));
  assert.equal(f.question.state, "refused");
  assert.equal(f.gate.state, "refused");
  assert.equal(f.gate.reason, "Fraud, forgery or deceiving people");
  assert.equal(f.rows.length, 0);
});

test("withheld replies, blocked tools, failures and stops are each shown with words, not colour alone", () => {
  const rule = { reason: "Making illegal drugs" };
  const ms = [
    msg("user", "q"),
    msg("assistant", refusalText("web_search", rule)),
    msg("assistant", refusalText("reply", rule), "claude", 0.001),
    msg("assistant", "(The AI provider failed partway through this reply: timeout)", "chatgpt"),
    msg("assistant", STOP_MARK + "\nThe owner stopped all AI work."),
  ];
  const f = plain(core.buildFlow(core.turnsOf(ms)[0], null));
  const nodes = f.rows[0].nodes;
  assert.deepEqual(nodes.map((n: any) => n.state), ["refused", "failed"]);
  assert.equal(nodes[0].reason, "Making illegal drugs");
  assert.equal(nodes[0].text, "", "a withheld reply's text is never shown");
  assert.equal(f.tools.blocked[0].tool, "web_search");
  assert.equal(f.notes[0].state, "stopped");
  for (const s of ["done", "working", "waiting", "refused", "failed", "stopped", "passed"]) assert.ok(core.STATE_WORDS[s], s + " has a word");
});

test("while a roundtable runs, the step in progress is Working and the later ones are Waiting", () => {
  const ms = [msg("user", "q"), msg("assistant", "a", "claude", 0.01), msg("assistant", "b", "chatgpt", 0.01)];
  const live = { step: "critique", roundtable: true, units: [], phase: "Step 2 of 3 · Reviewing each other", usd: 0.03 };
  const f = plain(core.buildFlow(core.turnsOf(ms)[0], live));
  assert.deepEqual(f.rows[1].nodes.map((n: any) => [n.model, n.state]), [["claude", "working"], ["chatgpt", "working"]]);
  assert.equal(f.rows[2].nodes[0].state, "waiting");
  assert.equal(f.current, "Step 2 of 3 · Reviewing each other");
  assert.equal(f.usd, 0.03, "the running total from the page wins when it is higher");
  assert.equal(f.live, true);
});

test("a new question on its way shows as sent, with its AIs working", () => {
  const f = plain(core.buildFlow({ question: null, refusal: null, replies: [] },
    { units: ["claude", "gemini", "<x>"], phase: "Getting answers side by side", usd: 0, fresh: true }));
  assert.equal(f.question.state, "done");
  assert.equal(f.gate.state, "working");
  assert.deepEqual(f.rows[0].nodes.map((n: any) => [n.model, n.state]), [["claude", "working"], ["gemini", "working"]], "unknown units are dropped");
  assert.equal(f.rows[0].label, "Answers side by side");
});

test("odd input never throws", () => {
  assert.deepEqual(plain(core.turnsOf(null)), []);
  assert.deepEqual(plain(core.turnsOf([null, 5, { role: "assistant", content: "orphan", model: "claude" }])).length, 1);
  assert.ok(core.buildFlow(undefined, null));
  assert.deepEqual(plain(core.splitAudit(undefined)), { text: "", web: [] });
});
