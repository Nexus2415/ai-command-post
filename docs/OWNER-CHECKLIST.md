# Owner checklist

Steps only Darius can take, as of 2026-10-20. They are listed in the order to do them. Claude cannot do any of these. Each one either changes the live site, a setting, a secret or billing, or needs an account Claude can't reach.

## 1. Source merge decisions (owner-only, not an execution queue)

This document's 2026-10-20 PR sequence is superseded. ACP PRs #54–#60 and opsdesk #199 are historical work; do **not** merge or re-open them based on this checklist. Confirm each PR's current merged/open/draft state and exact head from GitHub before considering any change. Opsdesk #199 and #200 are merged **source**; that does not establish canonical Supabase application.

The current ACP open-PR queue and its independent reviews are tracked in [ARN-45](https://linear.app/arnexyia/issue/ARN-45), not this static document. No ACP PR is approved for merge by this checklist. A successful GitHub check or Vercel preview is not a production acceptance test. Darius alone makes merge decisions and records any required production/deployment authorization in Linear. No agent may merge or switch a deployment.

## 2. Rate-limit the website password (F3)

Without a rate limit, someone can guess the site password as fast as they like. Claude tried three ways to set the limit and all were refused for the `arnexyia` team: the Vercel connector, the Vercel CLI and the Vercel API. Pick one:

**A. Let Claude do it.**
1. On claude.ai, open **Settings**, then **Connectors**, then **Vercel**.
2. Reconnect it and tick the **arnexyia** team.
3. Tell Claude. Claude will show you the exact rule before it publishes anything.

**B. Do it yourself.**
1. Open the Vercel dashboard. Switch to the **arnexyia** team, then open the **ai-command-post** project.
2. Click **Firewall**, then **Configure**, then **+ New Rule**.
3. Name it `API rate limit`.
4. Under **If**, choose **Request Path**, then **Starts with**, and enter `/api/`.
5. Under **Then**, choose **Rate Limit**:
   - **Fixed window**, **60 seconds**, **30 requests**.
   - Keyed by **IP**.
   - Action: **Too Many Requests (429)**.
6. Click **Save Rule**, then **Review Changes**, then **Publish**.

Your plan may limit how many rate-limit rules you can have. If Vercel won't offer **Rate Limit**, tell Claude and it will add a slower-retry check in code instead.

## 3. Canonical Supabase preflight (owner-gated)

Canonical Supabase migration state is **not established** by GitHub source or by this checklist. Do not assume a particular project is paused, restored, healthy, or migrated. Migrations 0030–0035 must be assessed individually against the owner-identified authoritative database.

Before any connection, Darius must record in Linear the exact database/project, named operator and permitted **read-only metadata** scope. Inspect only the approved catalog and migration-ledger metadata; no row data, secrets, grants, writes, role changes or migrations. A separate specific written owner decision is required for any canonical schema application and rollout. A migration existing on `main` is not evidence of deployment. See [ARN-45](https://linear.app/arnexyia/issue/ARN-45), [ARN-122](https://linear.app/arnexyia/issue/ARN-122) and [ARN-123](https://linear.app/arnexyia/issue/ARN-123).

## 4. Engine activation remains blocked

Keep the engine off, dry-run on and the model budget at $0. Gemini is suspended in source; neither an existing API key nor an older runbook restores it. Do not set `ACP_ACTIVE=true`, `ACP_DRY_RUN=false`, `ACP_ALLOW_PULL_REQUESTS=true`, `ACP_MONTHLY_BUDGET_USD>0`, or restore Gemini based on this document.

The next internal milestone remains: an explicitly owner-issued, unseeded/default-deny subject+tenant+task+expiry grant, tenant-bound durable intake/claim, one synthetic zero-cost execution or refusal, independently verified receipt and truthful console state, then restart/kill/idempotency. Existing synthetic/disposable PostgreSQL proofs do not establish deployed OIDC mapping, canonical Supabase state, or a real worker. Each restricted activation, role mapping, credential, billing or deployment step needs its own specific written owner approval in Linear. Stage 3 and Limited Live remain closed.

## 5. Only if the panel says "Blocked: … spend ledger"

The engine refuses paid calls when it can't trust its spend record.

1. Add the repo variable `ACP_LEDGER_RESET` with the current month, for example `2026-10`. This restarts that month's record at $0.
2. Delete the variable after the next run.

Only do this if you're sure nothing was spent that month that the record lost.

## 6. Tidy-ups

- **Remove the Gemini key while Gemini is suspended.** In GitHub, go to **Settings**, then **Secrets and variables**, then **Actions**, then **Secrets**. Click **GEMINI_API_KEY**, then **Remove**.
- **Turn on two-factor sign-in for your GitHub account.** Go to github.com, click **Settings**, then **Password and authentication**, then **Enable two-factor authentication**. This account can merge to a live site.
- **Leave Eve alone.** Eve dispatch stays off. Its owner gates (intake grants and the JWT for `broker_intake`) are tracked in opsdesk-harmony.

## Workspace (Phase 1)
Setup for the new Workspace page (projects, threads, chat, plugins, project memory) is in `docs/WORKSPACE.md`, under "Everything the owner does to start using the workspace".
