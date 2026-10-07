# AI Command Post — agent instructions

Read HANDOFF.md first: it lists what is verified, what isn't, and the next tasks in order.

- Validate with `npm run validate` (node:test + tsc). Tests use fakes only; never call real APIs from tests.
- Safety defaults are product requirements: ACP_ACTIVE=false, ACP_DRY_RUN=true, ACP_MONTHLY_BUDGET_USD=0, draft-only PRs, red-tier refusals in src/policy.ts. Don't loosen them without the owner's explicit say-so.
- The ownership rule (src/agents.ts `match`) must stay identical to the dashboard's AGENTS list in dashboard/index.html.
- No secrets in the repo.
