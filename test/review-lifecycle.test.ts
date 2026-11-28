import assert from "node:assert/strict";
import { test } from "node:test";
import { appLogins } from "../src/review-check.ts";
import { chooseReviewer, planRequests, projectCard, requestKey, type CardInput, type ReviewReceipt } from "../src/review-lifecycle.ts";

// Synthetic data only. No network, no client data.
const logins = appLogins({ ACP_GH_APP_CLAUDE_SLUG: "arnexyia-claude", ACP_GH_APP_PERPLEXITY_SLUG: "arnexyia-perplexity", ACP_GH_APP_CHATGPT_SLUG: "arnexyia-chatgpt" }, ["claude", "chatgpt", "perplexity"]);
const eligible = ["claude", "chatgpt", "perplexity"];
const HEAD = "a".repeat(40), OLD = "b".repeat(40);
const rv = (login: string, state: string, commitId = HEAD) => ({ login, state, commitId, submittedAt: "2026-11-28T12:00:00Z" });
const input = (o: Partial<CardInput> = {}): CardInput => ({
  taskId: "ARN-900", repo: "o/r", pr: 1, headSha: HEAD, implementer: "claude", reviews: [], ci: { headSha: HEAD, status: "success" },
  receipts: [], ownerHeld: false, closed: false, complete: true, nowMs:Date.parse("2026-11-28T12:01:00Z"), ...o,
});
const card = (o?: Partial<CardInput>) => projectCard(input(o), logins, eligible);
const st = (o?: Partial<CardInput>) => card(o).state;
const receipt: ReviewReceipt = { reviewer: "perplexity", taskId: "ARN-900", repo: "o/r", pr: 1, headSha: HEAD, authenticated: true, kind: "perplexity_receipt", state:"running", observedAt:Date.parse("2026-11-28T12:00:00Z"),expiresAt:Date.parse("2026-11-28T12:04:00Z") };

test("unassigned, queued and verified_reviewing; receipts must be authenticated and exactly bound", () => {
  assert.equal(st(), "unassigned");
  assert.equal(st({ assigned: "perplexity" }), "queued");
  const ok = card({ assigned: "perplexity", receipts: [receipt] });
  assert.equal(ok.state, "verified_reviewing");
  assert.equal(ok.activity.evidence, "verified_receipt");
  for (const bad of [{ headSha: OLD }, { authenticated: false }, { pr: 2 }, { taskId: "ARN-901" }, { reviewer: "chatgpt" }, { repo: "o/other" }])
    assert.equal(st({ assigned: "perplexity", receipts: [{ ...receipt, ...bad }] }), "queued", JSON.stringify(bad));
});

test("assigned reviewer is shown separately from activity; queued claims no activity", () => {
  const c = card({ assigned: "perplexity" });
  assert.equal(c.assignedReviewer, "perplexity");
  assert.equal(c.activity.reviewer, null);
  assert.equal(c.activity.evidence, "none_observed");
});

test("self-review, ineligible reviewer, unbound implementer and incomplete reads are blocked_unknown", () => {
  assert.equal(st({ assigned: "claude" }), "blocked_unknown");
  assert.equal(st({ assigned: "gemini" }), "blocked_unknown");
  assert.equal(st({ implementer: undefined, assigned: "perplexity" }), "blocked_unknown");
  const c = card({ complete: false, assigned: "perplexity", reviews: [rv("arnexyia-perplexity[bot]", "APPROVED")] });
  assert.equal(c.state, "blocked_unknown");
  assert.equal(c.activity.evidence, "unknown");
  assert.equal(st({ closed: true }), "blocked_unknown");
});

test("owner-held wins and is not queued", () => {
  assert.equal(st({ ownerHeld: true, complete: false }), "owner_held");
  assert.equal(st({ ownerHeld: true, assigned: "perplexity" }), "owner_held");
});

test("only a different AI app's approval on the exact head with exact-head CI is ready for owner merge", () => {
  const approve = [rv("arnexyia-perplexity[bot]", "APPROVED")];
  assert.equal(st({ reviews: approve }), "ready_for_owner_merge");
  assert.equal(st({ reviews: approve, ci: { headSha: OLD, status: "success" } }), "blocked_unknown");
  assert.equal(st({ reviews: approve, ci: { headSha: HEAD, status: "unknown" } }), "blocked_unknown");
  assert.equal(st({ reviews: approve, ci: { headSha: HEAD, status: "failure" } }), "rework");
  assert.equal(st({ reviews: approve, ci: { headSha: HEAD, status: "pending" } }), "queued");
  assert.equal(st({ reviews: [rv("Nexus2415", "APPROVED")] }), "unassigned");
  assert.equal(st({ reviews: [rv("arnexyia-claude[bot]", "APPROVED")] }), "unassigned");
  assert.equal(st({ reviews: [rv("arnexyia-perplexity[bot]", "APPROVED", OLD)] }), "unassigned");
  assert.equal(st({ reviews: [rv("arnexyia-perplexity[bot]", "COMMENTED")] }), "unassigned");
});

