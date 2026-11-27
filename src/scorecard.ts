// ARN-150: is the engine getting better at building? Over the issues the engine can see (the last 14 days), count the
// tasks it worked, the ones finished with proof, the ones that needed the owner, and what they cost. Pure: the engine
// gathers the inputs (orchestrator `scoreRun`) and puts the result in its status report. Display data only.
import type { LedgerEntry } from "./budget.ts";
import type { Issue } from "./linear.ts";

export const SCORE_WINDOW_DAYS = 14;
/** Comment reads per run for the scorecard are bounded, so a busy month can't slow every run. */
export const MAX_SCORED_TASKS = 40;

export interface Scorecard {
  windowDays: number;
  /** Tasks the engine spent on (any paid call recorded against them). */
  worked: number;
  /** Done with proof: a link in the result, and for code a PR whose checks the engine saw ALL PASSED. */
  proven: number;
  /** Marked done but without that proof. */
  unproven: number;
  /** Times the owner had to step in: the task ended blocked, or was reopened after the engine said done. */
  neededYou: number;
  /** Still being worked or waiting. */
  open: number;
  spentUsd: number;
  /** Everything spent in the window divided by proven tasks; null until one is proven. */
  usdPerProven: number | null;
  /** True when more tasks were worked than MAX_SCORED_TASKS, so the counts cover only the newest ones. */
  partial: boolean;
}

const PR_LINK = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;
const ANY_LINK = /https?:\/\/\S+/;

/** Proof for one "done" result: a link, and when it names a pull request, the engine's ALL PASSED check verdict. */
export function hasProof(resultBody: string): boolean {
  if (!ANY_LINK.test(resultBody)) return false;
  return PR_LINK.test(resultBody) ? /\bALL PASSED\b/.test(resultBody) : true;
}

export type Outcome = "done" | "blocked" | undefined;

/**
 * tasks: the engine's non-command issues in the window. results: each one's newest engine result, when it has one.
 * windowIssues: every issue identifier in the window, so planning and summary spend on commands counts in spentUsd.
 */
export function scorecard(
  tasks: Issue[],
  windowIssues: Set<string>,
  ledger: LedgerEntry[],
  results: Map<string, { status: Outcome; body: string }>,
  partial: boolean,
): Scorecard {
  let proven = 0, unproven = 0, neededYou = 0, open = 0;
  for (const t of tasks) {
    const r = results.get(t.identifier);
    if (r?.status === "blocked") neededYou++;
    else if (r?.status === "done" && t.stateType !== "completed") neededYou++; // the owner reopened it
    else if (r?.status === "done") {
      if (hasProof(r.body)) proven++;
      else unproven++;
    } else open++;
  }
  const spentUsd = Math.round(ledger.filter((e) => windowIssues.has(e.issue)).reduce((s, e) => s + e.usd, 0) * 1e4) / 1e4;
  return {
    windowDays: SCORE_WINDOW_DAYS,
    worked: tasks.length,
    proven,
    unproven,
    neededYou,
    open,
    spentUsd,
    usdPerProven: proven ? Math.round((spentUsd / proven) * 1e4) / 1e4 : null,
    partial,
  };
}
