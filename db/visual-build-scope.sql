-- ARN-164: Command Post's OWN workspace database ONLY. Draft migration, not an execution grant.
-- Apply after workspace.sql in an isolated test database first. No clients or provider credentials.
create table if not exists public.ws_visual_scopes (
  scope_id uuid primary key,
  principal text not null check (principal ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null check (octet_length(manifest::text) <= 24000),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  saved_at timestamptz not null default clock_timestamp(),
  state text not null default 'scope_saved' check (state = 'scope_saved'),
  max_budget_micros bigint not null default 0 check (max_budget_micros = 0),
  synthetic_only boolean not null default true check (synthetic_only)
);
alter table public.ws_visual_scopes enable row level security;
revoke all on public.ws_visual_scopes from public, anon, authenticated, service_role;

-- Trusted server only, SECURITY DEFINER with fixed search path. No action/claim/dispatch or outbox.
create or replace function public.ws_save_visual_scope(p_id uuid, p_principal text, p_manifest jsonb, p_expires_at timestamptz, p_fingerprint text)
returns table(scope_id uuid, outcome text)
language plpgsql security definer set search_path = pg_catalog as $$
declare
  r jsonb;
  t uuid;
  p uuid;
  f public.ws_files%rowtype;
  existing public.ws_visual_scopes%rowtype;
  n integer;
begin
  if p_id is null or p_principal is null or p_principal !~ '^[a-f0-9]{64}$' or p_fingerprint is null
    or p_fingerprint !~ '^[a-f0-9]{64}$' or p_expires_at is null or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '15 minutes' or p_manifest is null
    or jsonb_typeof(p_manifest) <> 'object' or octet_length(p_manifest::text) > 24000 then
    return query select null::uuid, 'invalid'::text; return;
  end if;
  if not (p_manifest ?& array['projectId','threadId','repository','content','files'])
    or (select count(*) from jsonb_object_keys(p_manifest)) <> 5
    or jsonb_typeof(p_manifest->'projectId') is distinct from 'string'
    or jsonb_typeof(p_manifest->'threadId') is distinct from 'string'
    or jsonb_typeof(p_manifest->'repository') is distinct from 'string'
    or (p_manifest->>'repository') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9_.-]{1,100}$'
    or split_part(p_manifest->>'repository','/',2) in ('.','..')
    or jsonb_typeof(p_manifest->'content') is distinct from 'string'
    or char_length(trim(p_manifest->>'content')) not between 1 and 4000
    or jsonb_typeof(p_manifest->'files') is distinct from 'array' then
    return query select null::uuid, 'invalid'::text; return;
  end if;
  if jsonb_array_length(p_manifest->'files') not between 1 and 3 then
    return query select null::uuid, 'invalid'::text; return;
  end if;
  t := (p_manifest->>'threadId')::uuid; p := (p_manifest->>'projectId')::uuid;
  perform 1 from public.ws_control c where c.id=1 and c.stopped=false for share;
  if not found then return query select null::uuid, 'stopped'::text; return; end if;
  perform 1 from public.ws_threads th where th.id=t and th.project_id=p and th.private=true for share;
  if not found then return query select null::uuid, 'scope_denied'::text; return; end if;
  select count(distinct x->>'id') into n from jsonb_array_elements(p_manifest->'files') x;
  if n <> jsonb_array_length(p_manifest->'files') then return query select null::uuid, 'invalid'::text; return; end if;
  for r in select value from jsonb_array_elements(p_manifest->'files') loop
    if jsonb_typeof(r) <> 'object' then return query select null::uuid, 'invalid'::text; return; end if;
    if not (r ?& array['id','name','mime','bytes','sha256']) or (select count(*) from jsonb_object_keys(r)) <> 5
      or jsonb_typeof(r->'id') is distinct from 'string' or jsonb_typeof(r->'name') is distinct from 'string'
      or jsonb_typeof(r->'mime') is distinct from 'string' or jsonb_typeof(r->'bytes') is distinct from 'number'
      or jsonb_typeof(r->'sha256') is distinct from 'string' or (r->>'sha256') !~ '^[a-f0-9]{64}$' then
      return query select null::uuid, 'invalid'::text; return;
    end if;
    select * into f from public.ws_files wf where wf.id=(r->>'id')::uuid and wf.thread_id=t for share;
    if not found or f.mime not in ('image/png','image/jpeg','image/gif','image/webp')
      or f.name is distinct from r->>'name' or f.mime is distinct from r->>'mime'
      or f.bytes is distinct from (r->>'bytes')::integer or f.bytes not between 1 and 1500000
      or octet_length(decode(f.data,'base64')) <> f.bytes
      or encode(sha256(decode(f.data,'base64')),'hex') is distinct from r->>'sha256' then
      return query select null::uuid, 'reference_changed'::text; return;
    end if;
  end loop;
  if p_expires_at <= clock_timestamp() then return query select null::uuid, 'expired'::text; return; end if;
  insert into public.ws_visual_scopes(scope_id,principal,manifest,fingerprint,expires_at)
    values(p_id,p_principal,p_manifest,p_fingerprint,p_expires_at)
    on conflict on constraint ws_visual_scopes_pkey do nothing;
  if found then return query select p_id,'saved'::text; return; end if;
  select * into existing from public.ws_visual_scopes s where s.scope_id=p_id;
  if found and existing.principal=p_principal and existing.manifest=p_manifest and existing.fingerprint=p_fingerprint
    and existing.expires_at=p_expires_at and p_expires_at > clock_timestamp() then
    return query select p_id,'already_saved'::text; return;
  end if;
  return query select null::uuid,'conflict'::text;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
  return query select null::uuid,'invalid'::text;
end $$;
revoke all on function public.ws_save_visual_scope(uuid,text,jsonb,timestamptz,text) from public, anon, authenticated;
grant execute on function public.ws_save_visual_scope(uuid,text,jsonb,timestamptz,text) to service_role;
