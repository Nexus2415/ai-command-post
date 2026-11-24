-- ARN-137 proposed independent emergency store. Disposable database only; never run in production without owner authorization.
-- Provision in a separate control-plane database/credential boundary; do not share an application service key.
-- Roles are provisioned independently by an authorized operator. None may be members of the other roles.
begin;
create schema if not exists emergency_control;
revoke all on schema emergency_control from public;
create table if not exists emergency_control.latch (
  id smallint primary key check (id=1),
  mode text not null check(mode in ('RUN','AEGIS','BLACKOUT')),
  generation bigint not null check(generation between 1 and 9007199254740991)
);
-- Start contained. Reapplying does not reset the mode or generation.
insert into emergency_control.latch values(1,'BLACKOUT',1) on conflict do nothing;
create table if not exists emergency_control.events (
  generation bigint primary key,
  prior_mode text not null,
  mode text not null,
  reason text not null check(char_length(reason) between 1 and 200),
  recorded_at timestamptz not null default clock_timestamp()
);
revoke all on emergency_control.latch, emergency_control.events from public, emergency_reader, emergency_containment, emergency_owner;
create or replace function emergency_control.read_state()
returns table(mode text,generation bigint)
language sql stable security definer set search_path=pg_catalog as $$
  select l.mode,l.generation from emergency_control.latch l where id=1
$$;
-- Containment may escalate only, never resume. The owner can also contain.
create or replace function emergency_control.contain(p_mode text,p_reason text)
returns table(decision text,generation bigint)
language plpgsql security definer set search_path=pg_catalog as $$
declare v emergency_control.latch%rowtype;
begin
  if p_mode is null or p_mode not in ('AEGIS','BLACKOUT') or p_reason is null or char_length(p_reason) not between 1 and 200 then
    return query select 'invalid'::text,null::bigint; return;
  end if;
  select * into v from emergency_control.latch where id=1 for update;
  if not found then return query select 'unavailable'::text,null::bigint; return; end if;
  if v.mode='BLACKOUT' or v.mode=p_mode then return query select 'already_contained'::text,v.generation; return; end if;
  if v.generation=9007199254740991 then return query select 'generation_exhausted'::text,v.generation; return; end if;
  update emergency_control.latch l set mode=p_mode,generation=v.generation+1 where id=1;
  insert into emergency_control.events(generation,prior_mode,mode,reason) values(v.generation+1,v.mode,p_mode,p_reason);
  return query select 'contained'::text,v.generation+1;
end $$;
-- Only the separate owner role has this RPC. Expected generation prevents stale recovery.
-- Evidence is an owner assertion/reference, not independent verification of external isolation.
create or replace function emergency_control.recover(p_generation bigint,p_evidence text)
returns table(decision text,generation bigint)
language plpgsql security definer set search_path=pg_catalog as $$
declare v emergency_control.latch%rowtype;
begin
  if p_generation is null or p_evidence is null or char_length(trim(p_evidence)) not between 1 and 200 then
    return query select 'invalid'::text,null::bigint; return;
  end if;
  select * into v from emergency_control.latch where id=1 for update;
  if not found then return query select 'unavailable'::text,null::bigint; return; end if;
  if v.generation<>p_generation then return query select 'stale'::text,v.generation; return; end if;
  if v.mode='RUN' then return query select 'already_running'::text,v.generation; return; end if;
  if v.generation=9007199254740991 then return query select 'generation_exhausted'::text,v.generation; return; end if;
  update emergency_control.latch l set mode='RUN',generation=v.generation+1 where id=1;
  insert into emergency_control.events(generation,prior_mode,mode,reason) values(v.generation+1,v.mode,'RUN',trim(p_evidence));
  return query select 'recovered'::text,v.generation+1;
end $$;
revoke all on function emergency_control.read_state() from public;
revoke all on function emergency_control.contain(text,text) from public;
revoke all on function emergency_control.recover(bigint,text) from public;
grant usage on schema emergency_control to emergency_reader, emergency_containment, emergency_owner;
grant execute on function emergency_control.read_state() to emergency_reader, emergency_containment, emergency_owner;
grant execute on function emergency_control.contain(text,text) to emergency_containment, emergency_owner;
grant execute on function emergency_control.recover(bigint,text) to emergency_owner;
commit;