test("verified findings route back to the implementer; a new head is reworked until validated", () => {
  const c = card({ reviews: [rv("arnexyia-perplexity[bot]", "CHANGES_REQUESTED")] });
  assert.equal(c.state, "changes_requested");
  assert.match(c.reason, /route to claude/);
  const stale = [rv("arnexyia-perplexity[bot]", "CHANGES_REQUESTED", OLD)];
  assert.equal(st({ reviews: stale, ci: { headSha: HEAD, status: "pending" } }), "rework");
});

test("chooseReviewer is deterministic and never the implementer", () => {
  assert.equal(chooseReviewer("claude", eligible), "chatgpt");
  assert.equal(chooseReviewer("claude", eligible, { chatgpt: 2 }), "perplexity");
  assert.equal(chooseReviewer("claude", ["claude"]), undefined);
  assert.equal(chooseReviewer(undefined, eligible), undefined);
});

test("planRequests is replay-safe per head, balances load and emits intents only", () => {
  const a = card(), b = card({ pr: 2 });
  const p1 = planRequests([a, b], new Set(), eligible);
  assert.deepEqual(p1.assign.map((x) => x.reviewer), ["chatgpt", "perplexity"]);
  const ledger = new Set(p1.assign.map((x) => x.key));
  const p2 = planRequests([a, b], ledger, eligible);
  assert.equal(p2.assign.length, 0);
  assert.equal(p2.skipped.length, 2);
  const NEW = "c".repeat(40);
  const p3 = planRequests([card({ headSha: NEW, ci: { headSha: NEW, status: "success" } })], ledger, eligible);
  assert.equal(p3.assign.length, 1);
  assert.equal(p3.assign[0]!.key, requestKey("o/r", 1, NEW, "chatgpt"));
  const q = card({ assigned: "perplexity" });
  const r1 = planRequests([q], new Set(), eligible);
  assert.equal(r1.request.length, 1);
  assert.equal(planRequests([q], new Set([r1.request[0]!.key]), eligible).request.length, 0);
  assert.equal(planRequests([card({ ownerHeld: true }), card({ implementer: undefined }), card({ complete: false })], new Set(), eligible).assign.length, 0);
});

test("ARN-176 never reports stale review receipts as working or dispatches while validation is pending",()=>{
 const now=input().nowMs;
 for(const bad of [{state:"finished" as const},{expiresAt:now},{observedAt:now+1},{expiresAt:now+500000},{kind:"codex_summary" as const}]) assert.equal(st({assigned:"perplexity",receipts:[{...receipt,...bad}]}),"queued");
 assert.equal(planRequests([card({assigned:"perplexity",ci:{headSha:HEAD,status:"pending"}})],new Set(),eligible).request.length,0);
 assert.equal(planRequests([card({assigned:"perplexity",reviews:[rv("arnexyia-perplexity[bot]","APPROVED")],ci:{headSha:HEAD,status:"pending"}})],new Set(),eligible).request.length,0);
 assert.equal(chooseReviewer("claude",["gemini","grok"]),undefined);
 assert.equal(st({headSha:"not-a-sha"}),"blocked_unknown");
});

test("ARN-176 authenticated Codex summary binds bot identity, PR, full head and freshness; no text-based approval",()=>{
 const now=input().nowMs, allowed=[...eligible,"codex"];
 const raw=(status:string,findings:boolean|null,unresolved:boolean|null,head=HEAD)=>({
   user:{login:"chatgpt-codex-connector[bot]",type:"Bot",id:199175422},
   performed_via_github_app:{slug:"chatgpt-codex-connector"},
   issue_url:"https://api.github.com/repos/o/r/issues/1",updated_at:new Date(now-1000).toISOString(),
   body:"<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 "+JSON.stringify({code_review:{commit_sha:head,status,has_any_findings:findings,has_unresolved_findings:unresolved},security_review:{commit_sha:null}})+" -->"
 });
 const result=(comments:unknown[],o:Partial<CardInput>={})=>projectCard(input({assigned:"codex",codexComments:comments,...o}),logins,allowed);
 const active=raw("running",null,null), clean=raw("completed",false,false), found=raw("completed",true,true);
 assert.equal(result([active]).state,"verified_reviewing");
 assert.equal(result([clean]).state,"ready_for_owner_merge");
 assert.equal(result([found]).state,"changes_requested");
 assert.equal(result([raw("completed",true,false)]).state,"changes_requested");
 assert.equal(result([{...active,updated_at:new Date(now-240001).toISOString()}]).state,"blocked_unknown");
 assert.equal(result([active,clean]).state,"blocked_unknown");
 assert.equal(result([raw("completed",false,false,OLD)]).state,"queued");
 assert.equal(result([{...clean,user:{...clean.user,id:123}}]).state,"queued");
 assert.equal(result([{...clean,performed_via_github_app:{slug:"other"}}]).state,"queued");
 assert.equal(result([{...clean,issue_url:"https://api.github.com/repos/o/r/issues/2"}]).state,"queued");
 assert.equal(result([clean],{ci:{headSha:HEAD,status:"pending"}}).state,"queued");
 assert.equal(result([clean],{implementer:"codex"}).state,"blocked_unknown");
 assert.equal(result([clean],{complete:false}).state,"blocked_unknown");
 assert.equal(result([clean],{reviews:[rv("arnexyia-perplexity[bot]","CHANGES_REQUESTED")]}).state,"changes_requested");
});
