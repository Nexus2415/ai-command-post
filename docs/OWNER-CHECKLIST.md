# Owner checklist

Steps only Darius can take, as of 2026-10-20. They are listed in the order to do them. Claude cannot do any of these. Each one either changes the live site, a setting, a secret or billing, or needs an account Claude can't reach.

## 1. Merge the open pull requests, in this order

Merging to `main` redeploys https://ai-command-post.vercel.app within a minute or two. None of these PRs switches the engine on.

| Order | PR | What it does |
|---|---|---|
| 1 | #54 | The spend ledger fails closed if it's missing, unreadable or dated in the future |
| 2 | #55 | One shared password check for every website endpoint |
| 3 | #56 | "Engine & budget" panel on the website console |
| 4 | #57 | Keeps a copy of the spend ledger in Linear so it survives cache loss (built on #54 and #56) |
| 5 | #58 | Current AI prices (Claude, ChatGPT, Perplexity per-request fee) |
| 6 | #59 | The engine backs off when someone else claimed a task first |
| 7 | docs PR | This checklist plus refreshed HANDOFF, README and RUNBOOK |

For each one:
1. Open `github.com/Nexus2415/ai-command-post/pull/<number>`.
2. If it says **Draft**, click **Ready for review**.
3. Wait for the green check. Then click **Merge pull request**, then **Confirm merge**.
4. If GitHub says **This branch has conflicts**, stop and tell Claude in the project. Claude fixes it.

To undo a merge on the live site, open Vercel and go to the **ai-command-post** project. Click **Deployments**, then the previous good deployment, then **⋯**, then **Instant Rollback**.

Also in opsdesk-harmony: merge **#199** (atomic offboarding, ARN-123) once its checks are green. Claude fixed its migration order on 2026-10-20.

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

## 3. Wake up Supabase and apply the waiting migrations (opsdesk-harmony)

The free Supabase project was paused for inactivity. These migrations are merged but not applied: `0030`, `0033` and `0035`, plus `0034` once #199 merges.

1. Go to supabase.com/dashboard and open the Arnexyia project. Click **Restore project** (or **Resume**) and wait until it shows as healthy.
2. Tell Claude it's awake. Claude will check which migrations are actually applied and give you the exact run order. Apply them through your usual migration path, never by hand-editing tables.

Until this is done, the broker's database claim and owner intake grants exist only in code. That claim is the only real fix for two engines taking the same task.

## 4. Decide whether the engine should run at all

Right now nothing runs, on purpose. Gemini is suspended in code (ARN-115), the budget is $0, and `ACP_ACTIVE` is not `true`. To run it you need **both**:

- **An AI it may use.** Either tell Claude to lift the Gemini suspension (free tier), or add a paid key and a budget:
  1. Open GitHub and go to **Settings**, then **Secrets and variables**, then **Actions**.
  2. On the **Secrets** tab, click **New repository secret**. Use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `PERPLEXITY_API_KEY`.
  3. On the **Variables** tab, set `ACP_MONTHLY_BUDGET_USD` to the most you'll spend per month, for example `20`. Also set `ACP_DEFAULT_LEAD` to that AI: `claude`, `chatgpt` or `perplexity`.
- **The switch.** On the **Variables** tab, set `ACP_ACTIVE` to `true`. Setting it back to `false` stops it at the next run.

The console's **Engine & budget** panel shows the result after the next run.

## 5. Only if the panel says "Blocked: … spend ledger"

The engine refuses paid calls when it can't trust its spend record.

1. Add the repo variable `ACP_LEDGER_RESET` with the current month, for example `2026-10`. This restarts that month's record at $0.
2. Delete the variable after the next run.

Only do this if you're sure nothing was spent that month that the record lost.

## 6. Tidy-ups

- **Remove the Gemini key while Gemini is suspended.** In GitHub, go to **Settings**, then **Secrets and variables**, then **Actions**, then **Secrets**. Click **GEMINI_API_KEY**, then **Remove**.
- **Turn on two-factor sign-in for your GitHub account.** Go to github.com, click **Settings**, then **Password and authentication**, then **Enable two-factor authentication**. This account can merge to a live site.
- **Leave Eve alone.** Eve dispatch stays off. Its owner gates (intake grants and the JWT for `broker_intake`) are tracked in opsdesk-harmony.
