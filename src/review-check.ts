// Independent review, decided by GitHub's record of who posted, not by a signature line (2026-11-25, owner decision
// "build it for each account").
//
// The working rule is that every PR gets one review from a different AI before the owner merges. Until now, "a
// different AI" meant a comment ending "— Perplexity" or "— Claude", which anyone posting as the owner could type.
// With each AI acting as its own GitHub App (src/identity.ts), GitHub itself records the reviewer as e.g.
// "arnexyia-perplexity[bot]". This module reads that record:
//
// A review counts as an independent review only when ALL of these hold:
// - its author is one of the AIs' app logins (`<slug>[bot]`, from ACP_GH_APP_<AI>_SLUG): GitHub-verified identity;
// - that AI is not the PR's author (an app can't review its own work, and a PR opened from the owner's account
//   counts as the owner's);
// - it was made on the PR's CURRENT head commit (a review of older code doesn't cover new pushes);
// - it is an approval or a request for changes (a plain comment is not a verdict).
// What a review's text says about who wrote it is ignored. The newest verdict per AI wins.
//
// This is the "verified review receipt" the planner work (opsdesk ARN-142/143) said it needed.
import type { AgentKey } from "./config.ts";

type Fetch = typeof fetch;
export interface PullFacts {
  author: string;
  headSha: string;
  reviews: { login: string; state: string; commitId: string; submittedAt: string }[];
}
export interface ReviewVerdict {
  status: "approved" | "changes_requested" | "missing";
  /** The AI whose verdict decided it, when there is one. */
  by?: AgentKey;
  /** One line for people: what counted and what didn't, and why. */
  notes: string[];
}

/** AI app logins from settings: { "arnexyia-claude[bot]": "claude", ... }. */
export function appLogins(env: Record<string, string | undefined>, agents: readonly AgentKey[]): Map<string, AgentKey> {
  const out = new Map<string, AgentKey>();
  const shared = new Set<string>();
  for (const a of agents) {
    const slug = env[`ACP_GH_APP_${a.toUpperCase()}_SLUG`]?.trim().toLowerCase();
    if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) continue;
    const login = `${slug}[bot]`;
    // Two AIs given the same app can't be told apart, so neither counts (no silent "last one wins").
    if (out.has(login)) shared.add(login);
    else out.set(login, a);
  }
  for (const login of shared) out.delete(login);
  return out;
}

export function independentReview(pr: PullFacts, logins: Map<string, AgentKey>): ReviewVerdict {
  const notes: string[] = [];
  const author = logins.get(pr.author.toLowerCase());
  if (!author) notes.push(`PR opened by ${pr.author}, not an AI app, so which AI wrote it is unknown and any AI app's review counts`);
  const latest = new Map<AgentKey, { state: string; at: number }>();
  for (const r of pr.reviews) {
    const ai = logins.get(r.login.toLowerCase());
    if (!ai) { notes.push(`${r.login}: not an AI app identity, so not an independent AI review`); continue; }
    if (ai === author) { notes.push(`${r.login}: the PR's own author`); continue; }
    if (r.commitId !== pr.headSha) { notes.push(`${r.login}: reviewed an older commit`); continue; }
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    const at = Date.parse(r.submittedAt);
    const prev = latest.get(ai);
    if (!prev || (!Number.isNaN(at) && at >= prev.at)) latest.set(ai, { state: r.state, at: Number.isNaN(at) ? 0 : at });
  }
  // Any standing request for changes outweighs an approval from another AI.
  const blocking = [...latest].find(([, v]) => v.state === "CHANGES_REQUESTED");
  if (blocking) return { status: "changes_requested", by: blocking[0], notes };
  const ok = [...latest].find(([, v]) => v.state === "APPROVED");
  if (ok) return { status: "approved", by: ok[0], notes };
  return { status: "missing", notes };
}

/** Reads a PR's author, head and reviews from GitHub (read-only; any token that can read the repo). */
export async function readPull(repo: string, pr: number, token: string, f: Fetch = fetch): Promise<PullFacts> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(pr) || pr < 1) throw new Error("Give the PR as owner/repo#number");
  const get = async (path: string) => {
    const res = await f(`https://api.github.com/repos/${repo}${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${j.message ?? "request failed"}`);
    return j;
  };
  const p = await get(`/pulls/${pr}`);
  const reviews: any[] = [];
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error("More than 1,000 reviews on this PR; can't confirm the list is complete");
    const batch = await get(`/pulls/${pr}/reviews?per_page=100&page=${page}`);
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
  // A push while reading would pair old reviews with a new head; re-read and refuse rather than guess.
  const again = await get(`/pulls/${pr}`);
  if (String(again.head?.sha ?? "") !== String(p.head?.sha ?? "")) throw new Error("The PR changed while it was being read; run the check again");
  return {
    author: String(p.user?.login ?? ""),
    headSha: String(p.head?.sha ?? ""),
    reviews: reviews.map((r) => ({ login: String(r.user?.login ?? ""), state: String(r.state ?? ""), commitId: String(r.commit_id ?? ""), submittedAt: String(r.submitted_at ?? "") })),
  };
}

// `node src/review-check.ts owner/repo#N` (GITHUB_TOKEN to read; ACP_GH_APP_<AI>_SLUG for the AI logins).
// Prints the verdict. Exit code 1 only when ACP_REQUIRE_INDEPENDENT_REVIEW=true and there is no independent approval,
// so the check is informational until the owner chooses to require it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(process.argv[2] ?? "");
  if (!m) throw new Error("Usage: node src/review-check.ts owner/repo#number");
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is required to read the PR");
  const logins = appLogins(process.env, ["claude", "chatgpt", "perplexity"]) // Gemini is suspended;
  const v = independentReview(await readPull(m[1]!, Number(m[2]), token), logins);
  const line = v.status === "approved" ? `Independent review: approved by ${v.by}'s app.`
    : v.status === "changes_requested" ? `Independent review: ${v.by} requested changes.`
    : logins.size ? "Independent review: none yet from another AI's app on the current commit."
    : "Independent review: no AI app identities are set up yet (ACP_GH_APP_<AI>_SLUG), so none can be verified.";
  console.log([line, ...v.notes.map((n) => `- ${n}`)].join("\n"));
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${line}\n\n${v.notes.map((n) => `- ${n}`).join("\n")}\n`);
  }
  if (process.env["ACP_REQUIRE_INDEPENDENT_REVIEW"] === "true" && v.status !== "approved") process.exitCode = 1;
}
