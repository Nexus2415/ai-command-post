# ARN-44 Console Acceptance Contract

Owner: Darius. Scope: existing ai-command-post owner UI and Eve adapter. This is a specification only, never deployment or spending authority.

## Intents
- Question: read-only with evidence and timestamp; no task mutation or agent execution.
- Command: queue only after existing authorization gates. Any owner-only request remains approval-required, not executed.
- Ambiguous input: no action until clarified.

## Owner views
- Lanes: Done, In progress, Queued, Blocked, Review. Closed, merged, deployed and verified are distinct.
- Each task: ARN identifier, title, owner designation, updated timestamp, evidence URL and truthful status.
- Thread: chronological comments, handoff markers treated as self-reported rather than authenticated identities, current next action.
- Agent next-task and freshness indicators: only verified observations, never invented online status.
- Owner overrides: existing authenticated, authorized and audited controls only.

## Console API
- POST /api/console with action overview returns top-level issues, lanes, agents, fetchedAt, hasNextPage.
- POST /api/console with action thread and identifier ARN-123 returns a single project-scoped issue and chronological comments.
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
7. CI-green PR without independent review stays Review.
8. Unauthenticated override cannot change tasks or system controls.
9. Disabled Eve runtime is shown as disabled, not healthy.
10. Paginated response keeps hasNextPage visible.

## Verification
Synthetic API contract tests, failure-path tests, keyboard navigation, focus order, screen-reader labels and small-screen visibility. Separate code, preview, merged, production and release-gate status. Independent review required before owner-approved merge.

Handoff: Perplexity owns API shapes/tests, Claude owns UI and Eve adapter, ChatGPT owns acceptance reconciliation. No overlapping implementation.
