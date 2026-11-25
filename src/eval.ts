// Evaluation set (2026-11-25, from the research log on ARN-113: OpenAI's agent improvement loop, Anthropic's
// "demystifying evals for AI agents", xAI's reasoning-effort evals). A fixed set of synthetic questions, graded by
// code before any model judge, so changes to routing or prompts are measured instead of guessed.
//
// What runs today costs $0: the routing check (which tier each question gets, decided by the same free rule the
// workspace uses) and the answer graders, which check recorded or fake answers. Sending the set to real models is
// NOT built here: that spends money and needs the owner's written budget first.
//
// Two numbers matter most for routing:
// - "too light": a question that needs real work sent to the cheap model. A quality risk; the target is zero.
// - "too heavy": a plain question sent to the full model. Only wasted money (about 20x per reply).
import { readFileSync } from "node:fs";
import { routeTier } from "../api/_lib/workspace-models.js";

export type Tier = "light" | "full";
export interface Grader {
  /** Every one of these must appear in the answer (case-insensitive). */
  mustInclude?: string[];
  /** None of these patterns may match the answer. */
  mustNotMatch?: string[];
}
export interface EvalCase {
  id: string;
  question: string;
  /** The tier this question should get: light only for short plain questions. */
  expectTier: Tier;
  grader?: Grader;
}
export interface Graded {
  id: string;
  pass: boolean;
  reasons: string[];
  costUsd: number;
}

/** The case file, checked: unique ids, a question, a known tier, and patterns that compile. */
export function loadCases(path = new URL("../eval/cases.json", import.meta.url)): EvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { cases: EvalCase[] };
  const seen = new Set<string>();
  for (const c of raw.cases) {
    if (!c.id || seen.has(c.id)) throw new Error(`Duplicate or missing case id: ${c.id}`);
    seen.add(c.id);
    if (!c.question?.trim()) throw new Error(`Case ${c.id} has no question.`);
    if (c.expectTier !== "light" && c.expectTier !== "full") throw new Error(`Case ${c.id} has an unknown tier.`);
    for (const p of c.grader?.mustNotMatch ?? []) new RegExp(p, "i");
  }
  return raw.cases;
}

export interface RoutingReport {
  total: number;
  correct: number;
  tooLight: string[];
  tooHeavy: string[];
}

/** Which tier the workspace's free routing rule picks for each case, against the tier it should get. */
export function routingReport(cases: EvalCase[], model = "claude"): RoutingReport {
  const report: RoutingReport = { total: cases.length, correct: 0, tooLight: [], tooHeavy: [] };
  for (const c of cases) {
    const got = routeTier(model, c.question) as Tier;
    if (got === c.expectTier) report.correct++;
    else if (got === "light") report.tooLight.push(c.id);
    else report.tooHeavy.push(c.id);
  }
  return report;
}

// Failures every answer is checked for, whatever the question (observed in the workspace on 2026-11-25).
const ALWAYS: { re: RegExp; why: string }[] = [
  // ARN-141: a reply that is only the tool list is not an answer.
  { re: /^\s*(\(.*\)\s*)*Tools used:[^\n]*\s*$/i, why: "only lists tools used; no answer" },
  { re: /did not return an analysis|sent an empty reply/i, why: "the AI returned no answer" },
  // Proof before "done": claiming work happened that an answer can't have done.
  { re: /\b(I have|I've) (sent|emailed|deployed|merged|published|paid|purchased)\b/i, why: "claims an action it cannot take from chat" },
];

/** Grades one answer by code: the fixed failure checks, then the case's own rules. */
export function gradeAnswer(c: EvalCase, answer: string, costUsd = 0): Graded {
  const text = String(answer ?? "");
  const reasons: string[] = [];
  if (!text.trim()) reasons.push("empty answer");
  for (const a of ALWAYS) if (a.re.test(text)) reasons.push(a.why);
  for (const want of c.grader?.mustInclude ?? []) if (!text.toLowerCase().includes(want.toLowerCase())) reasons.push(`missing "${want}"`);
  for (const p of c.grader?.mustNotMatch ?? []) if (new RegExp(p, "i").test(text)) reasons.push(`matched forbidden /${p}/`);
  return { id: c.id, pass: reasons.length === 0, reasons, costUsd };
}

/** Totals for a graded run. Cost per verified answer counts every answer's cost, failed ones included. */
export function summarize(results: Graded[]) {
  const passed = results.filter((r) => r.pass).length;
  const spent = results.reduce((n, r) => n + r.costUsd, 0);
  return {
    total: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    spentUsd: spent,
    costPerVerifiedUsd: passed ? spent / passed : null,
  };
}

// `node src/eval.ts`: the $0 routing report. Exit code 1 when any question would go to the light model wrongly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = loadCases();
  const r = routingReport(cases);
  console.log(`Routing: ${r.correct}/${r.total} as expected.`);
  console.log(`Too light (quality risk, target 0): ${r.tooLight.length ? r.tooLight.join(", ") : "none"}`);
  console.log(`Too heavy (wasted cost): ${r.tooHeavy.length ? r.tooHeavy.join(", ") : "none"}`);
  console.log("Live model runs are not part of this script: they cost money and need the owner's budget first.");
  process.exitCode = r.tooLight.length ? 1 : 0;
}
