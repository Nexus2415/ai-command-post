// ARN-176: review lifecycle projection. Pure and read-only: facts in, card state and request intents out.
// Verdicts come only from GitHub's record via independentReview (src/review-check.ts). A receipt shows a review
// STARTED on the exact head; it is never a verdict. Mentions, informational workflows and generic agent activity
// are not inputs. Incomplete or unbound facts give blocked_unknown, never a guess.
import type { AgentKey } from "./config.ts";
import { independentReview, type PullFacts } from "./review-check.ts";

export const REVIEW_STATES = ["unassigned", "queued", "verified_reviewing", "changes_requested", "rework", "ready_for_owner_merge", "owner_held", "blocked_unknown"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export type CiStatus = "success" | "failure" | "pending" | "unknown";

/** Authenticated record that a review began, bound to task, repo, PR and exact head. */
export interface ReviewReceipt {
  reviewer: string; taskId: string; repo: string; pr: number; headSha: string; authenticated: boolean;
  kind: "codex_summary" | "claude_action_run" | "perplexity_receipt";
  state: "running" | "finished"; observedAt: number; expiresAt: number;
}
export interface CardInput {
  taskId: string; repo: string; pr: number; headSha: string;
  implementer?: string; // bound implementer; unknown means independence cannot be established
  assigned?: string; // recorded assignment: a record, not proof of activity
  reviews: PullFacts["reviews"];
  ci: { headSha: string; status: CiStatus };
  receipts: ReviewReceipt[];
  ownerHeld: boolean; closed: boolean;
  complete: boolean; // false when any read was partial or failed
  nowMs: number; // trusted snapshot clock, never a provider or comment timestamp
}
export interface Card {
  state: ReviewState; taskId: string; repo: string; pr: number; headSha: string;
  implementer: string | null; assignedReviewer: string | null;
  activity: { reviewer: string | null; evidence: "verified_receipt" | "github_review" | "none_observed" | "unknown" };
  requestKey: string | null; reason: string;
}

/** Durable identity of one review request: a new head is a new request, the same head never repeats. */
const ACTIVE = new Set(["claude","chatgpt","perplexity","codex"]);
const SHA = /^[a-f0-9]{40}$/;
const safeBinding = (c: {taskId:string;repo:string;pr:number;headSha:string}) => /^ARN-[1-9]\\d{0,8}$/.test(c.taskId) && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(c.repo) && Number.isSafeInteger(c.pr) && c.pr>0 && SHA.test(c.headSha);
export const requestKey = (repo: string, pr: number, headSha: string, reviewer: string) => `acp-review:${repo}#${pr}@${headSha}:${reviewer}`;

/** Deterministic: never the implementer, least load first, then the order of `eligible`. */
export function chooseReviewer(implementer: string | undefined, eligible: readonly string[], load: Record<string, number> = {}): string | undefined {
  if (!implementer || !ACTIVE.has(implementer)) return undefined;
  const pool = [...new Set(eligible)].map((id, i) => ({ id, i })).filter((e) => ACTIVE.has(e.id) && e.id !== implementer);
  pool.sort((a, b) => (load[a.id] ?? 0) - (load[b.id] ?? 0) || a.i - b.i);
  return pool[0]?.id;
}

export function projectCard(c: CardInput, logins: Map<string, AgentKey>, eligible: readonly string[]): Card {
  const base = { taskId: c.taskId, repo: c.repo, pr: c.pr, headSha: c.headSha, implementer: c.implementer ?? null, assignedReviewer: c.assigned ?? null };
  const out = (state: ReviewState, reason: string, evidence: Card["activity"]["evidence"] = "none_observed", reviewer: string | null = null): Card => ({
    ...base, state, reason, activity: { reviewer, evidence },
    requestKey: c.assigned && c.headSha ? requestKey(c.repo, c.pr, c.headSha, c.assigned) : null,
  });
  if (c.ownerHeld) return out("owner_held", "Owner-held or deferred; not in the review queue");
  if (c.closed) return out("blocked_unknown", "PR is closed or merged; not an active review");
  if (!c.complete || !safeBinding(c) || !Number.isSafeInteger(c.nowMs) || c.nowMs<=0) return out("blocked_unknown", "Incomplete or invalid read; state unknown", "unknown");
  if (!c.implementer || !ACTIVE.has(c.implementer)) return out("blocked_unknown", "Implementer not bound to this task/PR; independence cannot be established", "unknown");
  if (c.assigned === c.implementer) return out("blocked_unknown", "Assigned reviewer is the implementer (self-review refused)");
  if (c.assigned && (!ACTIVE.has(c.assigned) || !eligible.includes(c.assigned))) return out("blocked_unknown", `Assigned reviewer ${c.assigned} is not eligible`);
  const distinctLogins = new Map([...logins].filter(([,a]) => ACTIVE.has(a) && a!==c.implementer && eligible.includes(a)));
  const v = independentReview({ author:"unbound-implementer", headSha: c.headSha, reviews: c.reviews.filter(r=>Number.isFinite(Date.parse(r.submittedAt)) && Date.parse(r.submittedAt)<=c.nowMs) }, distinctLogins);
  const ciOk = c.ci.headSha === c.headSha;
  if (v.status === "changes_requested") return out("changes_requested", `${v.by} requested changes on this head; route to ${c.implementer}`, "github_review", v.by ?? null);
  if (v.status === "approved") {
    const ev = (s: ReviewState, why: string) => out(s, why, "github_review", v.by ?? null);
    if (!ciOk || c.ci.status === "unknown") return ev("blocked_unknown", "Approved, but CI for this exact head is unknown or for another commit");
    if (c.ci.status === "success") return ev("ready_for_owner_merge", `Independent approval by ${v.by} and CI passed on this exact head`);
    if (c.ci.status === "failure") return ev("rework", "Approved, but CI failed on this head");
    return ev("queued", "Approved; waiting for CI on this exact head");
  }
  const staleChanges = c.reviews.some((r) => r.state === "CHANGES_REQUESTED" && r.commitId !== c.headSha && logins.has(r.login.toLowerCase()) && logins.get(r.login.toLowerCase()) !== c.implementer);
  if (staleChanges && !(ciOk && c.ci.status === "success")) return out("rework", "Changes were requested on an older head; new head not yet validated");
  if (!ciOk || c.ci.status==="unknown") return out("blocked_unknown","Exact-head validation unavailable","unknown");
  if (c.ci.status==="failure") return out("rework","Validation failed on this head");
  if (c.ci.status==="pending") return out("queued","Waiting for exact-head validation");
  if (!c.assigned) return out("unassigned", "No independent reviewer recorded for this head");
  const hit = c.receipts.find((r) => r.authenticated === true && r.state==="running" && Number.isSafeInteger(r.observedAt) && Number.isSafeInteger(r.expiresAt) && r.observedAt<=c.nowMs && c.nowMs<r.expiresAt && r.expiresAt-r.observedAt<=240000 && r.reviewer === c.assigned && r.taskId === c.taskId && r.repo === c.repo && r.pr === c.pr && r.headSha === c.headSha && ((r.reviewer==="codex" && r.kind==="codex_summary") || (r.reviewer==="claude" && r.kind==="claude_action_run") || (r.reviewer==="perplexity" && r.kind==="perplexity_receipt")));
  if (hit) return out("verified_reviewing", `${hit.kind} receipt bound to this exact head`, "verified_receipt", hit.reviewer);
  return out("queued", `Assigned to ${c.assigned}; no verified activity yet (the engine cannot see external ChatGPT/Claude/Perplexity sessions)`);
}

export interface Plan { assign: { card: Card; reviewer: string; key: string }[]; request: { card: Card; key: string }[]; skipped: { key: string; why: string }[] }

/** Intents only: nothing is posted or mentioned here. A key already in `ledger` is never emitted again. */
export function planRequests(cards: readonly Card[], ledger: ReadonlySet<string>, eligible: readonly string[], load: Record<string, number> = {}): Plan {
  const plan: Plan = { assign: [], request: [], skipped: [] };
  const seen = new Set<string>();
  const work = { ...load };
  // One request per head, whoever was chosen: replay must not flip to another reviewer and ask again.
  const done = (c: Card) => { const p = `acp-review:${c.repo}#${c.pr}@${c.headSha}:`; return [...ledger, ...seen].some((k) => k.startsWith(p)); };
  for (const card of cards) {
    if (!safeBinding(card)) continue;
    if (card.state === "unassigned") {
      const reviewer = chooseReviewer(card.implementer ?? undefined, eligible, work);
      if (!reviewer) { plan.skipped.push({ key: `${card.repo}#${card.pr}@${card.headSha}`, why: "no eligible distinct reviewer" }); continue; }
      const key = requestKey(card.repo, card.pr, card.headSha, reviewer);
      if (done(card)) { plan.skipped.push({ key, why: "already requested for this head" }); continue; }
      seen.add(key); work[reviewer] = (work[reviewer] ?? 0) + 1;
      plan.assign.push({ card, reviewer, key });
    } else if (card.state === "queued" && card.requestKey && card.activity.evidence==="none_observed" && card.reason.startsWith("Assigned to ") && card.assignedReviewer && ACTIVE.has(card.assignedReviewer) && eligible.includes(card.assignedReviewer) && card.assignedReviewer!==card.implementer && card.requestKey===requestKey(card.repo,card.pr,card.headSha,card.assignedReviewer)) {
      if (done(card)) { plan.skipped.push({ key: card.requestKey, why: "already requested for this head" }); continue; }
      seen.add(card.requestKey);
      plan.request.push({ card, key: card.requestKey });
    }
  }
  return plan;
}
