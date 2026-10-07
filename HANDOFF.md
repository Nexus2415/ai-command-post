# Handoff to Claude Code

Owner: Darius. Built 2026-10-07 in a Claude session that couldn't reach GitHub or the provider APIs, so everything below marked **unverified** has only been tested against fakes.

## Owner decisions already made

- Separate repo (not inside Arnexyia / opsdesk-harmony).
- Lead AI is switchable per command; default Claude.
- Monthly AI spend cap **$0** (free tiers only) until the owner raises it.
- Dashboard first, engine second.

## State

| Piece | Status |
|---|---|
| Dashboard (claude.ai artifact "AI Command Post") | Published and live. Reads Linear through the viewer's connector; creates command issues. The lead choice is saved in the artifact's db (`settings/lead`). Source: `dashboard/index.html` |
| Engine: plan → work → reconcile | Built; 21 tests pass (`npm test`) with fake models and fake fetch |
| Typecheck | Passes with real `@types/node` and `typescript` (pinned in `package-lock.json`); CI runs `npm ci && npm run validate` |
| Linear GraphQL queries | **Unverified** against the live API: `issues` filter shape, `DateTimeOrDuration` var type, `commentCreate`, `issueUpdate` |
| Provider clients | **Unverified** live. Model ids in `.env.example` must be checked against current provider docs |
| Firecrawl `/v2/search` and `/v2/scrape` | **Unverified**; confirm the endpoint version and response shape |
| GitHub tools | **Unverified** live. `open_pull_request` writes files through the contents API, which is fine for small changes |
| Scheduler | `.github/workflows/engine.yml`, off until repo variable `ACP_ACTIVE=true` |

## First tasks, in order

1. ~~**Create the repo**, push this tree, and confirm CI is green with real `@types/node`. Delete `types/` and `tsconfig.offline.json`.~~ Done.
2. **Verify live reads, no writes:** with only `LINEAR_API_KEY` set, run `npm run status` and fix any GraphQL shape errors in `src/linear.ts`.
3. **Free-tier end-to-end in dry run:** add `GEMINI_API_KEY`, set `ACP_ACTIVE=true`, keep `ACP_DRY_RUN=true`. Create a test command from the dashboard with **Gemini** as lead, run `npm run tick`, and read the dry-run log.
4. **Turn on writes** (`ACP_DRY_RUN=false`) for one synthetic command. Confirm sub-issues, the claim comment, `## Result` comments and the `## Command summary` all appear in Linear and on the dashboard.
5. Verify Firecrawl and the GitHub read tools on a public repo, then on an allow-listed private repo.
6. Enable the scheduled workflow only after steps 2–5 pass.

## Known gaps (prioritized)

1. **Dashboard spend panel is static.** It shows the $0 cap and doesn't read the ledger yet. Option: the engine writes `## Engine status` (spend, last tick, online agents) to a pinned Linear issue or document, and the dashboard reads it with the same connector.
2. **Ledger on Actions** persists through `actions/cache`. Caches can be evicted, so move it somewhere durable (a Linear document or a small KV) **before** raising the budget above $0.
3. **Native tool calling.** Workers use a JSON-reply protocol so all four providers behave the same. Native function calling per provider would be more reliable; keep `runTool` and the policy check as the single gate.
4. **Paid-agent rates** in `src/budget.ts` are placeholders. Update them before raising the cap.
5. **Gemini free tier:** Google may use free-tier prompts to improve its products. Don't route client or personal data through the free tier. This matters for Arnexyia work; its AGENTS.md forbids raw client data in shared tools.
6. Approval flow is one-way: the engine posts "Owner approval needed" and stops. A reply-to-approve handshake isn't built and shouldn't be until the owner asks for it.

## Rules for whoever works on this

- Never weaken: the kill switch, dry-run default, the $0 default cap, red-tier refusals, the allow-listed repos, or draft-only PRs.
- Don't commit secrets. `.env` is ignored.
- Keep the ownership rule identical in `src/agents.ts` and `dashboard/index.html`.
- One concern per PR; `npm run validate` must pass.
