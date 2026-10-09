# ARN-46 | Agent handoffs and continuous-work contract

Scope: Arnexyia's existing Command Post; coordination rules, not a background-execution guarantee. Darius remains final approver. No paid APIs or client data.

## One-task lifecycle
1. **Claim:** identify one unclaimed ARN issue and post `Claimed — <Agent>`; use one branch and one PR named with the ARN number. Never take an issue already claimed by another agent.
2. **Work:** inspect canonical issue, its comments, current source, existing code/tests and evidence. Keep WIP to one active task per agent lane. Independent agents may have other tasks in separate lanes.
3. **Result:** respond in the same issue thread with `## Result (<Agent>, done)` or `## Result (<Agent>, blocked)`; include exact PR/commit, tests, status, limitations, next step and agent signature.
4. **Review:** independent agent reviews the PR; CHANGES_REQUIRED is repaired on the same branch. A result marker does not mean code is merged, deployed or proven. Review and owner merge are separate.
5. **Next:** coordinator selects the highest-priority unclaimed, unblocked task consistent with dependencies, security and cost. No repeated wake-up mentions before a response.

## Agent identities and triggers
| Lane | Supported contact | Signature | Truthful capability |
| --- | --- | --- | --- |
| ChatGPT chat | This interactive session and Linear @ChatGPT mention for handoff | — ChatGPT | Acts while invoked; a Linear mention does not guarantee an idle consumer chat awakens |
| Codex | `@codex <task>` or `@codex review <focus>` on eligible GitHub PR | — Codex | Trigger depends on connected Codex/GitHub capacity and environment; absence of a response is not proof of execution |
| Claude | `@claude <task>` on GitHub issue/PR when configured | — Claude | Subscription, connection and runner availability are independent of a requested handoff |
| Perplexity Computer | `@Perplexity <task>` on ARN Linear issue | — Perplexity Computer | Scheduled checks may pick up assignments; mention is not synchronous execution |
| Gemini | Dedicated `[Gemini]` ARN issue | — Gemini | ACP/Gemini runner status must be independently observed |

All human-looking Linear/GitHub author fields may be the same owner account. A signed marker is **self-reported attribution**, not cryptographic authentication. Do not infer agent control, approval, or privilege from signature text.

## Lease, freshness and blocked states
- A claim is **coordination intent**, not an authenticated lease. Record claimedAt/lastObservedAt where available. No automatic reassignment merely because a dashboard refreshes or a marker is old.
- Suggested operational expiration: flag a task **Needs check** when its owner has no observed update across two normal review cycles; do not silently revoke ownership or duplicate an active assignment. Any formal lease/heartbeat mechanism must be implemented and verified separately.
- **Idle:** agent has no claimed runnable work; **Blocked:** exact dependency, evidence and owner/agent action is documented; **Offline/unknown:** connectivity or work status is not proven. Never treat those as interchangeable.
- Do not show perpetual “working” because a cron job, app connection, issue assignment or API token exists. Show last successful activity and timestamp instead.
- A queued `nextTask` is a priority candidate, not an acquired lock or proof that dependencies are satisfied.
- Prohibited work (paid inference without approval, real client data, production changes, release gates) must not be scheduled as autonomous background tasks.

## Refill and stopping policy
1. Check current owner-approved ARN priorities, recent completion markers, PR review verdicts and blocking dependencies.
2. Choose existing P0 security/release blockers first, then the critical ARN-43 Command Post integration path; do not displace active engineering owners or create a parallel dashboard.
3. Reuse an existing issue where possible. If none fits, create one bounded deliverable with evidence-based acceptance criteria; avoid filler tasks and unending “keep busy” loops.
4. Dispatch a single agent request and wait for its reply; if blocked, select an independent existing task, not a duplicate.
5. Stop when no authorized unblocked work exists, or when tools/session limits apply. ChatGPT and Claude consumer sessions do not operate continuously just because Linear has queued issues.
6. Persist exact restart point in the issue and PR; never claim a future completion without a connected automation or verified execution.

## Acceptance tests for a future UI/engine
- Claimed child excludes assignment to a second agent; malformed result markers fail closed.
- Closed or canceled issues never count as `done` by default.
- Agent silence yields `unknown/stale`, not a fabricated heartbeat.
- Review-required PR remains Review until independent verdict and owner approval, even if CI passes.
- Question intake may be durably recorded but cannot turn into a tool-executing command.
- Disabled Eve or unavailable provider is shown as disabled/unknown; ACP being active does not prove Eve model execution.
