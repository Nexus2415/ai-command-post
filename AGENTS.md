# AGENTS.md — AI Command Post

Owner: Darius (POTUS) has final authority. All AI agents post through the owner's shared GitHub/Linear accounts, so **every agent must identify itself in its own words**. A signature is self-reported, not authenticated.

## Identity (required)

Use exactly one of these names. Do not use another agent's name.

| Agent | Sign as | Result heading | Branch prefix | Linear title prefix |
| --- | --- | --- | --- | --- |
| OpenAI Codex (cloud tasks, `@codex` on GitHub, Codex CLI/IDE) | `— Codex` | `## Result (Codex, done\|blocked)` | `codex/` | `[Codex]` |
| ChatGPT chat (chatgpt.com conversation) | `— ChatGPT` | `## Result (ChatGPT, …)` | `chatgpt/` or `docs/` | `[ChatGPT]` |
| Claude / Claude Code | `— Claude` | `## Result (Claude, …)` | `claude/` | `[Claude]` |
| Perplexity Computer | `— Perplexity Computer` | `## Result (Perplexity, …)` | `integration/` | `[Perplexity]` |

**Codex specifically:** you are Codex, not "ChatGPT". Sign every PR description, PR comment and Linear comment `— Codex`. Start commit subjects with `codex:` (for example `codex: fix CI lint failure`). Open branches as `codex/<issue>-<slug>`.

## Rules for every agent

1. Work only from a Linear ARN issue or a PR comment that names you. Claim before working; one implementation task per agent at a time.
2. Never merge to `main`, deploy to production, change repository variables (`ACP_ACTIVE`, `ACP_DRY_RUN`), secrets, billing or release gates. Those are owner-only.
3. No client data. Synthetic fixtures only.
4. When done: reply in the same thread with the result heading, evidence (PR, commit SHA, test output) and one concrete next request to the next agent.
5. Do not edit files another agent's open PR owns; comment on that PR instead.

## Build and test

- `npm ci && npm run validate` (Node 24): node:test suites plus `tsc`.
- `dashboard/` is static; `api/*.js` are Vercel functions; `src/` is the engine run by `.github/workflows/engine.yml`.

## Code Review Rules

- Flag any path that lets browser input choose Linear team/project scope, or that relays upstream error bodies to the browser.
- Flag any UI or API that reports an agent as connected/online, or treats canceled/duplicate work as done.
- Flag anything that makes an owner `[Question]` executable by the engine.
