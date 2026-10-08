# ARN-45 | POTUS Console Integration Release Checklist

Owner: Darius. Scope: ARN-43 only; documentation and evidence tracking, not permission to merge/deploy.

## Current evidence snapshot (2026-10-08)

| Work item | Owner | Evidence | Current status | Next gate |
| --- | --- | --- | --- | --- |
| ARN-44 acceptance contract | ChatGPT | ai-command-post PR #16, head 05d8461 | Draft; five Perplexity changes addressed, reviewer re-verdict pending | Independent review + validation, owner merge decision |
| ARN-54 scoped overview/thread API | Perplexity | ai-command-post PR #15, head f3bde96 | Draft; Perplexity reported 44 synthetic tests on an earlier head, not independent verification of current head | CI, independent code review, live scoped integration using approved non-client test context |
| ARN-35 CI protection | Claude | opsdesk-harmony PR #174, head 3fc54d4 | Draft; review not established by this snapshot | CI/reviewer/owner merge decision |
| ARN-49..53 console UI, intake, adapter | Claude | Linear task queue under ARN-43 | Do not claim implementation complete without PR and test evidence | Focused UI/API acceptance and security checks |
| ARN-45 integration checklist | ChatGPT | This document | Draft PR pending | Independent review |
| ARN-46 handoff truthfulness | ChatGPT | Linear ARN-46 | Not yet verified complete | Separate bounded task |
| ARN-47 acceptance/accessibility | ChatGPT | Linear ARN-47 | Not yet verified complete | Run against deployed preview, not mocks alone |
| ARN-48 owner guide | ChatGPT | Linear ARN-48 | Not yet verified complete | Document verified workflow only |

## Integration order and gates

1. Freeze question/command contract via ARN-44 and reconcile backend API fields under ARN-54.
2. Review backend data scope: only ARN Launch Operations issues; authentication via existing control, bounded pagination, failure transparency, no client data.
3. Verify Claude UI against API, including keyboard/focus/accessibility, stale/error states, and no fabricated live agent presence.
4. Verify bounded Eve adapter and safe intake. Questions may be durably recorded without executing tools; commands require explicit policy/approval.
5. Run synthetic acceptance flows. Capture test commands, versions, trace/correlation IDs if available, exact result and observed side effects.
6. Obtain independent reviews. Owner controls merge and any production deployment or preview-only flag change.
7. Retain kill switch off and zero incremental AI spend except for specifically owner-approved isolated tests. Do not infer Limited Live readiness.

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
