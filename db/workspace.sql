-- AI Command Post workspace storage (Phase 1). Run once in the Command Post's OWN Supabase project,
-- never in the Arnexyia client database. Safe to re-run.
-- Only the website's server reaches these tables (with the service key). Row-level security is on with
-- no policies, so the public anon key can read or write nothing.

create table if not exists ws_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table if not exists ws_threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ws_projects(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  model text not null check (model in ('claude', 'chatgpt', 'gemini', 'perplexity')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ws_threads_project_idx on ws_threads (project_id, updated_at desc);
-- Private threads (2026-11-24): a private thread is never shown to another thread's AI. Existing threads start
-- shared (false). The website only shares rows where this is exactly false, so before this column exists nothing
-- is shared at all.
alter table ws_threads add column if not exists private boolean not null default false;

create table if not exists ws_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references ws_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 32000),
  model text check (model in ('claude', 'chatgpt', 'gemini', 'perplexity')),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now()
);
create index if not exists ws_messages_thread_idx on ws_messages (thread_id, created_at);

-- Project memory: short notes every AI in the project reads at the start of each reply.
create table if not exists ws_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ws_projects(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists ws_notes_project_idx on ws_notes (project_id, created_at);
-- Automatic memory: facts an AI saved from a shared thread (api/_lib/workspace-memory.js). `pending` facts wait for
-- the owner to tap Keep; no AI reads them before then. Safe to run again.
alter table ws_notes add column if not exists source text not null default 'owner' check (source in ('owner', 'ai'));
alter table ws_notes add column if not exists model text check (model in ('claude', 'chatgpt', 'gemini', 'perplexity'));
alter table ws_notes add column if not exists thread_id uuid references ws_threads(id) on delete set null;
alter table ws_notes add column if not exists pending boolean not null default false;
alter table ws_notes add column if not exists updated_at timestamptz;
-- Memory corrections: an AI may propose changing (`replaces`) or forgetting (`forget`) one note. Proposals stay pending
-- until the owner keeps them; deleting the old note deletes its proposals. Safe to run again.
alter table ws_notes add column if not exists replaces uuid references ws_notes(id) on delete cascade;
alter table ws_notes add column if not exists forget boolean not null default false;

-- A new message moves its thread to the top of the list.
create or replace function ws_touch_thread() returns trigger language plpgsql set search_path = public as $$
begin
  update ws_threads set updated_at = now() where id = new.thread_id;
  return new;
end $$;
drop trigger if exists ws_messages_touch on ws_messages;
create trigger ws_messages_touch after insert on ws_messages for each row execute function ws_touch_thread();

alter table ws_projects enable row level security;
alter table ws_threads enable row level security;
alter table ws_messages enable row level security;
alter table ws_notes enable row level security;
revoke all on ws_projects, ws_threads, ws_messages, ws_notes from anon, authenticated;

-- Spend so far, for the chat route's budget checks: this month across the workspace, and one thread's lifetime.
create or replace function ws_spend(p_thread uuid, p_since timestamptz)
returns table (month_usd numeric, thread_usd numeric)
language sql stable set search_path = public as $$
  select coalesce(sum(cost_usd) filter (where created_at >= p_since), 0),
         coalesce(sum(cost_usd) filter (where thread_id = p_thread), 0)
  from ws_messages
$$;
revoke all on function ws_spend(uuid, timestamptz) from public, anon, authenticated;

-- The "Stop everything" switch (one row). The website treats a missing row, or any error reading it, as STOPPED,
-- so nothing AI-related runs until this table exists. Running this file sets it to running once; after that only
-- the switch on the website changes it.
create table if not exists ws_control (
  id smallint primary key check (id = 1),
  stopped boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into ws_control (id, stopped) values (1, false) on conflict (id) do nothing;
alter table ws_control enable row level security;
revoke all on ws_control from anon, authenticated;

-- Connectors and custom tools the owner adds on the Tools page (READ-ONLY tools only; see
-- api/_lib/workspace-connectors.js). No keys are ever stored here: a connector names the Vercel variable that holds
-- its key. `fingerprint` is the hash of the definition the owner confirmed; a row whose definition no longer matches
-- it is ignored. A missing table only means no connectors: chat carries on without them.
create table if not exists ws_connectors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references ws_projects(id) on delete cascade,
  kind text not null check (kind in ('mcp', 'http')),
  name text not null check (name ~ '^[a-z][a-z0-9]{1,19}$'),
  spec jsonb not null check (octet_length(spec::text) <= 8000),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists ws_connectors_name_idx on ws_connectors (name);
alter table ws_connectors enable row level security;
revoke all on ws_connectors from anon, authenticated;

-- Approval gate (2026-11-25): actions an AI PROPOSES (create or comment on a Linear issue). Nothing runs until the
-- owner approves it on the workspace page; see api/_lib/workspace-actions.js. `fingerprint` is the hash of the exact
-- payload the owner was shown; approving claims the row (proposed -> running) in one conditional update, so an action
-- runs at most once. A missing table only means no proposals: chat carries on without them.
create table if not exists ws_actions (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references ws_threads(id) on delete cascade,
  kind text not null check (kind in ('linear_create_issue', 'linear_comment')),
  payload jsonb not null check (octet_length(payload::text) <= 12000),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  status text not null default 'proposed' check (status in ('proposed', 'running', 'done', 'failed', 'rejected')),
  proposed_by text check (proposed_by in ('claude', 'chatgpt', 'gemini', 'perplexity')),
  result text check (char_length(result) <= 2000),
  result_url text check (char_length(result_url) <= 500),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz
);
create index if not exists ws_actions_thread_idx on ws_actions (thread_id, created_at desc);
alter table ws_actions enable row level security;
revoke all on ws_actions from anon, authenticated;

-- Images and PDFs in a thread (2026-11-25; api/_lib/workspace-files.js). The file is kept here as base64 so it
-- never needs a public link; only the website's server (service key) can read it, and only for its own thread.
-- Messages carry a short marker naming the file. A missing table only means uploads aren't available yet.
create table if not exists ws_files (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references ws_threads(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf')),
  bytes integer not null check (bytes between 1 and 3000000),
  pages integer not null default 0 check (pages between 0 and 30),
  data text not null check (char_length(data) <= 4000000),
  created_at timestamptz not null default now()
);
create index if not exists ws_files_thread_idx on ws_files (thread_id, created_at);
alter table ws_files enable row level security;
revoke all on ws_files from anon, authenticated;

-- Scheduled agents (2026-11-25; api/_lib/workspace-agents.js). An instruction that runs by itself, daily or weekly,
-- through the same chat path as the owner's questions (stop switch, rules gate, caps, approval gate all apply). Each
-- agent writes into its own thread per month. `last_run_at` is claimed in one conditional update, so a run happens
-- at most once a day. A missing table only means no agents.
create table if not exists ws_agents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ws_projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  model text not null check (model in ('claude', 'chatgpt', 'gemini', 'perplexity')),
  cadence text not null check (cadence in ('daily', 'weekly')),
  weekday smallint check (weekday between 0 and 6),
  enabled boolean not null default true,
  thread_id uuid references ws_threads(id) on delete set null,
  thread_month text check (thread_month ~ '^[0-9]{4}-[0-9]{2}$'),
  last_run_at timestamptz,
  last_status text check (char_length(last_status) <= 300),
  created_at timestamptz not null default now(),
  check ((cadence = 'weekly') = (weekday is not null))
);
create index if not exists ws_agents_project_idx on ws_agents (project_id, created_at);
alter table ws_agents enable row level security;
revoke all on ws_agents from anon, authenticated;
