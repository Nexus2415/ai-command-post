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
