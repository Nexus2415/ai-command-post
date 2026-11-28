-- ARN-169 candidate workspace storage. NOT deployed. No caller privileges are granted.
-- The existing trusted grant lookup remains required; a task claim alone is not owner authorization.
-- All test data are synthetic. Owner-only SQL fixture until separately reviewed authorization/role mapping.
create table if not exists public.ws_document_artifacts (
  artifact_id uuid primary key,
  task_id uuid not null unique,
  project_id uuid not null references public.ws_projects(id) on delete cascade,
  thread_id uuid not null references public.ws_threads(id) on delete cascade,
  principal text not null check (char_length(principal) between 1 and 200),
  run_id uuid not null,
  expires_at timestamptz not null,
  filename text not null check(filename ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.docx$'),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  bytes integer not null check(bytes between 1 and 300000),
  data bytea,
  revoked boolean not null default false,
  check((revoked and data is null) or (not revoked and data is not null and octet_length(data)=bytes and encode(sha256(data),'hex')=sha256))
);
alter table public.ws_document_artifacts enable row level security;
revoke all on public.ws_document_artifacts from public,anon,authenticated,service_role;

create or replace function public.ws_document_revoke_on_scope_change() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if new.private is distinct from old.private or new.project_id is distinct from old.project_id then
    update public.ws_document_artifacts set revoked=true,data=null where thread_id=old.id and not revoked;
  end if;
  return new;
end $$;
revoke all on function public.ws_document_revoke_on_scope_change() from public,anon,authenticated,service_role;
drop trigger if exists ws_document_scope_change on public.ws_threads;
create trigger ws_document_scope_change after update of private,project_id on public.ws_threads
for each row execute function public.ws_document_revoke_on_scope_change();

-- Trusted adapter must establish the actual owner grant BEFORE supplying these exact values.
-- Functions are deliberately owner-only until the deployed authority and role mapping are approved.
create or replace function public.ws_document_put(
  p_artifact uuid,p_task uuid,p_project uuid,p_thread uuid,p_principal text,p_run uuid,
  p_expiry timestamptz,p_filename text,p_sha text,p_data text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare b bytea; a public.ws_document_artifacts%rowtype;
begin
  if p_artifact is null or p_task is null or p_project is null or p_thread is null or p_run is null
    or p_principal is null or char_length(p_principal) not between 1 and 200
    or p_expiry is null or p_expiry<=clock_timestamp() or p_expiry>clock_timestamp()+interval '1 day'
    or p_filename is null or p_filename !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.docx$'
    or p_sha is null or p_sha !~ '^[a-f0-9]{64}$'
    or p_data is null or char_length(p_data)>400000 then return jsonb_build_object('ok',false,'reason','invalid'); end if;
  begin b:=decode(p_data,'base64'); exception when others then return jsonb_build_object('ok',false,'reason','invalid_data'); end;
  if octet_length(b) not between 1 and 300000 or encode(sha256(b),'hex')<>p_sha
    or substring(b from 1 for 4)<>decode('504b0304','hex') then return jsonb_build_object('ok',false,'reason','invalid_data'); end if;
  perform 1 from public.ws_control where id=1 and stopped=false for share;
  if not found then return jsonb_build_object('ok',false,'reason','stopped'); end if;
  perform 1 from public.ws_threads where id=p_thread and project_id=p_project and private=true for share;
  if not found then return jsonb_build_object('ok',false,'reason','scope'); end if;
  perform 1 from public.acp_claims where issue_id=p_task::text and run_id=p_run::text
    and executor='acp:chatgpt' and claimed_at>clock_timestamp()-interval '30 minutes' for share;
  if not found or p_expiry<=clock_timestamp() then return jsonb_build_object('ok',false,'reason','stale'); end if;
  insert into public.ws_document_artifacts(artifact_id,task_id,project_id,thread_id,principal,run_id,expires_at,filename,sha256,bytes,data)
  values(p_artifact,p_task,p_project,p_thread,p_principal,p_run,p_expiry,p_filename,p_sha,octet_length(b),b)
  on conflict do nothing;
  select * into a from public.ws_document_artifacts where artifact_id=p_artifact for share;
  if not found or a.revoked or a.task_id<>p_task or a.project_id<>p_project or a.thread_id<>p_thread
    or a.principal<>p_principal or a.run_id<>p_run or a.expires_at<>p_expiry or a.filename<>p_filename
    or a.sha256<>p_sha or a.data is distinct from b then return jsonb_build_object('ok',false,'reason','conflict'); end if;
  return jsonb_build_object('ok',true,'receipt',jsonb_build_object('artifactId',a.artifact_id,'taskId',a.task_id,'projectId',a.project_id,'threadId',a.thread_id,'filename',a.filename,'mime','application/vnd.openxmlformats-officedocument.wordprocessingml.document','bytes',a.bytes,'sha256',a.sha256));
end $$;
revoke all on function public.ws_document_put(uuid,uuid,uuid,uuid,text,uuid,timestamptz,text,text,text) from public,anon,authenticated,service_role;

create or replace function public.ws_document_get(p_artifact uuid,p_task uuid,p_project uuid,p_thread uuid,p_principal text,p_run uuid,p_expiry timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.ws_document_artifacts%rowtype;
begin
  perform 1 from public.ws_control where id=1 and stopped=false for share;
  if not found then return jsonb_build_object('ok',false,'reason','stopped'); end if;
  perform 1 from public.ws_threads where id=p_thread and project_id=p_project and private=true for share;
  if not found then return jsonb_build_object('ok',false,'reason','scope'); end if;
  select * into a from public.ws_document_artifacts where artifact_id=p_artifact and task_id=p_task and project_id=p_project and thread_id=p_thread and principal=p_principal and run_id=p_run and expires_at=p_expiry and expires_at>clock_timestamp() and not revoked for share;
  if not found then return jsonb_build_object('ok',false,'reason','scope'); end if;
  return jsonb_build_object('ok',true,'receipt',jsonb_build_object('artifactId',a.artifact_id,'taskId',a.task_id,'projectId',a.project_id,'threadId',a.thread_id,'filename',a.filename,'mime','application/vnd.openxmlformats-officedocument.wordprocessingml.document','bytes',a.bytes,'sha256',a.sha256),'data',encode(a.data,'base64'));
end $$;
revoke all on function public.ws_document_get(uuid,uuid,uuid,uuid,text,uuid,timestamptz) from public,anon,authenticated,service_role;
