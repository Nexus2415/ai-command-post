import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeAnswer, loadCases, routingReport, summarize, type EvalCase } from "../src/eval.ts";

// The $0 evaluation set (src/eval.ts, eval/cases.json). No model is called.
const cases = loadCases();

test("the evaluation set loads and has both plain and real-work questions", () => {
  assert.ok(cases.length >= 30);
  assert.ok(cases.filter((c) => c.expectTier === "light").length >= 8);
  assert.ok(cases.filter((c) => c.expectTier === "full").length >= 15);
});

test("smart routing never sends a real-work question to the light model", () => {
  for (const model of ["claude", "chatgpt"]) {
    const r = routingReport(cases, model);
    assert.deepEqual(r.tooLight, [], `${model}: these need the full model`);
  }
  // Plain questions still save money.
  assert.deepEqual(routingReport(cases).tooHeavy, []);
});

test("a model without a light tier always gets the full model", () => {
  const r = routingReport(cases, "perplexity");
  assert.equal(r.tooLight.length, 0);
  assert.equal(r.tooHeavy.length, cases.filter((c) => c.expectTier === "light").length);
});

test("answers are graded by code: tool-only, empty, false 'done' and missing facts fail", () => {
  const byId = (id: string) => cases.find((c) => c.id === id) as EvalCase;
  assert.equal(gradeAnswer(byId("capital"), "Lisbon is the capital.").pass, true);
  assert.deepEqual(gradeAnswer(byId("capital"), "Madrid.").reasons, ['missing "Lisbon"']);
  assert.equal(gradeAnswer(byId("greet"), "").pass, false);
  // ARN-141, both shapes: the old bare footer and the new explicit notice.
  assert.match(gradeAnswer(byId("tool-only-reply"), "Tools used: linear_search_issues").reasons.join(), /only lists tools/);
  assert.match(gradeAnswer(byId("tool-only-reply"), "(The AI used tools but did not return an analysis. Your request is incomplete.)\n\nTools used: linear_search_issues").reasons.join(), /no answer/);
  assert.equal(gradeAnswer(byId("tool-only-reply"), "ARN-12 matters most: it blocks the engine.\n\nTools used: linear_search_issues").pass, true);
  // Proof before "done": chat can't send email.
  assert.equal(gradeAnswer(byId("no-false-done"), "I've sent the email to the client.").pass, false);
  assert.equal(gradeAnswer(byId("no-false-done"), "Here's a draft you can send: ...").pass, true);
});

test("cost per verified answer counts the failed answers' cost too", () => {
  const s = summarize([
    { id: "a", pass: true, reasons: [], costUsd: 0.01 },
    { id: "b", pass: false, reasons: ["x"], costUsd: 0.03 },
  ]);
  assert.equal(s.passed, 1);
  assert.equal(s.passRate, 0.5);
  assert.ok(Math.abs(s.costPerVerifiedUsd! - 0.04) < 1e-12);
  assert.equal(summarize([]).costPerVerifiedUsd, null);
});

test("the case file is checked: duplicate ids are refused", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  const file = join(dir, "cases.json");
  writeFileSync(file, JSON.stringify({ cases: [{ id: "x", question: "q", expectTier: "light" }, { id: "x", question: "q", expectTier: "full" }] }));
  assert.throws(() => loadCases(new URL(`file://${file}`)), /Duplicate/);
});
