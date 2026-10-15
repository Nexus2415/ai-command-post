# ARN-48 | POTUS Command Post owner guide (draft)

**One console:** The existing Arnexyia Command Post at project `arnexyia-command-post` (Vercel project ID `prj_qGNGsu7ZU45uy3kMUhHk65mOiBhY`). Confirm the deployed URL, authentication and exact merged revision before naming a single production entry URL. Older `.vercel.app` domains can retain former project names; do not invent a renamed domain.

## What to do
1. Sign in through the existing protected Command Post. A successful preview build is **not** proof production authentication is working.
2. Choose **Question** to request a read-only answer. An authorized system may record the question as a task/message, but may not execute tools merely because a question was submitted.
3. Choose **Command** for work. Review confirmation and approval requirements. Only approved work enters the shared Linear queue; commands asking to merge, deploy, buy, connect client data or change safety settings still require Darius's explicit authorization.
4. Follow the **Done, Active, Queued, Blocked, Review, Canceled** lanes. Canceled is not accomplished; Review is not merged; a task may be stale or waiting on a dependency.
5. Open a task to view signed comments, evidence and the next action. Agent names and signatures are self-reported under the shared owner account, not authenticated proof of who acted.
6. Check the **last fetched** timestamp and partial-history notices. If an integration is unavailable, the correct status is unknown/stale, not a blank green success.

## How AI work gets done
- ChatGPT coordinates in an active ChatGPT session and signs `— ChatGPT`.
- Codex is requested with `@codex <specific task>` on a PR; its output is separate from ChatGPT chat.
- Claude receives focused `@claude` issue/PR assignments when the installed workflow is available.
- Perplexity Computer reads `@Perplexity` assignments in Linear on its scheduled checks; Gemini receives `[Gemini]` ARN tasks.
- An idle consumer chat cannot be awakened or continuously controlled by the console merely because it appears in the agent roster. A queued next task is a candidate, not an agent lease or promise of execution.

## What is proven versus pending
The merged ACP background engine has been reported active in internal Gemini mode. Local synthetic browser integration of API, intake and UI changes passed reported tests, but did not establish live Linear or Eve correctness. Eve paid-model activation, real client Gmail use, live side effects and Arnexyia Limited Live are **not** granted by these demonstrations. Preview authentication, actual adapter behavior and final owner-facing deployment must be validated separately.

## Owner control
Darius is the final authority for repository merges, production deployment, environment flags, credentials, bills, customer data, and release gates. No agent comment, successful test, or AI recommendation overrides these controls.

## Troubleshooting
If data is stale, check the issue's last update and linked PR rather than repeatedly submitting a command. If a command fails, retain the draft and idempotency key on retry so duplicates are not created. If the connection is disabled or unknown, consult the ARN issue and error evidence; do not bypass deployment protection or mint new credentials without approval.

**Current coordination source:** Linear ARN-43 and its assigned child issues, plus GitHub PRs in `Nexus2415/ai-command-post`. Old standalone Eve-chat instructions from ARN-27 are historic test context, not the planned owner console route.
