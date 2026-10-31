# Owner checklist

Historical 2026-10-20 owner notes. The old step order is no longer authoritative; verify each prerequisite and approval afresh.

> **Safety status, 2026-10-26 (source-only):** This reference is **not an authorization to execute**. Verify current GitHub `main`, exact PR heads and checks, Linear owner decisions, and authoritative deployed state before acting. Darius alone merges. Production/deployment, schema migration, secrets, flags, billing, live workers, role grants, Stage 3, `limited_live_ready`, and client-data actions require Darius's specific written Linear approval. Merged source and synthetic tests do not prove live readiness. Gemini remains suspended; engine activation and spending remain blocked. See [ARN-45](https://linear.app/arnexyia/issue/ARN-45).

## 1. Source merge decisions (owner-only, not an execution queue)

This document's 2026-10-20 PR sequence is superseded. ACP PRs #54–#60 and opsdesk #199 are historical work; do **not** merge or re-open them based on this checklist. Confirm each PR's current merged/open/draft state and exact head from GitHub before considering any change. Opsdesk #199 and #200 are merged **source**; that does not establish canonical Supabase application.

The current ACP open-PR queue and its independent reviews are tracked in [ARN-45](https://linear.app/arnexyia/issue/ARN-45), not this static document. No ACP PR is approved for merge by this checklist. A successful GitHub check or Vercel preview is not a production acceptance test. Darius alone makes merge decisions and records any required production/deployment authorization in Linear. No agent may merge or switch a deployment.

## 2. Rate-limit the website password (F3)

Project records report that an `API rate limit` rule was published on 2026-10-21 for `/api/` (30 requests per 60 seconds per IP, returning 429). **Current active firewall state has not been independently verified by this checklist.** First open the Vercel `arnexyia-command-post` project's **Firewall** and verify that the rule is present, active and correctly scoped. Do not create a duplicate rule or assume the historical report proves current protection.

If the rule is missing or misconfigured, **stop** and obtain Darius's specific written Linear approval for the proposed production firewall change. The steps below are historical reference only; recheck the provider UI and plan before an authorized operator makes any change:

1. Open the Vercel dashboard, select the **arnexyia** team and **arnexyia-command-post** project.
2. Open **Firewall** and inspect existing rules; only if the approved rule is absent, choose **Configure** and **+ New Rule**.
3. Name it `API rate limit`.
4. Under **If**, choose **Request Path**, then **Starts with**, and enter `/api/`.
5. Under **Then**, choose **Rate Limit**:
   - **Fixed window**, **60 seconds**, **30 requests**.
   - Keyed by **IP**.
   - Action: **Too Many Requests (429)**.
6. Click **Save Rule**, then **Review Changes**, then **Publish**.

The plan may limit available rules. If **Rate Limit** is unavailable, record the blocker in ARN-45; do not silently substitute a code change or publish another rule without review and written approval.

## 3. Canonical Supabase preflight (owner-gated)

Canonical Supabase migration state is **not established** by GitHub source or by this checklist. Do not assume a particular project is paused, restored, healthy, or migrated. Migrations 0030–0035 must be assessed individually against the owner-identified authoritative database.

Before any connection, Darius must record in Linear the exact database/project, named operator and permitted **read-only metadata** scope. Inspect only the approved catalog and migration-ledger metadata; no row data, secrets, grants, writes, role changes or migrations. A separate specific written owner decision is required for any canonical schema application and rollout. A migration existing on `main` is not evidence of deployment. See [ARN-45](https://linear.app/arnexyia/issue/ARN-45), [ARN-122](https://linear.app/arnexyia/issue/ARN-122) and [ARN-123](https://linear.app/arnexyia/issue/ARN-123).

## 4. Engine activation remains blocked

**Do not assume the current GitHub Actions variables are safe.** Earlier project records say `ACP_ACTIVE=true` and `ACP_DRY_RUN=false` were set; their **present values are unverified** here. Darius or a specifically authorized operator must check **GitHub → Settings → Secrets and variables → Actions → Variables** before relying on them. The intended safe configuration is `ACP_ACTIVE=false`, `ACP_DRY_RUN=true`, `ACP_ALLOW_PULL_REQUESTS=false` and a $0 budget, but **even a corrective flag change requires Darius's specific written Linear approval**. Gemini's source suspension and the $0 budget are not substitutes for verifying runtime state or authority. Never activate a worker, enable agent PR writes, restore Gemini, or permit paid/provider-credit calls on this document's authority.

The next internal milestone remains: an explicitly owner-issued, unseeded/default-deny subject+tenant+task+expiry grant, tenant-bound durable intake/claim, one synthetic zero-cost execution or refusal, independently verified receipt and truthful console state, then restart/kill/idempotency. Existing synthetic/disposable PostgreSQL proofs do not establish deployed OIDC mapping, canonical Supabase state, or a real worker. Each restricted activation, role mapping, credential, billing or deployment step needs its own specific written owner approval in Linear. Stage 3 and Limited Live remain closed.

## 5. Only if the panel says "Blocked: … spend ledger"

The engine refuses paid calls when it can't trust its spend record.

1. Add the repo variable `ACP_LEDGER_RESET` with the current month, for example `2026-10`. This restarts that month's record at $0.
2. Delete the variable after the next run.

Only do this after a separate specific written owner decision, verified spend reconciliation and a safe recovery plan. A reset can erase evidence of prior spend; do not infer zero usage from a missing ledger.

## 6. Tidy-ups

- **Gemini key hygiene (owner-gated).** Verify whether a `GEMINI_API_KEY` secret exists without revealing its value. Removal or any secret change requires Darius's specific written Linear approval; the Gemini suspension remains in force regardless.
- **Turn on two-factor sign-in for your GitHub account.** Go to github.com, click **Settings**, then **Password and authentication**, then **Enable two-factor authentication**. This account can merge to a live site.
- **Do not activate Eve.** Actual deployed dispatch/role state must be independently verified. Intake-grant and `broker_intake` JWT mapping gates remain owner-controlled in opsdesk-harmony.

## Workspace (Phase 1)
Setup for the new Workspace page (projects, threads, chat, plugins, project memory) is in `docs/WORKSPACE.md`, under "Everything the owner does to start using the workspace".
