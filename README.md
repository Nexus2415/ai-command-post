# AI Command Post

Give one command, pick which AI leads, and let a team of AIs (Claude, ChatGPT, Gemini, Perplexity) break it down and work it, using Linear as the shared task board, with GitHub and Firecrawl as tools.

## How it works

```
You ──command──▶ Linear issue "[Claude] …"  (created from the dashboard)
                     │
          lead AI plans │  creates sub-issues "[Perplexity] …", "[Gemini] …"
                     ▼
     each AI claims its sub-issue ─▶ uses tools ─▶ posts "## Result" ─▶ marks Done
                     │
          lead AI reconciles │  posts "## Command summary" on the command, marks it Done
                     ▼
              Dashboard shows in progress / queued / accomplished per AI
```

- **Ownership rule:** an AI owns an issue when its name is in `[brackets]` at the start of the title, in a label, or the assignee. Issues with no AI owner are never touched.
- **Lead AI:** chosen per command in the dashboard; the name in the command's title is the lead.
- **One task per AI per cycle**, highest priority first.

## Safety

| Control | Default |
|---|---|
| `ACP_ACTIVE` kill switch | `false`: reads and reports only |
| `ACP_DRY_RUN` | `true`: Linear and GitHub writes are logged, not made |
| `ACP_MONTHLY_BUDGET_USD` | `0`: only free-tier models run (Gemini). Paid calls are checked against worst-case cost before they run |
| Pull requests | off; when on, **draft** PRs only on allow-listed repos, never the default branch |
| Owner-only actions | merge, delete, deploy, purchase, send email, change credentials or release gates are refused in code and posted to the issue as "Owner approval needed" |

Model output, web pages and issue text are treated as untrusted data and can't change these rules.

## Run it

Requires Node 22.18+ (runs TypeScript directly, no build step).

```sh
cp .env.example .env        # fill in LINEAR_API_KEY at minimum
npm ci                      # dev tools only (typescript, @types/node)
npm run validate            # tests + typecheck
set -a; . ./.env; set +a
npm run status              # what's waiting; calls no models
npm run tick                # one cycle (dry run until ACP_DRY_RUN=false)
npm start                   # loop every ACP_POLL_SECONDS
```

**Free hosting:** `.github/workflows/engine.yml` runs one cycle every 15 minutes on GitHub Actions. It stays off until you set the repository variable `ACP_ACTIVE=true` and add the keys as repository secrets.

## Dashboard

`dashboard/index.html` is the published claude.ai page (AI Command Post). It reads Linear live through the viewer's Linear connector and creates command issues in the format the engine expects. Keep the ownership regex in `src/agents.ts` and the dashboard's `AGENTS` list in sync.

## Layout

```
src/config.ts        environment → config (kill switch, dry run, budget, keys, models)
src/agents.ts        roster, roles, tool kits, ownership rule
src/policy.ts        green / yellow / red authority tiers
src/budget.ts        monthly spend ledger and pre-call cap check
src/providers.ts     Anthropic, OpenAI, Gemini, Perplexity clients (plain fetch)
src/linear.ts        Linear GraphQL store + dry-run wrapper
src/tools.ts         GitHub, Firecrawl and Linear tools behind the policy check
src/orchestrator.ts  plan → work → reconcile cycle
src/cli.ts           status | tick | run
dashboard/           claude.ai dashboard page
test/                node:test suites (fake models, fake fetch; no network)
```

## Website (Vercel)

The dashboard also runs as a website: `vercel.json` serves `dashboard/` and `api/linear.js` talks to Linear for it. Import the repo in Vercel and set two environment variables: `LINEAR_API_KEY` and `ACP_SITE_PASSWORD` (anyone with the password can see your Linear team and issue commands). Without both, the site refuses every request. It can list teams and issues and create new command issues, nothing else.

### Eve adapter (`api/eve.js`, off by default)

Server-only env vars: `ACP_EVE_ACTIVE` (must be `true`), `ACP_EVE_BUDGET_USD` (must be > 0; default 0 blocks), `EVE_BASE_URL` (bare https origin), `EVE_TOKEN` (scoped Eve credential, never sent to the browser). Missing any of these returns `disabled`/`blocked` with a next step. Timeouts, network errors and 5xx return `unknown` with `retry:false` and are never retried. Enabling it in a preview is not production activation.
