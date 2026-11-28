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
- The "Independent review" check on each PR (`.github/workflows/independent-review.yml`, `src/review-check.ts`) shows whether a DIFFERENT AI's GitHub App approved the PR's current commit, using GitHub's record of the reviewer, never a "— Name" line. The owner's own account never counts as an AI review. It finds each AI's app login by asking GitHub the app's name with the app's key (`ARNEXYIA_<AI>_BOT`), and always runs the check code from the default branch so a PR can't run with those keys. It only reports until repo variable `ACP_REQUIRE_INDEPENDENT_REVIEW` is `true`; then a PR without an independent approval shows a red check. It never comments, approves or merges.
- Each AI can act on GitHub as its own GitHub App instead of the shared `ACP_GITHUB_TOKEN` (`src/identity.ts`), so GitHub records which AI did what. Per AI (`CLAUDE`, `CHATGPT`, `PERPLEXITY`) only two values are needed: repo **variable** `ARNEXYIA_<AI>_BOT` = the App ID, and repo **secret** `ARNEXYIA_<AI>_BOT` = the app's .pem (the older names `ACP_GH_APP_<AI>_ID` / `_KEY` also work). The installation id and app name are looked up from GitHub with the app's own key; set `ACP_GH_APP_<AI>_INSTALLATION` only if an app is installed in more than one place. An AI with none set uses the shared token as before; ID without key (or the reverse) is refused, and a refused app token fails the call instead of falling back to the shared account. The run's first log line lists who acts as its own app.
- Repo secret `ACP_PROVENANCE_SECRET` (or `ACP_PROVENCE_SECRET`; any 32+ random characters, Settings → Secrets and variables → Actions → Secrets) signs every claim and result the engine writes in Linear (`src/provenance.ts`). With it set, a typed or pasted "ACP executor: acp:…" or "## Result (…)" that the engine didn't sign is ignored: a forged claim keeps the engine OFF that task, and a forged result never completes a command. Without it the engine refuses to run live (`ACP_ACTIVE=true` with `ACP_DRY_RUN=false`); dry runs still work. Changing the secret makes earlier signatures stop verifying, so only rotate it between commands. The run's first log line says `claims signed` or `claims UNSIGNED`.
- Atomic claims (`src/claims.ts`, ARN-62): with repo secrets `ACP_WORKSPACE_DB_URL` and `ACP_WORKSPACE_DB_KEY` (the workspace Supabase project and its service_role key, the same values the site uses in Vercel) the engine must win a row in table `acp_claims` before it claims or works a task, so concurrent initial claims are exclusive. A run's row can be taken over by a later run of the same AI only after 30 minutes (past the job's 25-minute limit; a guard test keeps the two apart); another AI's row is never taken. Without the settings, non-live operation can use Linear-only claims; live writes are refused by the Stop everything configuration gate. An unreachable configured store causes the engine to skip claiming that run. Lease expiry relies on the scheduled job timeout; it is not receiver-side fencing or proof of exactly-once external effects. The first log line says `claims … atomic` or `Linear-only`.
- Crash recovery (`src/recovery.ts`, 2026-11-28): if a run dies mid-task (timeout, cancelled workflow, crashed runner), its task used to stay In Progress forever. Now a later run resumes it when all hold: the task is In Progress with this AI's own signed claim, no result was posted since it entered In Progress, it entered In Progress more than 30 minutes ago, and the run wins the dead run's `acp_claims` row (a live run's row is never taken; two racing runs can't both win). Without the claim store nothing is resumed. Each draft PR the engine opens is recorded at once in a signed `ACP opened pull request:` comment, so the resumed run continues that PR on the same branch instead of opening a second one; unsigned records grant nothing. Each resume leaves `ACP recovery n/2`; a third interruption closes the task as blocked with no model call. Stop everything still halts a resumed run (it goes back to Todo if no tool ran). To keep a task off the engine, comment `ACP executor: manual` — a person moving a task to In Progress without an engine claim is never touched.
- The first log line of a run states the mode, e.g. `ACTIVE · live writes · cap $0 · agents online: Gemini`. "Online" means a key is configured, not that the provider was reachable; reachability shows only when a call succeeds or fails in that run.

## Goals: give the engine a goal, not a task

Create a top-level Linear issue (ARN team) titled `[Goal] <what you want>`, in Todo or Backlog, with the outcome in the description. The engine then:

1. Claims it and has the lead (Claude by default) plan the first steps as sub-issues, in order. The goal moves to In Progress.
2. Works the steps one at a time. Each step is told what the earlier steps reported. A step that opens a draft pull request stays In Progress until you merge it (Linear usually marks it Done on merge; if not, mark it Done), and the next step waits for that.
3. When every step is finished, the lead reads the results and either closes the goal as done (with a summary comment) or plans the next steps.

What you see on the goal issue: its sub-issues (the steps and their states), each plan, and one `ACP goal run N/M` comment per engine run with a progress line (steps done, steps used, runs used).

Limits, set as Actions variables:

| Variable | Default | Hard ceiling in code | What it caps |
|---|---|---|---|
| `ACP_GOAL_MAX_TASKS` | 6 | 25 | Steps one goal may create, across all rounds of planning |
| `ACP_GOAL_MAX_RUNS` | 10 | 50 | Engine runs one goal may use: each step attempt and each planning or review call is one run |

When a cap is hit, a step is blocked, or the lead plans nothing usable, the goal stays In Progress with a `## Goal paused` comment saying why, and no more paid calls are made on it until something changes. To retry a blocked step move it to Todo; to skip it mark it Duplicate; to end the goal close it.

Spend: every call still goes through the monthly cap (`ACP_MONTHLY_BUDGET_USD`) and is refused before it is made, or counted, when it doesn't fit. A coding step has cost about $1 to $2, so a 6-step goal needs roughly $6 to $15 of monthly budget. The Stop everything switch halts a goal like everything else: before each run, model call, tool call, and before any step is created. The planner can't change any limit or setting, and every pull request stays a draft for you to merge.

## Provider errors
- HTTP retries (`src/providers.ts`): 429/500/502/503/504/529 are retried after 5 s and 15 s before failing.
- Requeue rules (`src/orchestrator.ts`):
  - Transient failure (exactly status 0, 408, 425, 429, 500, 502, 503, 504 or 529; other 5xx codes are permanent) **before any tool call**: issue goes back to unstarted with an `ACP retry` comment; picked up next run. Max 3 retries.
  - Retries exhausted, or a permanent error: comment `## Result … blocked` and set the issue to Canceled.
  - Failure **after** a tool call: blocked immediately (never replayed, to avoid duplicate writes).
- To retry a blocked task, reopen it in Linear (or re-issue the command).
- If a run reports that a command's summary "is already posted, but a comment can't prove the engine wrote it", the engine closes it only when that run wrote the summary itself (an earlier close failed, or someone else posted a matching one). Read the summary; if it's genuine, move the command to Done yourself. It isn't paid for again either way.

## How to pause
Fastest, no approval needed: press **Stop everything** on the site. The engine reads that same switch
(`ws_control`, src/stop-switch.ts) at the start of every run, before every model call and before every tool call,
so the next step stops within seconds. An unreadable switch counts as stopped. Live writes refuse to start unless
`ACP_WORKSPACE_DB_URL` and `ACP_WORKSPACE_DB_KEY` (service_role) are set for the engine, so the switch is always connected.

Changing any of these variables needs the owner's specific written approval in Linear.
1. Variable: set repo variable `ACP_ACTIVE` to `false`. Next run does nothing.
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
