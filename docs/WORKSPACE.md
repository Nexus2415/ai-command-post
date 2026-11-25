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
- Through OpenRouter, each reply's saved cost is the higher of OpenRouter's reported cost and our own rates, plus OpenRouter's 5.5% credit fee; the worst-case check before the reply adds the fee too. Gemini stays off through OpenRouter as well. `ACP_OPENROUTER_MODEL_CLAUDE` (and `_CHATGPT`, `_PERPLEXITY`) pick a different OpenRouter model from that AI's own maker only (`anthropic/…`, `openai/…`, `perplexity/…`); anything else, including any `google/` model, leaves that AI switched off; a pricier model's pre-reply estimate is low, but its real cost is still recorded and counted.
- Known limit: two replies sent at the same moment can each pass the check, so the cap can be exceeded by at most one reply.

### Owner setup to start chatting
In Vercel, open **arnexyia-command-post → Settings → Environment Variables**, add these for Production, then redeploy:
1. One AI key. The simplest is `OPENROUTER_API_KEY`: one key and one prepaid balance that answers for Claude, ChatGPT and Perplexity. A provider's own key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`) also works, and wins over OpenRouter for that AI.
2. `ACP_WORKSPACE_MONTHLY_BUDGET_USD`, for example `15`.
3. Optional: `ACP_WORKSPACE_THREAD_BUDGET_USD` if $1 per thread is too low.

## Step 4: plugins
- One plugin format, shared by every AI that can use tools (Claude and ChatGPT; Perplexity searches the web itself). A plugin is a name, a description, a readiness check and its tools. Adding a plugin means adding one entry to `api/_lib/workspace-plugins.js`.
- First plugins, all read-only: **Linear** (search tasks on the Arnexyia Launch Operations board), **GitHub** (read files, search issues and PRs in `ACP_GITHUB_REPOS` only), **Web search** (Firecrawl).
- A plugin switches on when its key is set in Vercel (`LINEAR_API_KEY`, `GITHUB_TOKEN` with `ACP_GITHUB_REPOS`, `FIRECRAWL_API_KEY`). The page lists which are on.
- One reply may use tools for up to 3 rounds. The budget is checked again before each round, counting what the reply has already cost; when a cap is reached the reply stops and says so. Everything spent is recorded.
- There is deliberately no "open any web page" tool. A page could instruct the AI to send private data it had read to an address the page chose. The page reader below only opens addresses from a search or from the owner. Writes stay with the engine, behind its safety policy.

## Step 5: project memory
- Each project has up to 20 short notes (2,000 characters each). Every AI in the project reads them at the start of each reply, up to 8,000 characters, newest kept first.
- Add or delete notes under **Project memory** in the projects column.

## Step 6: side-by-side answers
- Under the message box, tick up to two other ready AIs ("Also ask, side by side"). The message then goes to the thread's AI and those AIs at once, and their answers show in columns.
- The budget check covers every chosen AI's worst case together, before any call. Plugins stay off for side-by-side answers, so nothing can spend past that check.

## Step 6b: how a question is answered (1 AI / + Checker / Discussion)
- A three-way toggle on the question box picks how each question is answered. The line under the box shows the rough cost of the chosen mode. The choice is remembered per project while the page is open (the page never writes browser storage).
  - **1 AI**: the thread's AI answers. Cheapest, well under 1 cent.
  - **+ Checker** (the default): the thread's AI answers, then the cheapest other ready AI checks it and replies AGREE or DISAGREE with a sentence or two (about 1 cent in all). If it disagrees, it gives its own full answer and the two go through the discussion's review and conclusion rounds below (a few cents).
  - **Discussion**: the thread's AI plus the AIs ticked under "AIs" (one more by default, up to 3 in all) go through three rounds:
  1. Each AI answers on its own (the same as side-by-side).
  2. Each AI reads the others' answers, labelled Answer A, B… with no names, and writes Agreements, Conflicts (every point where the answers contradict each other, which side is right and why, or what would settle it) and a Revised answer.
  3. The thread's own AI (the lead) first settles every conflict on the strength of the evidence, not on a vote, then writes the one concluded answer: Answer, Conflicts settled, Risks, Next step, in plain language.
