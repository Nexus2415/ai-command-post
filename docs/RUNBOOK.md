# AI Command Post — operating runbook

## How the engine runs
- GitHub Actions workflow `.github/workflows/engine.yml` runs on cron `7,22,37,52 * * * *` (every 15 min) and on manual dispatch (Actions tab → Engine → Run workflow). GitHub often fires scheduled runs late or hours apart.
- Each run reads Linear team `ARN` for commands, lets the lead AI plan sub-issues, works them, and reconciles. Gemini is suspended in code (`SUSPENDED_AGENTS`), so it is always refused. Any other AI still runs only if the engine is active, its key is configured, and the policy and budget gates allow the call; this document can't confirm those, so don't infer that the engine is off from Gemini's suspension. Whether the engine is on depends on repo variables this document can't see: on 2026-10-30 the last 100 scheduled runs were all skipped, meaning `ACP_ACTIVE` was not `true` at those runs, but the present values (including `ACP_DRY_RUN`, which earlier records say was set to `false`) are unverified. Check the latest Engine run and the Variables page before relying on either.
- After each active run the engine rewrites the Linear project document "AI Command Post: engine status"; the website console's Engine & budget panel shows it (last run, mode, spend vs cap, paid-call state, AIs online). "Not reported yet" means no active run has happened since that feature shipped.
- Repo variables control it (Settings → Secrets and variables → Actions → Variables):
  - `ACP_ACTIVE` — `true` lets the engine act; anything else makes runs exit without work.
  - `ACP_DRY_RUN` — `true` (default) plans but writes nothing to Linear/GitHub; `false` = live writes.
  - `ACP_MONTHLY_BUDGET_USD` — spend cap, default `0` (free tiers only).
  - `ACP_ALLOW_PULL_REQUESTS` — default `false`; engine PRs are always draft.
- Each AI can act on GitHub as its own GitHub App instead of the shared `ACP_GITHUB_TOKEN` (`src/identity.ts`), so GitHub records which AI did what. Per AI (`CLAUDE`, `CHATGPT`, `PERPLEXITY`): repo variables `ACP_GH_APP_<AI>_ID`, `ACP_GH_APP_<AI>_INSTALLATION`, `ACP_GH_APP_<AI>_SLUG` and repo secret `ACP_GH_APP_<AI>_KEY` (the app's .pem). An AI with none set uses the shared token as before; a partly set one is refused, and a refused app token fails the call instead of falling back to the shared account. The run's first log line lists who acts as its own app.
- Repo secret `ACP_PROVENANCE_SECRET` (any 32+ random characters, Settings → Secrets and variables → Actions → Secrets) signs every claim and result the engine writes in Linear (`src/provenance.ts`). With it set, a typed or pasted "ACP executor: acp:…" or "## Result (…)" that the engine didn't sign is ignored: a forged claim keeps the engine OFF that task, and a forged result never completes a command. Without it the engine refuses to run live (`ACP_ACTIVE=true` with `ACP_DRY_RUN=false`); dry runs still work. Changing the secret makes earlier signatures stop verifying, so only rotate it between commands. The run's first log line says `claims signed` or `claims UNSIGNED`.
- The first log line of a run states the mode, e.g. `ACTIVE · live writes · cap $0 · agents online: Gemini`. "Online" means a key is configured, not that the provider was reachable; reachability shows only when a call succeeds or fails in that run.

## Provider errors
- HTTP retries (`src/providers.ts`): 429/500/502/503/504/529 are retried after 5 s and 15 s before failing.
- Requeue rules (`src/orchestrator.ts`):
  - Transient failure (exactly status 0, 408, 425, 429, 500, 502, 503, 504 or 529; other 5xx codes are permanent) **before any tool call**: issue goes back to unstarted with an `ACP retry` comment; picked up next run. Max 3 retries.
  - Retries exhausted, or a permanent error: comment `## Result … blocked` and set the issue to Canceled.
  - Failure **after** a tool call: blocked immediately (never replayed, to avoid duplicate writes).
- To retry a blocked task, reopen it in Linear (or re-issue the command).
- If a run reports that a command's summary "is already posted, but a comment can't prove the engine wrote it", the engine closes it only when that run wrote the summary itself (an earlier close failed, or someone else posted a matching one). Read the summary; if it's genuine, move the command to Done yourself. It isn't paid for again either way.

## How to pause
Changing any of these variables needs the owner's specific written approval in Linear.
1. Fastest: set repo variable `ACP_ACTIVE` to `false`. Next run does nothing.
2. Read-only mode: set `ACP_DRY_RUN` to `true`.
3. Hard stop: Actions → Engine → ⋯ → Disable workflow.
Resume by reversing the change.

## Reading the spend ledger
- Ledger file: `.acp/ledger.json` (override with `ACP_LEDGER_PATH`), persisted between runs in the Actions cache (`acp-ledger-*`).
- Each run prints the budget summary in its log; open the latest Engine run to see month-to-date spend vs. cap.
- With cap `$0`, any call that would cost money is refused.
- A durable copy also lives in the Linear project document "AI Command Post: spend ledger", rewritten after each active run. Each run merges the cache copy and the Linear copy, so spend is lost only if both lose it. Don't edit that document: an unreadable or future-dated copy blocks paid calls (same `ACP_LEDGER_RESET` fix as below).
- If the cap is above `$0` and the ledger is missing, unreadable or dated in the future, every paid call is refused (free tiers still run) and the run log's budget summary shows `ledgerProblem`. The fix is to set repo variable `ACP_LEDGER_RESET` to the current month (for example `2026-10`), which accepts that this month's spend restarts at `$0` and only counts for that month. A reset can erase evidence of earlier spend, so don't set it without the owner's specific written approval in Linear, after the month's spend has been reconciled against the provider bills (see `docs/OWNER-CHECKLIST.md`). A cache that falls back to an older copy from the same month can still under-count, which is why a durable ledger comes before any larger budget.

## Keys and models
- Which model keys are configured can't be confirmed from the repo: the Engine workflow accepts Anthropic, OpenAI, Gemini and Perplexity secrets, and only GitHub's secrets page shows which exist. Earlier records say only `GEMINI_API_KEY` was set. Gemini is suspended in code by the owner (ARN-115), so it never runs whatever its key. Linear, Firecrawl and Vercel keys are tools, not models.
- No paid API keys (Anthropic, OpenAI, Perplexity, AI Gateway) may be added, and the budget may not be raised, without the owner's written approval in Linear.
- Keys live only in GitHub Actions secrets / Vercel env vars, never in the repo or chat.
