# Workspace (Phase 1)

The Command Post is growing from an engine control panel into a workspace: projects, threads with any AI model, plugins every model can use, and spend caps. The plan is in the project files (`ai-command-post/PHASE1-WORKSPACE-PLAN.md`).

## Step 1: storage (this change)
- `db/workspace.sql`: tables for projects, threads and messages. Row-level security is on with no policies, so only the website's server can reach them.
- `api/workspace.js`: list and create projects and threads, read a thread, and add your own messages. It needs the site password and same-site requests. AI replies are only ever written by the server.
- Until storage is set up, the route answers "Workspace storage isn't set up yet." Nothing else on the site changes.

## Owner setup (once, about 5 minutes)
Use a NEW Supabase project for the Command Post. Never use the Arnexyia client database.
1. Go to supabase.com/dashboard and sign in. Click **New project** and name it `ai-command-post`. The free plan is fine. Save the database password somewhere safe.
2. When it has finished creating, open **SQL Editor**, click **New query**, paste the whole of `db/workspace.sql`, and click **Run**. It is safe to run again.
3. Open **Project Settings → API**. Copy the **Project URL** and the **service_role** key. Never paste these into chat.
4. In Vercel, open project **arnexyia-command-post** → **Settings → Environment Variables**. Add `ACP_WORKSPACE_DB_URL` (the Project URL) and `ACP_WORKSPACE_DB_KEY` (the service_role key) for Production, then redeploy.

## Step 3: chat with a model
- Each thread's AI answers in the thread. The page shows which AIs are ready and the spend so far.
- Before every reply, the server checks a worst-case cost against two caps: `ACP_WORKSPACE_MONTHLY_BUDGET_USD` (default 0, so nothing paid runs) and `ACP_WORKSPACE_THREAD_BUDGET_USD` (default $1). The real cost of each reply is saved with it.
- Gemini stays off, matching the engine (ARN-115). An AI with no key shows "No API key added yet."
- Provider error text is never shown. If a reply fails, your message is kept and **Get reply** tries again.
- Through OpenRouter, each reply's saved cost is the higher of OpenRouter's reported cost and our own rates, plus OpenRouter's 5.5% credit fee; the worst-case check before the reply adds the fee too. Gemini stays off through OpenRouter as well. `ACP_OPENROUTER_MODEL_CLAUDE` (and `_CHATGPT`, `_PERPLEXITY`) pick a different OpenRouter model; a pricier model's pre-reply estimate is low, but its real cost is still recorded and counted.
- Known limit: two replies sent at the same moment can each pass the check, so the cap can be exceeded by at most one reply.

### Owner setup to start chatting
In Vercel, open **arnexyia-command-post → Settings → Environment Variables**, add these for Production, then redeploy:
1. One AI key. The simplest is `OPENROUTER_API_KEY`: one key and one prepaid balance that answers for Claude, ChatGPT and Perplexity. A provider's own key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`) also works, and wins over OpenRouter for that AI.
2. `ACP_WORKSPACE_MONTHLY_BUDGET_USD`, for example `15`.
3. Optional: `ACP_WORKSPACE_THREAD_BUDGET_USD` if $1 per thread is too low.

## Step 4: plugins
- One plugin format, shared by every AI that can use tools (Claude and ChatGPT; Perplexity searches the web itself). A plugin is a name, a description, a readiness check and its tools. Adding a plugin means adding one entry to `api/lib/workspace-plugins.js`.
- First plugins, all read-only: **Linear** (search tasks on the Arnexyia Launch Operations board), **GitHub** (read files, search issues and PRs in `ACP_GITHUB_REPOS` only), **Web search** (Firecrawl).
- A plugin switches on when its key is set in Vercel (`LINEAR_API_KEY`, `GITHUB_TOKEN` with `ACP_GITHUB_REPOS`, `FIRECRAWL_API_KEY`). The page lists which are on.
- One reply may use tools for up to 3 rounds. The budget is checked again before each round, counting what the reply has already cost; when a cap is reached the reply stops and says so. Everything spent is recorded.
- There is deliberately no "open any web page" tool. A page could instruct the AI to send private data it had read to an address the page chose. Writes stay with the engine, behind its safety policy.

## Step 5: project memory
- Each project has up to 20 short notes (2,000 characters each). Every AI in the project reads them at the start of each reply, up to 8,000 characters, newest kept first.
- Add or delete notes under **Project memory** in the projects column.

## Step 6: side-by-side answers
- Under the message box, tick up to two other ready AIs ("Also ask, side by side"). The message then goes to the thread's AI and those AIs at once, and their answers show in columns.
- The budget check covers every chosen AI's worst case together, before any call. Plugins stay off for side-by-side answers, so nothing can spend past that check.
- If one AI fails, the other answers are kept and the page says which AI didn't answer.
- Later messages in the thread send the earlier answers back to the AI labelled by who gave them, so it can build on all of them.

## Step 7: text files
- **Attach text file** under the message box adds up to 3 text files (notes, CSV, JSON, code and similar) to the next message. A message can be just files.
- The page reads each file as text and sends it inside the message, marked with its name; nothing is uploaded or stored anywhere else. The 32,000-character message limit covers the files too.
- In the conversation each file shows as a block you can open and close. Images and PDFs aren't supported yet.

## Step 8: MCP plugins
- Any remote MCP server (Streamable HTTP) can be added as a plugin by listing it in `ACP_MCP_SERVERS`, for example:
  `[{"name":"notes","url":"https://mcp.example.com/mcp","tokenVar":"ACP_MCP_TOKEN_NOTES","tools":[{"name":"search","args":{"query":"string"}}]}]`
- Only the tools you name in `tools` are offered, and only when the server also marks them read-only. That mark is the server's own claim and can't be checked from here, so only name tools whose documentation says they only read. Your list is what decides.
- For each tool, name the arguments it may receive and their type (`string`, `number` or `boolean`). A tool named on its own (`"list_recent"`) receives no arguments. Anything else the AI tries to send is refused before it leaves, as are values over 300 characters and any value that contains one of this site's keys or passwords.
- A server's token goes in its own Vercel variable whose name starts with `ACP_MCP_TOKEN_`. No other variable can be used, so no other key can be sent to an MCP server.
- Up to 5 servers. A server that can't be reached is skipped and the reply goes ahead. The page lists each server under Plugins. Claude and ChatGPT can use them; Perplexity and side-by-side answers don't use plugins.
- Before naming a tool, check what it reads. A tool that fetches any web page brings back the risk described in Step 4.

## Everything the owner does to start using the workspace
1. Merge the workspace PRs in order (#61, #62, #63, #64, #65). Each merge goes live.
2. Create the free Supabase project and run `db/workspace.sql` (see Owner setup above). If you ran an earlier copy, run the latest one again; it is safe to re-run.
3. In Vercel, add `ACP_WORKSPACE_DB_URL` and `ACP_WORKSPACE_DB_KEY`.
4. To chat, add one AI key (`OPENROUTER_API_KEY` covers every AI) and `ACP_WORKSPACE_MONTHLY_BUDGET_USD`, then redeploy.
5. Optional plugins: `LINEAR_API_KEY`, `GITHUB_TOKEN` with `ACP_GITHUB_REPOS`, `FIRECRAWL_API_KEY`, and MCP servers in `ACP_MCP_SERVERS` (Step 8).
