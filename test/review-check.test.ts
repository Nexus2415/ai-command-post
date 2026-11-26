import assert from "node:assert/strict";
import { test } from "node:test";
import { appLogins, independentReview, readPull, type PullFacts } from "../src/review-check.ts";

// Independent review from GitHub's own record of who posted (src/review-check.ts). Fake GitHub only.
const logins = appLogins({
  ACP_GH_APP_CLAUDE_SLUG: "arnexyia-claude",
  ACP_GH_APP_PERPLEXITY_SLUG: "arnexyia-perplexity",
  ACP_GH_APP_CHATGPT_SLUG: "Bad Slug!", // ignored
}, ["claude", "chatgpt", "perplexity"]);
const HEAD = "a".repeat(40), OLD = "b".repeat(40);
const pr = (reviews: PullFacts["reviews"], author = "arnexyia-claude[bot]"): PullFacts => ({ author, headSha: HEAD, reviews });
const r = (login: string, state: string, commitId = HEAD, submittedAt = "2026-11-25T12:00:00Z") => ({ login, state, commitId, submittedAt });

test("app logins come from each AI's slug; invalid slugs are ignored", () => {
  assert.deepEqual([...logins], [["arnexyia-claude[bot]", "claude"], ["arnexyia-perplexity[bot]", "perplexity"]]);
});

test("a different AI's app approving the current commit counts", () => {
  const v = independentReview(pr([r("arnexyia-perplexity[bot]", "APPROVED")]), logins);
  assert.equal(v.status, "approved");
  assert.equal(v.by, "perplexity");
});

test("a signature line, the owner's account, the author itself or an old commit never count", () => {
  // The owner's account (where every AI posted until now) is not an AI identity, whatever the text says.
  assert.equal(independentReview(pr([r("Nexus2415", "APPROVED")]), logins).status, "missing");
  assert.match(independentReview(pr([r("Nexus2415", "APPROVED")]), logins).notes[0]!, /not an AI app identity/);
  assert.equal(independentReview(pr([r("arnexyia-claude[bot]", "APPROVED")]), logins).status, "missing", "self-review");
  assert.equal(independentReview(pr([r("arnexyia-perplexity[bot]", "APPROVED", OLD)]), logins).status, "missing", "stale commit");
  assert.equal(independentReview(pr([r("arnexyia-perplexity[bot]", "COMMENTED")]), logins).status, "missing", "a comment is no verdict");
  // A PR opened from the owner's account can be reviewed by any AI app.
  assert.equal(independentReview(pr([r("arnexyia-claude[bot]", "APPROVED")], "Nexus2415"), logins).status, "approved");
});

test("the newest verdict per AI wins, and a standing request for changes outweighs another AI's approval", () => {
  const later = "2026-11-25T13:00:00Z";
  assert.equal(independentReview(pr([r("arnexyia-perplexity[bot]", "CHANGES_REQUESTED"), r("arnexyia-perplexity[bot]", "APPROVED", HEAD, later)]), logins).status, "approved");
  const v = independentReview(pr([r("arnexyia-perplexity[bot]", "CHANGES_REQUESTED"), r("arnexyia-claude[bot]", "APPROVED")], "Nexus2415"), logins);
  assert.equal(v.status, "changes_requested");
  assert.equal(v.by, "perplexity");
});

test("the PR's facts are read from GitHub with every page of reviews", async () => {
  const urls: string[] = [];
  const f = (async (url: any) => {
    urls.push(String(url));
    if (String(url).endsWith("/pulls/7")) return new Response(JSON.stringify({ user: { login: "arnexyia-claude[bot]" }, head: { sha: HEAD } }));
    const page = Number(/[?&]page=(\d+)/.exec(String(url))![1]);
    const n = page === 1 ? 100 : 1;
    return new Response(JSON.stringify(Array.from({ length: n }, () => ({ user: { login: "arnexyia-perplexity[bot]" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-11-25T12:00:00Z" }))));
  }) as typeof fetch;
  const facts = await readPull("acme/app", 7, "t", f);
  assert.equal(facts.reviews.length, 101);
  assert.equal(urls.length, 4, "the PR is re-read after the reviews");
  assert.equal(independentReview(facts, logins).status, "approved");
  await assert.rejects(readPull("not a repo", 7, "t", f), /owner\/repo#number/);
});

test("two AIs given the same app are both dropped, never last-one-wins", () => {
  const m = appLogins({ ACP_GH_APP_CLAUDE_SLUG: "shared-app", ACP_GH_APP_CHATGPT_SLUG: "Shared-App", ACP_GH_APP_PERPLEXITY_SLUG: "arnexyia-perplexity" }, ["claude", "chatgpt", "perplexity"]);
  assert.deepEqual([...m], [["arnexyia-perplexity[bot]", "perplexity"]]);
});

test("a PR from the owner's account says its origin is unknown", () => {
  const v = independentReview(pr([r("arnexyia-perplexity[bot]", "APPROVED")], "Nexus2415"), logins);
  assert.equal(v.status, "approved");
  assert.match(v.notes[0]!, /which AI wrote it is unknown/);
});

test("reading refuses a review list it can't prove complete, or a PR that moved mid-read", async () => {
  const review = { user: { login: "arnexyia-perplexity[bot]" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-11-25T12:00:00Z" };
  const endless = (async (url: any) => String(url).endsWith("/pulls/7")
    ? new Response(JSON.stringify({ user: { login: "x" }, head: { sha: HEAD } }))
    : new Response(JSON.stringify(Array.from({ length: 100 }, () => review)))) as typeof fetch;
  await assert.rejects(readPull("acme/app", 7, "t", endless), /More than 1,000 reviews/);
  let reads = 0;
  const moving = (async (url: any) => String(url).endsWith("/pulls/7")
    ? new Response(JSON.stringify({ user: { login: "x" }, head: { sha: reads++ ? OLD : HEAD } }))
    : new Response(JSON.stringify([review]))) as typeof fetch;
  await assert.rejects(readPull("acme/app", 7, "t", moving), /changed while it was being read/);
});