- A finished discussion shows the concluded answer first, with "Each AI's own answer" and "How they settled their disagreements" (including the checker's verdict) folded underneath. A check that agreed shows as a short line under the answer.
- There is no pop-up per question. The check and the checker's own answer are each checked against the caps before they run. Before a discussion runs the server works out the worst-case cost of all three rounds; if that would go over the thread or monthly budget, nothing is sent and the page says so. Each round is checked again before it runs.
- If an AI fails, the others carry on; the conclusion lists who dropped out. If the lead fails, another AI that answered writes the conclusion.
- Every round is saved in the thread like any other reply, so later messages in the thread see the conclusion. A side-by-side answer can be turned into one agreed answer later with "Agree on one answer from these"; a roundtable that stopped part way shows "Finish: write the agreed answer".
- Typical cost: + Checker about 1 cent (2 calls, the second short); a two-AI discussion a few cents (about 5 calls). With three AIs about $0.03–0.06; worst case about $0.15. The $1 thread and $15 monthly caps still apply.
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

## Step 9: Tools and connectors page (add and build your own, read-only)
Open **Tools and connectors** from the workspace (`/tools.html`).
- **Add a connector you already have**: an MCP server, by address. Click **Check what it offers**; the page lists the server's tools. Only tools the server marks read-only, and whose names don't sound like a change (send, delete, buy…), can be ticked. Each tool gets only the simple inputs the server lists.
- **Build a new look-up tool**: name, what it does, its https address, the inputs the AI fills in (text, number or yes/no; they go into the address as `?name=value`), and what comes back. Always a GET.
- **Review, then confirm.** Nothing is usable until you have read the plain-language review (where it goes, what the AI can send, what comes back, the key, who can use it, the cost) and pressed **Confirm and turn on**. The confirmation covers exactly what you saw; any change needs a new review.
- **Turn off** takes effect on the very next reply. **Delete** removes it. Connectors set in Vercel (`ACP_MCP_SERVERS`, Step 8) are listed too but can only be changed there.
- Who can use it: every project, or one project.

What the builder refuses, and why:
- Anything that writes, sends, posts, buys, deletes or changes (any method but GET, and names, descriptions or addresses with words like send, post, delete, buy, pay, update). Outward actions wait for the approval gate.
- Any address that isn't public https: IP addresses, localhost, `.internal`, `.local`, `.lan`, `.corp` and similar names, custom ports, usernames in the address. When a tool runs, every address its name resolves to is checked again at connect time, so a public name pointing at a private address (for example 169.254.169.254) is blocked too. Redirects are never followed.
- Any key typed into the page, or a key-like part of an address (`?api_key=…`). A key lives in a Vercel variable: `ACP_TOOL_TOKEN_…` for a look-up tool, `ACP_MCP_TOKEN_…` for a connector. The page only ever holds the variable's name. One key variable can only go to one host.
- Anything the workspace's rules (the harm rules) refuse.

Every use of a tool passes the Stop everything switch and the rules gate, is counted against the spend caps (a nominal $0.001 per call, so a runaway loop stops at the cap), and is listed under the reply. What a tool sends back reaches the AI wrapped as untrusted data, never instructions.

Owner setup: run the latest `db/workspace.sql` once (it adds the `ws_connectors` table). Until then the page says the setup step is needed and chat works as before.

Known limits: a GET can still have side effects on a badly designed service, so only point the builder at look-up addresses. Whatever the AI types into an input goes to that service, as with any search tool.

## Everything the owner does to start using the workspace
1. Merge the workspace PRs in order (#61, #62, #63, #64, #65). Each merge goes live.
2. Create the free Supabase project and run `db/workspace.sql` (see Owner setup above). If you ran an earlier copy, run the latest one again; it is safe to re-run.
3. In Vercel, add `ACP_WORKSPACE_DB_URL` and `ACP_WORKSPACE_DB_KEY`.
4. To chat, add one AI key (`OPENROUTER_API_KEY` covers every AI) and `ACP_WORKSPACE_MONTHLY_BUDGET_USD`, then redeploy.
5. Optional plugins: `LINEAR_API_KEY`, `GITHUB_TOKEN` with `ACP_GITHUB_REPOS`, `FIRECRAWL_API_KEY`, and MCP servers in `ACP_MCP_SERVERS` (Step 8).

## Safety: Stop everything and the rules gate
**Stop everything.** A red button at the top of the dashboard and of the workspace page. One press, no confirm:
- The page cancels its own waiting requests at once (a roundtable stops between rounds) and sending is disabled.
- The server refuses every AI action (replies, retries, side-by-side answers, every roundtable round) with "Everything is stopped". A reply already under way stops before its next tool call or model call; a model call already sent can't be recalled, so its cost is still recorded.
- Reading projects, threads and notes keeps working.
- **Fails closed:** if the switch can't be read (storage down, the `ws_control` table missing, an odd value), the answer is "stopped".
- Only the owner turns it back on ("Turn AI back on", behind the site password, with a confirm). No AI has a tool that touches it.
- Setup: run `db/workspace.sql` again in the Supabase SQL editor (safe to re-run). It adds the one-row `ws_control` table, set to running. Until it exists the workspace reads as stopped.

**Rules gate.** Every message the owner sends, every tool call an AI makes and every reply an AI writes is checked by our code against the harm rules in `src/policy.ts` (the website's copy is `api/_lib/workspace-rules.js`; a test keeps them identical). Refused: hurting or killing people, weapons or attacks meant to harm many people, breaking into systems or accounts, malware, fraud, forgery, phishing, fake reviews, stalking, threats, blackmail, unlawful discrimination, making illegal drugs, and sexual content involving minors.
- A refused message is not sent to any AI and not saved; a refused tool call doesn't run; a refused reply is withheld (its cost still counts). Each refusal is written into the thread with the reason, and logged on the server (which rule, never the text).
- Refusal notes are never sent back to a model as history.
- **Why in code:** the workspace reaches models from several makers through OpenRouter, each trained differently and with its own idea of what to refuse. None is trusted to police itself. The gate runs around the model, so the same lines hold whichever model answers, and a model can't argue past them.
- Limit, stated plainly: the rules are a keyword net for clear cases ("how do I kill someone", "write ransomware"), tuned not to trip on business language ("kill the process", "anti-money laundering rules"). A carefully disguised request can get past a keyword net; the real backstop is that workspace AIs can only read. Nothing they do reaches the outside world.

## Web access (read-only)
Claude and ChatGPT threads can use the public web through Firecrawl (Perplexity already searches the web itself):
- **web_search**: titles, links and short descriptions. About $0.01 each.
- **web_read_page**: one page as text. About $0.005 each. It only opens an address that came back from a web_search **in the same reply**, or that the owner wrote in their message. Any other address (one the model or a web page made up), IP addresses, local or internal names, and addresses with a login are refused before anything is fetched. This is what stops a page from steering the AI into sending private data to an attacker's address.
- **Untrusted, never instructions.** Everything fetched reaches the model wrapped as untrusted web content, with marker look-alikes removed so a page can't fake the end of the wrapper. The AIs are told never to follow instructions inside it. The real fence is in code: even a model that obeys the page can't reach a new address, and every tool it has only reads. `test/web-access.test.ts` runs a deliberately gullible model against a page full of instructions and checks that the outside calls are identical to those for a harmless page.
- **Same fences as everything else:** every web call passes the Stop everything switch and the rules gate first.
- **Metered.** Each web call is checked against the monthly and thread caps (with everything the reply has already cost) before it starts; one that would go over doesn't run. Its cost is added to the reply's saved cost.
- **Audited.** Under each reply that used the web: "Web activity (audit, times UTC)", listing every search, page read, blocked address and refused call, with its cost.
- Costs are upper estimates at Firecrawl's dearest paid rate ($5 per 1,000 credits). Firecrawl's free plan gives 1,000 credits a month (about 500 searches or 1,000 page reads) at no charge.
- **Owner setup:** add `FIRECRAWL_API_KEY` in Vercel (Production), then redeploy. Without it, web tools stay off.
- Not included, on purpose: anything that acts outward (sending email, posting, buying, filling forms, writing to other systems). That needs an approval gate and the owner's decision first.

## Step 8: threads share what they know (unless private)
- When an AI answers in a thread, it can draw on the **other threads of the same project**: each one's latest roundtable conclusion, or else its newest few messages. Threads in other projects are never included.
- Under an answer that used another thread, a small line says **Drew on: "thread title", …**, so you can always tell where something came from. That line is for you only; it is never sent back to an AI.
- **Private:** the button next to the AI's name at the top of a thread says **Shared in this project** or **Private**. Click it to switch. A private thread is invisible to every other thread's AI until you make it shared again. It shows "Private" in the thread list too. A private thread's own AI can still draw on the project's shared threads.
- How it's enforced: the server asks the database only for threads whose `private` flag is exactly *false*, in one query together with their messages, and checks every row again before using it. A missing or unreadable flag counts as private, and if the query fails nothing is shared (the answer still goes ahead). The roundtable, side-by-side answers and every tool go through the same path; no plugin can read threads. `test/workspace-shared.test.ts` proves a private thread's words never appear in any request to any AI.
- Re-checked just before sending: if a thread the answer was going to use is made private in the moment between, nothing is sent to any AI and the page says so; each later tool round checks again. - Copies don't travel on: an AI answer that drew on other threads (it carries the "Drew on" line; a roundtable's review and conclusion inherit the line from its answers) is never quoted into a third thread, and once a thread's recent answers drew on others, only the owner's own messages are quoted from it. So if A turns private, what thread B's AI repeated from A does not reach thread C. Limit: this looks at each thread's newest 8 messages, not its whole history. - Marking a thread private stops future sharing. It can't take back what another thread's AI already wrote in an earlier answer.
- Bounded, so the cost stays small: at most 4 threads, 1,500 characters each and 6,000 in all (about 2,000 tokens), picked by how many words they share with your question, then by how recently they were used. The budget check before each answer counts this extra text, and the real cost is recorded as usual.
- Typical extra cost per answer: about $0.004 with Claude, under $0.001 with ChatGPT; a roundtable's first round under $0.01 more in all. These are worst cases; a short thread adds less.
- Setup: one line of SQL (in `db/workspace.sql`): `alter table ws_threads add column if not exists private boolean not null default false;`. Until it runs, nothing is shared and threads show "Private (setup needed)".
