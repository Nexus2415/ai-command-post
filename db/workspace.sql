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
revoke all on ws_projects, ws_threads, ws_messages from anon, authenticated;
