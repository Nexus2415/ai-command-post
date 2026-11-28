# ARN-164 visual build intake

This draft implements the private, server-checked preview and a separate owner-reviewed scope staging record. It makes no model call, creates no Linear goal and does not dispatch. The existing `ACP_GITHUB_REPOS` is read, never changed; no new settings or permissions.

## Remaining binding

The current workspace file store is private to the workspace and its API; the engine's `[Goal]` planner consumes Linear text. Neither an image hash nor a browser preview is an authorization grant. Do not put image bytes, private attachment IDs, prompts or public URLs in Linear to bridge this gap. Before enabling Start, add a durable, atomic authorization/consumption path binding the authenticated principal, workspace project/thread, allowed repository, goal ID, exact attempt/fence, image digests, approval, expiry, budget and stop state. Resolve the bytes only under that binding. Reject replay, changed references, stale attempts and absent vision capability. Use the existing planner and claim/review gates; no new paid call or provider. Add synthetic end-to-end proof through draft PR validation and independent review. This document does not authorize activation or schema rollout.


## Synthetic engine seam

`src/visual-goal.ts` uses the existing `AdmissionBroker` claim status and one-time dispatch CAS via injected test ports. It verifies authority, scope, hash, zero-cost vision readiness and stop state, separates observed/inferred/unknown advisory output and records a synthetic `[Goal]` only through an injected atomic commit contract. Tests exercise replay and stale fences, missing/expired authority, modified images, stop and provider cost. The existing goal planner test now starts from the authorized synthetic image goal and drives the draft-PR and check tools. The production authority store, atomic commit, exact per-goal repository restriction, actual vision provider/settlement and independent review enforcement are still not wired. No browser submission endpoint is enabled.


## Durable scope staging (not execution)

The new `db/visual-build-scope.sql` migration is for the Command Post workspace database only and is **not applied**. The named existing owner email and signed browser session are required for the server to issue a 15-minute HMAC-bound preview ticket; a password header alone cannot save scope. The explicit Save reviewed scope button rechecks prompt, repository and bytes and calls a single service-role-only RPC. The RPC locks the stop row, private thread and referenced files and inserts one immutable scope record; identical ticket retries recover the same ID, altered or expired scope fails closed. No client-facing table grants, no paid model, goal creation, broker grant, worker dispatch or settings change. Separate disposable PostgreSQL native tests exercise replay, role restrictions, expiry, thread scope, changed bytes and stop. A saved scope is not an execution authorization. The broker bridge still requires independent durable principal/attempt/goal authority and a verified approved vision path. Never apply the migration to the opsdesk client database.

## Revocation and owner decision

Private scope records now cascade on thread deletion; thread privacy/project changes and reference mutations redact the saved prompt/manifest and leave a non-reusable tombstone. A restored image or re-privatized thread cannot revive the old scope ticket. This does not imply automatic expiry cleanup or an execution grant.

Current source boundary: `src/budget.ts` marks Claude, ChatGPT and Perplexity paid; Gemini is the only free-tier entry but remains suspended by `src/config.ts`/`src/providers.ts` (chat-only restoration is not engine authorization). `api/_lib/workspace-models.js` supports images for Claude/ChatGPT and meters their calls; using its chat route to dispatch vision would circumvent the existing engine authority/settlement. `.github/workflows/claude.yml` is an owner-gated GitHub comment workflow, not a private image transport or fenced broker worker. ARN-122 explicitly records missing verified deployed OIDC/broker-role mapping and zero-cost worker; its existing grant is limited to a shadow `review_result` task, not visual build authority. Do not infer a new grant from the scope record or reinterpret it as a client authorization.

Before operational completion, owner decision in Linear: authorize a narrowly scoped, synthetic-only qualification of an existing subscription-based vision/worker path at $0 incremental spend (recommended), including trusted principal and broker capability binding; or explicitly approve a capped paid vision/worker path and associated staged grant/configuration decisions. Qualification is not activation, cannot issue new roles or use client data, and may prove the subscription route unavailable. If neither route is authorized/verified, Start remains disabled and ARN-164 is blocked, not complete. Independent final-head review and migration preflight remain required.

## Synthetic planner scope boundary

The visual goal now carries a restriction marker (not authority) and does not copy the raw private prompt into the goal description. The existing planner rejects marked visual goals/steps without an injected trusted synthetic goal-to-repository lookup, narrows the worker's GitHub allowlist to that exact repository, and excludes general web/Vercel egress. Tests deliberately attempt a second globally allowed repository and show no fetch. Production must still provide durable trusted lineage and revalidation; Linear text or a missing/removed marker is not a reliable authority signal. No real goal publication, provider request or production runtime wiring is authorized.
