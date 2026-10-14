# ARN-94 synthetic integration evidence

This source-only proof joins the existing authenticated intake, Manager,
persistence contract and native broker. The single worker and its independent
verifier are synthetic. No live connector, provider, route, secret or flag is
configured. The manager-event adapter remains an injected, inert factory.

The native harness requires `ARN94_DISPOSABLE=1`, an unprivileged user and
PostgreSQL 16 binaries (`ARN94_PGBIN`). It refuses external database connection
variables, creates its own temporary cluster, listens only on its private Unix
socket, replays the reviewed migration journal and removes that cluster afterward.
Run `node --test test/synthetic-workflow.test.ts`; use `npm run validate` for the
existing regression suite. CI runs both checks.

The test-only archive pins opsdesk-harmony source at
`df274ef994c807dff375fb05020d68d3fe692a7f`, independently accepted for ARN-98.
The JSON manifest contains the archive and individual file SHA-256 digests.
SQL is replayed without patches. The archive avoids requiring new credentials
for cross-repository private checkout in CI; it is never loaded by product code.

The integration revealed two source contract gaps: the raw broker adapter's
command key lacked the tenant prefix required by manager-event SQL, and the
Manager sent a job ID in its admission audit before that ID was durably bound.
The new explicit manager-event factory uses the native event claim, confirms
its exact attempt/fence by status and refuses takeover. Admission audit keeps
tenant/task/event and exact broker references; atomic receipt resolution binds
the job ID afterward.

| Requirement | Evidence |
| --- | --- |
| Signed authorized internal event through audited zero-cost terminal and next work | Native synthetic workflow happy path |
| Eight simultaneous arrivals and one worker dispatch | Native concurrency case |
| Actual database reboot and new Manager without repeat execution | Native PostgreSQL restart case |
| Verifier outage, unknown recovery and separate verifier reconciliation | Native unknown case |
| Wrong tenant, spoofed role, owner-only pause, missing verification | Native negative case and ARN-93 signature tests |
| Kill at every Manager boundary | Native boundary loop and existing Manager exhaustive tests |
| Expiry, changed event identity, stale fence and later native reclaim | Native fence/expiry case and ARN-98 accepted wall-clock/lineage tests |
| Worker exception and no ambiguous retry | Native worker case and existing Manager recovery matrix |
| Misbound command, substituted idempotency and changed status | Manager-event adapter contract tests |
| Audit/store outages and interruption windows | Existing ARN-86/89/92 Manager/persistence tests, reused |

Live identity-to-database role mapping remains **BLOCKED**. Test RSA keys and
explicit synthetic JWT GUCs prove local signature validation and SQL ACLs only.
The harness's synthetic approval lookup/command-record bridge is not a deployed
atomic intake store; ARN-93's deadline/replay/audit contract still requires a
reviewed real implementation. No live OIDC, Supabase, worker or client
authorization claim follows from these tests.

Owner actions remain: review and reconcile stacked source PRs; inspect canonical
migrations, tenant RLS/ACLs and intake/caller/verifier identity mappings; implement
and verify atomic intake deadline/replay/kill checks; prove trusted issuer/JWKS
rotation; review rollback and separately authorize activation. No main merge,
production mutation or pilot activation is included. ACP stays disabled, Gemini
suspended, Eve dispatch off and limited-live readiness false.

The first accepted execution checkpoint is ACP `a7e625c5ba19c10491513c04575c3b9cbb051323`:
native run [38419266319](https://github.com/Nexus2415/ai-command-post/actions/runs/38419266319)
passed 10 tests with zero failures/skips, and
[Validate 38419266234](https://github.com/Nexus2415/ai-command-post/actions/runs/38419266234)
passed. Final-head CI and different-agent review are recorded in PR #45 and
Linear ARN-94.

Existing acceptance assets are retained: ARN-10's controlled-simulation scope,
ARN-27 PR #35's no-repeat rule for ambiguous execution and separate preview
authorization, and ARN-47's existing Chromium outage/malformed-receipt tests.
ARN-47's observed anonymous console-data refusal remains separate live UI
evidence; its authenticated cross-service/outage/kill gaps are not closed by
this native synthetic suite. No second preview probe or real Agent Run occurred.
