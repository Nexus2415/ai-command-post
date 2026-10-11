# ARN-27: one-time Eve synthetic proof and kill-switch acceptance

**Status: SCRIPT ONLY, NOT EXECUTED.** This document is an operator checklist, not an authorization to modify a Vercel setting, activate an agent, pay for model calls, process customer data, or promote a release gate. The Command Post UI being deployed and `/health` being reachable do not prove Eve can execute.

## Preconditions and scope

1. Read [ARN-12](https://linear.app/arnexyia/issue/ARN-12), [ARN-43](https://linear.app/arnexyia/issue/ARN-43), repository `AGENTS.md` in `Nexus2415/opsdesk-harmony`, and current [ACP README](../../README.md). Reconfirm production flags and approved preview scope in Linear before a live preview attempt. If owner authorization for a **single preview-only synthetic run**, model source or any required Vercel change is missing, **STOP: BLOCKED**.
2. Use only a dedicated preview of **Eve execution service**, not a production deployment or real customer tenant. Resolve and record exact immutable Vercel project/deployment IDs, commit SHAs, allowed principal, operation ID, and protection status. Never treat a `READY` preview or health response as execution proof.
3. Use a synthetic operation such as `ARN27-SYNTHETIC: evaluate a fictional scheduling exception, produce a challenge, and reconcile with no tools`; invent all names, identifiers and content. No mailbox, OAuth data, customer identifiers, credentials, external writes, or real client connectors.
4. **Cost gate:** independently verify the chosen model/provider can complete this exact run at incremental **$0**, with worst-case reservation and durable accounting; "budget = 0" alone does not prove a run is free. If paid capacity, model authorization, cost reservation, account trust or audit evidence is unverified, do not run. No AI Gateway billing enablement or paid API key.
5. **Dispatch gate:** ACP `api/eve.js` currently returns **unsupported** for commands; `api/eve-oidc.js` is an inert request builder. Do not bypass either by calling an undocumented endpoint. Confirm from installed Eve source a real session entrypoint, response schema, OIDC subject/trust, deployment protection trust, single-owner admission and idempotent attempt/lease. Missing any one is **BLOCKED**, not a reason to bypass the adapter.

## One bounded preview-only procedure (only after owner gate and all preflight checks PASS)

| Step | Action | Required evidence |
|---|---|---|
| 1 | Capture pre-run evidence: preview SHA, version, flags, budget cap and account/tenant isolation, Agent Run count and existing spend ledger. | Dated ID/source references, redacted screenshots or machine-readable results; no secrets |
| 2 | Obtain distinct approval for setting `ARNEXYIA_MULTI_AI_ACTIVE=true` on the **single preview** only, while production and unrelated ACP flags remain unchanged. Record who changed the preview and when. | Approved scope in Linear, audited setting change; no change without approval |
| 3 | Submit **exactly one** synthetic operation through the documented and authorized preview event path. Use a fresh idempotency key and correlation ID. No direct undocumented HTTP requests or protection-bypass tokens. | Intake receipt with exact attempt/run ID and authenticated caller provenance. HTTP 200/202 means accepted only, never completed |
| 4 | Observe real Eve Agent Runs: primary analysis, independent challenge, then reconciliation. Correlate each run to the same operation and verify ordering, agent identity, durable result markers, and zero external tool effects. | Separate Agent Run IDs, timestamps, sanitized messages, trace and reconciliation decision. Mocked responses do **not** count |
| 5 | Read durable spend ledger, provider billing/source and budget reservations. Verify actual **$0** incremental spend and no chargeable calls; absence of a bill is not enough without invocation evidence. | Measured per-attempt units, provider charge category, reservation/settlement log, 0 net spend |
| 6 | Immediately restore `ARNEXYIA_MULTI_AI_ACTIVE=false` on the preview, including if any earlier step failed. Verify saved state rather than trusting the setter response. | Read-back with timestamp and actor; no other environments changed |
| 7 | Attempt one additional *synthetic* session under the now-disabled preview using the same authenticated test path. Confirm explicit rejection **before** model/provider execution, no new Agent Run and no external write. Do not use production as a test target. | Rejected receipt/status, absence of new session/run, zero additional spend, immutable audit evidence |

## Abort and rollback criteria

Stop immediately on ambiguous 200/202, missing authenticated identity, unknown route/schema, wrong tenant, duplicate execution, unbounded retry, cost > $0, credentials exposed, production-side effects, protection bypass, or failure to observe exact flag state. Disable the preview flag and record the discrepancy as **BLOCKED**. On network timeout, do not resubmit the same operation blindly: reconcile the existing operation ID first. If the kill-switch test creates any run after disable, open an incident issue and do not declare this criterion passed.

The ACP GitHub Actions engine has a **different** kill switch, `ACP_ACTIVE`, and defaults to off with `ACP_DRY_RUN=true`; this runbook neither enables that engine nor uses consumer AI sessions as authenticated model execution. `ACP_EVE_ACTIVE`, production `ARNEXYIA_MULTI_AI_ACTIVE`, Gemini suspension, client authorization, and `limited_live_ready=false` stay unchanged unless separately approved.

## Evidence and closure packet

Record in the ARN-12/ARN-43 Linear thread: date, operator and scope of approval; preview project/deployment IDs and SHA; source and app-layer authentication path; exact synthetic operation ID; primary/challenge/reconcile Agent Run IDs and ordering; accepted vs completed response semantics; policy, lease/idempotency and tenant decisions; observed cost with ledger/provider support; settings *before, during, after*; rejection-without-execution proof; CI and synthetic-test references; anomalies and explicitly unverified elements.

Verdict must be **PASS** (all above externally verified), **BLOCKED** (required authorization/infrastructure absent), or **FAIL** (an observed safety invariant violated). A simulated command, a deployment marked READY, green CI, model consensus, or a health endpoint is **not** proof of the real Agent Run path. PASS of this preview-only test never authorizes production dispatch, customer data, production settings, or Limited Live.
