# ARN-45 | POTUS Console Integration Release Checklist

Owner: Darius. Scope: ARN-43 only; documentation and evidence tracking, not permission to merge/deploy.

## Current evidence snapshot (2026-10-08)

| Work item | Owner | Evidence | Current status | Next gate |
| --- | --- | --- | --- | --- |
| ARN-44 acceptance contract | ChatGPT | ai-command-post PR #16, head 05d8461 | Perplexity independent review PASS per ARN-45; draft, not merged | CI and owner merge decision |
| ARN-54 scoped overview/thread API | Perplexity | ai-command-post PR #15, reported head 8e45cd4 | Draft; Perplexity reports 46/46 tests. Codex review clean on earlier f3bde96; ARN-56 follow-up work ongoing | Review exact new head, approved synthetic integration |
| ARN-35 CI protection | Claude | opsdesk-harmony PR #174, head 3fc54d4 | Draft; review not established by this snapshot | CI/reviewer/owner merge decision |
| ARN-49 UI | Claude | ai-command-post PR #18 | Perplexity CHANGES_REQUIRED: Canceled tab, charset, question count, Codex card | Fix on same branch, re-review, UI acceptance |\n| ARN-50 intake | Claude | ai-command-post PR #17 | Perplexity PASS with follow-ups; not proof of deployment | Follow-up fixes, tests, owner merge gate |\n| ARN-51..53 adapter/routing/tests | Claude | Linear under ARN-43 | Await PR-specific evidence | Focused implementation and review |\n| ARN-56 Codex follow-up | Codex | ai-command-post PR #15 | In progress, distinct agent from ChatGPT chat | Review new code and preserve signed identity |
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
7. Preserve the **observed ACP engine state** rather than assuming shutdown: Perplexity reported repo variables `ACP_ACTIVE=true`, `ACP_DRY_RUN=false`, `ACP_DEFAULT_LEAD=gemini`, with `GEMINI_API_KEY` set and a successful scheduled tick at 09:30Z. This is active internal Gemini orchestration, **not** Eve production activation or Limited Live. Any change to flags is owner-only. Zero unauthorized paid spend remains mandatory. Do not infer readiness.

## Integration evidence boundary\n\nPerplexity reported local browser verification of combined PRs #15, #17 and #18 against a **synthetic fake Linear upstream**. This is not evidence of deployed preview or live Linear behavior. Codex is its own subscription-backed work lane, separate from ChatGPT chat; signatures identify agent intent, not authenticated accounts.\n\n## Evidence rules

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
