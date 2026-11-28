// Crash recovery (2026-11-28): a task whose engine run died mid-way is resumed, not stranded.
//
// The problem: work() moves a task to In Progress before its first model call. If that run then dies (the 25-minute
// job timeout, a cancelled workflow, a crashed runner), nothing ever writes a result or moves the task back, and the
// engine only picks up tasks in Triage, Backlog or Todo. The task sat In Progress forever, waiting for a person.
//
// The rule: a task is STRANDED when all of these hold, and only then does the engine take it back up.
// - It is In Progress, it is an ordinary task or goal step (never a command or a question).
// - Its Linear claim is this engine AI's own (claimStatus "own", signature verified when signing is on). A task a
//   person moved to In Progress, or fenced with "ACP executor: manual", is never touched.
// - No result comment was posted since it entered In Progress (Linear's startedAt). Every way work() ends on purpose
//   posts a result or moves the task out of In Progress, so "In Progress with no result since" means the run died.
//   A task left In Progress on purpose (its pull request waits for the owner's merge) has a result, so it is skipped.
// - It entered In Progress longer ago than the claim lease (src/claims.ts LEASE_MS, longer than any engine run can
//   live), so the run that started it must have ended.
// - The claim store is configured, and this run wins the task's row from the dead run. A live run's row is inside its
//   lease and is never taken over; two recovering runs race on a conditional update and exactly one wins.
//
// Duplicate prevention: every draft pull request the engine opens is recorded at once in a signed Linear comment
// ("ACP opened pull request"). A recovering run is told about those PRs and may push fixes to their acp/ branches
// (only branches from a verified record), so it continues its own PR instead of opening a second one. Unsigned or
// forged records are listed as text only and grant nothing.
//
// Bounded: each recovery leaves an "ACP recovery n/2" comment. A task that is stranded a third time is closed as
// blocked with no model call, so a task that always crashes can't spend the budget run after run.
import { verifyComment } from "./provenance.ts";
import { LEASE_MS } from "./claims.ts";
import type { Issue } from "./linear.ts";

export const RECOVERY_MARKER = "ACP recovery";
export const PR_RECORD_MARKER = "ACP opened pull request:";
export const MAX_RECOVERIES = 2;

type Comment = { body: string; createdAt: string };
export interface PrRecord { url: string; repo: string; branch: string; verified: boolean }
export interface Stranded { attempt: number; prs: PrRecord[] }

const RESULT_HEAD = /^## Result \([^,()\n]+, (done|blocked)\)/;
const RECORD_LINE = /^ACP opened pull request: (\S+) on ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) from (acp\/[a-z0-9._-]+)\s*$/m;

/** The comment body that records a pull request the moment it is opened (signed by the caller). */
export function prRecord(url: string, repoBranch: string): string {
  const [repo, branch] = repoBranch.split("#");
  return `${PR_RECORD_MARKER} ${url} on ${repo} from ${branch}\n\nRecorded so a later run can continue this pull request instead of opening another one if this run is interrupted.`;
}

/**
 * Whether an In Progress task's run died and it may be resumed, with how many recoveries this one is and the PRs
 * the dead run recorded. Null means leave it alone. Any doubt (no startedAt, an unreadable time) is null.
 */
export function strandedRun(task: Issue, comments: Comment[], nowMs: number, secret: string | undefined): Stranded | null {
  if (task.stateType !== "started" || !task.startedAt) return null;
  const started = Date.parse(task.startedAt);
  if (Number.isNaN(started) || started > nowMs - LEASE_MS) return null;
  let attempt = 1;
  const prs: PrRecord[] = [];
  for (const c of comments) {
    const at = Date.parse(c.createdAt);
    const body = String(c.body);
    // A result we can't place in time might be newer than startedAt: treat it as one (leave the task alone).
    if (RESULT_HEAD.test(body) && (Number.isNaN(at) || at >= started)) return null;
    if (Number.isNaN(at) || at < started) continue;
    if (body.startsWith(RECOVERY_MARKER)) attempt++;
    const m = RECORD_LINE.exec(body);
    if (m) prs.push({ url: m[1]!, repo: m[2]!, branch: m[3]!, verified: !!secret && verifyComment(secret, "pr", task.id, body) });
  }
  return { attempt, prs };
}

/** What the recovering worker is told, as data: the earlier run died, and which PRs it already opened. */
export function recoveryContext(s: Stranded): string {
  const lines = [
    `Recovery ${s.attempt} of ${MAX_RECOVERIES}: an earlier engine run on this task was interrupted before it reported (timeout, cancel or crash). Start again from the task, but check what already exists first.`,
  ];
  const usable = s.prs.filter((p) => p.verified);
  if (usable.length) {
    lines.push(`That run already opened these draft pull requests. Do NOT open another one for the same change: continue with github.update_pull_request on the same branch, then github.pr_checks.`);
    for (const p of usable) lines.push(`- ${p.url} (repo ${p.repo}, branch ${p.branch})`);
  } else if (s.prs.length) {
    lines.push(`Comments mention pull requests (${s.prs.map((p) => p.url).join(", ")}) but none is a verified engine record, so you may not push to them. Before opening a pull request, use a new branch name.`);
  } else {
    lines.push(`It recorded no pull request. If it got as far as creating a branch, opening a PR on that branch name fails; use a new branch name.`);
  }
  return lines.join("\n");
}
