# ARN-45 | POTUS Console Integration Release Checklist

Owner: Darius. Scope: ARN-43 only; documentation and evidence tracking, not permission to merge/deploy.

## Current evidence snapshot (2026-10-08, independent of production)

| Issue / PR | Exact reviewed status | Dependency and next gate |
| --- | --- | --- |
| ARN-42 / #14 | Operating runbook, open and review-ready, head `7c6cb98` | Owner merge only with verified integration |
| ARN-54 / #15 | API head `8e45cd4`, draft; Codex has two unresolved P1 owner-attribution findings at current head; CHANGES_REQUIRED, not merge-ready | API contract and ARN-56 guard |
| ARN-44 / #16 | Contract head `05d8461`; Perplexity PASS; now review-ready | Owner merge after dependency order |
| ARN-50 / #17 | Intake head `c061f21`; earlier Perplexity PASS; review-ready | Question-guard proof before command engine integration |
| ARN-49 / #18 | UI head `c6264d3`; Perplexity PASS on synthetic desktop/mobile integration; review-ready | #15 + #17, then real auth/browser acceptance |
| ARN-45 / #19 | Release checklist head updated by this change; GitHub Validate previously PASS for `6de6a32`; review-ready | Independent re-review of updated document |
| Agent identity / #20 | Draft `036ae95`, title lacks ARN issue reference | Identify canonical ARN owner/issue before merge |
| ARN-51 / #21 | Eve adapter `e8c401c`; fail-closed dispatch, strict health; Perplexity PASS on previous `7ef8bab` with later narrow strictness fix | Actual authenticated Eve protocol, budget reservation, ownership; unsupported dispatch remains off by design |
| ARN-52 / #22 | Claim head `6d6c4ee`, Validate run 37809750949 PASS; Codex review found P1 claim ordering and P2 preflight error escape; CHANGES_REQUIRED, not merge-ready | Non-atomic Linear claim race explicitly remains a limitation |
| ARN-53 / #23 | UI regression head `4b868bc`, Validate run 37811764930 PASS; ChatGPT independent source/CI review PASS; stacked on #18 | Merge only after #18 and approved synthetic/live acceptance |
| ARN-46 / #24 | Handoff contract head `c4a443f`, Validate run 37826120465 PASS; review-ready | Independent review and owner merge decision |
| ARN-48 / #25 | Owner guide head `e56c227`, Validate run 37826122532 PASS; review-ready | Independent review; deployed URL and live auth remain unverified |
| ARN-56 | Blocked Codex implementation transferred to Claude with one `@claude` request; ACP repo has no Claude GitHub workflow, so automatic activation is not verified | Require dedicated ARN-56 PR and tests before accepting labeled owner questions |
| ARN-47 | ChatGPT independent acceptance still blocked on approved live protected-preview access | Do not claim production or accessibility certification based on synthetic tests |

All test counts and review claims are scoped to the cited heads. A new head invalidates earlier review unless the delta is explicitly reconciled. No merge, production deployment, flag changes, customer data or paid API calls authorized by this table.

## Latest ARN-43 integration checkpoint (2026-10-08)

- ARN-52 / PR #22 head `069b3d9`: targeted claim-order/read-failure corrections; per-task comment claims still are not atomic execution leases.
- ARN-56 / PR #26 head `b6f61be`: `[Question]` exclusion checks implemented; stacked on #22, so review/merge order is significant.
- ARN-58 / PR #27 head `b97e681`: inert OIDC request construction only. GitHub Validate 37830463604 passed and ChatGPT gave source/CI PASS; dispatch remains `unsupported`/503. No cross-project trust, atomic budget reservation or live Eve authorization is proven.
- ARN-59: Perplexity's single atomic claim/budget design research request is outstanding; do not re-ping without a response.
- ARN-60: Codex independent combined engine review remains queued. No stable combined integration PR is verified, and Codex's separate runtime reported missing GitHub issue API/Linear access; do not dispatch a duplicate task.

## Integration order and gates

1. Freeze question/command contract via ARN-44 and reconcile backend API fields under ARN-54.
2. Review backend data scope: only ARN Launch Operations issues; authentication via existing control, bounded pagination, failure transparency, no client data.
3. Verify Claude UI against API, including keyboard/focus/accessibility, stale/error states, and no fabricated live agent presence.
4. Verify bounded Eve adapter and safe intake. Questions may be durably recorded without executing tools; commands require explicit policy/approval.
5. Run synthetic acceptance flows. Capture test commands, versions, trace/correlation IDs if available, exact result and observed side effects.
6. Obtain independent reviews. Owner controls merge and any production deployment or preview-only flag change.
7. Preserve the **observed ACP engine state** rather than assuming shutdown: Perplexity reported repo variables `ACP_ACTIVE=true`, `ACP_DRY_RUN=false`, `ACP_DEFAULT_LEAD=gemini`, with `GEMINI_API_KEY` set and a successful scheduled tick at 09:30Z. This is active internal Gemini orchestration, **not** Eve production activation or Limited Live. Any change to flags is owner-only. Zero unauthorized paid spend remains mandatory. Do not infer readiness.

## Integration evidence boundary

Perplexity reported local browser verification of combined PRs #15, #17 and #18 against a **synthetic fake Linear upstream**. This is not evidence of deployed preview or live Linear behavior. Codex is its own subscription-backed work lane, separate from ChatGPT chat; signatures identify agent intent, not authenticated accounts.

## Evidence rules

- Record exact PR head SHA, automated test result, reviewer verdict and preview result separately.
- A READY deployment is build/deploy evidence only, not operational correctness.
- A Linear agent comment is a self-report, not cryptographic identity.
- Do not count canceled tasks as done. Differentiate Linear Review lane from independent GitHub PR review.
- Keep last fetched time and pagination gaps visible. Next-task candidates are not leases or proven dependencies.
- On any unresolved error, retain a truthful blocked/unknown status; no green by default.

## Owner-only decisions

Merge to main, activate production, change environment flags or secrets, use metered Gateway, alter budgets, expose client data or change release gates. No such decision is presumed from this checklist.

## Next verification

When PR #15 and Claude UI are available, compare their actual request/response and rendering behavior against PR #16. Post exact failures and owner-only decisions under ARN-43. Update this document on material status changes only.
