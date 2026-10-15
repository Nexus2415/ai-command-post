# ARN-44 Console Acceptance Contract

Owner: Darius. Scope: existing ai-command-post owner UI and Eve adapter. This is a specification only, never deployment or spending authority.

## Intents
- Question: read-only retrieval with evidence and timestamp; a question may be durably recorded as a question-intake message or issue under existing authorization, but must not trigger execution, change other task state, or grant tool authority.
- Command: queue only after existing authorization gates. Any owner-only request remains approval-required, not executed.
- Ambiguous input: no action until clarified.

## Owner views
- Lanes: Done, In progress (API active), Queued, Blocked, Review, Canceled. Canceled and duplicate issues never count as accomplished. Closed, merged, deployed and verified are distinct.
- Each task: ARN identifier, title, owner designation, updated timestamp, evidence URL and truthful status.
- Thread: chronological comments, handoff markers treated as self-reported rather than authenticated identities, current next action.
- Agent next-task is a priority-ranked queued candidate, not a verified lease, available agent connection or dependency-ready work allocation. Freshness indicators show verified observations, never invented online status.
- Owner overrides: existing authenticated, authorized and audited controls only.

## Console API
- POST /api/console with action overview returns top-level issues, lanes, agents, fetchedAt, hasNextPage.
- POST /api/console with action thread and identifier ARN-123 returns a single project-scoped issue and chronological comments, plus fetchedAt and hasPreviousPage for its most recent 100 comments; hasPreviousPage means older history is incomplete.
- Reject missing/invalid identifiers, cross-project requests and unknown actions without any side effect.
- Handle pagination explicitly; hasNextPage means results are incomplete.
- Treat provider failures as unknown/unavailable rather than an empty successful result.
- No faster polling than existing owner-approved automation.
- No client content, secrets or paid model calls.

## Synthetic acceptance scenarios
1. A blocked-task question displays matching tasks and a freshness timestamp without issuing writes.
2. A production deployment command requires owner authority; no deployment occurs.
3. Two fixture issues map to distinct lanes with consistent counts and links.
4. A task thread returns only its issue-scoped chronological comments.
5. Malformed, absent or out-of-scope identifiers fail safely.
6. API timeouts display unavailable rather than Done.
7. The Linear Review lane reflects Linear state or labels, not GitHub CI or approval. A CI-green PR without independent GitHub review must remain not approved in a separate GitHub-evidence release checklist; the console API alone cannot prove review.
8. Unauthenticated override cannot change tasks or system controls.
9. Disabled Eve runtime is shown as disabled, not healthy.
10. Paginated response keeps hasNextPage visible.

## Verification
Synthetic API contract tests, failure-path tests, keyboard navigation, focus order, screen-reader labels and small-screen visibility. Separate code, preview, merged, production and release-gate status. Independent review required before owner-approved merge.

Handoff: Perplexity owns API shapes/tests, Claude owns UI and Eve adapter, ChatGPT owns acceptance reconciliation. No overlapping implementation.
