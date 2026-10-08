# AI Command Post — operating runbook

## How the engine runs
- GitHub Actions workflow `.github/workflows/engine.yml` runs on cron `7,22,37,52 * * * *` (every 15 min) and on manual dispatch (Actions tab → Engine → Run workflow). GitHub often fires scheduled runs late or hours apart.
- Each run reads Linear team `ARN` for commands, lets the lead AI (Gemini) plan sub-issues, works them, and reconciles.
- Repo variables control it (Settings → Secrets and variables → Actions → Variables):
  - `ACP_ACTIVE` — `true` lets the engine act; anything else makes runs exit without work.
  - `ACP_DRY_RUN` — `true` (default) plans but writes nothing to Linear/GitHub; `false` = live writes.
  - `ACP_MONTHLY_BUDGET_USD` — spend cap, default `0` (free tiers only).
  - `ACP_ALLOW_PULL_REQUESTS` — default `false`; engine PRs are always draft.
- The first log line of a run states the mode, e.g. `ACTIVE · live writes · cap $0 · agents online: Gemini`.

## Provider errors
- HTTP retries (`src/providers.ts`): 429/500/502/503/504 are retried after 5 s and 15 s before failing.
- Requeue rules (`src/orchestrator.ts`):
  - Transient failure (status 0, 408, 425, 429, 5xx, 529) **before any tool call**: issue goes back to unstarted with an `ACP retry` comment; picked up next run. Max 3 retries.
  - Retries exhausted, or a permanent error: comment `## Result … blocked` and set the issue to Canceled.
  - Failure **after** a tool call: blocked immediately (never replayed, to avoid duplicate writes).
- To retry a blocked task, reopen it in Linear (or re-issue the command).

## How to pause
1. Fastest: set repo variable `ACP_ACTIVE` to `false`. Next run does nothing.
2. Read-only mode: set `ACP_DRY_RUN` to `true`.
3. Hard stop: Actions → Engine → ⋯ → Disable workflow.
Resume by reversing the change.

## Reading the spend ledger
- Ledger file: `.acp/ledger.json` (override with `ACP_LEDGER_PATH`), persisted between runs in the Actions cache (`acp-ledger-*`).
- Each run prints the budget summary in its log; open the latest Engine run to see month-to-date spend vs. cap.
- With cap `$0`, any call that would cost money is refused.

## Keys and models
- Only Gemini (free tier) is keyed (`GEMINI_API_KEY`). Linear, Firecrawl and Vercel keys are tools, not models.
- No paid API keys (Anthropic, OpenAI, Perplexity, AI Gateway) may be added, and the budget may not be raised, without the owner's written approval in Linear.
- Keys live only in GitHub Actions secrets / Vercel env vars, never in the repo or chat.
