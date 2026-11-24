-- ARN-136: proposed workspace-only budget contract. NOT a production migration.
-- No automatic activation. Apply only to disposable PostgreSQL until independently reviewed.
-- One workspace-wide lock serializes every admission and settlement.
-- A request UUID is single-use: a repeated reserve never grants a second dispatch.
-- Unknown outcomes stay held across UTC month boundaries, with no automatic expiry/release.
-- Monetary values are integer USD micros. Trusted caller must establish a real upper bound.
begin;

create table if not exists public.ws_budget_gate (
  id smallint primary key check (id = 1)
);
insert into public.ws_budget_gate(id) values (1) on conflict do nothing;

create table if not exists public.ws_budget_reservations (
  request_id uuid primary key,
  thread_id uuid not null references public.ws_threads(id) on delete restrict,
  reserved_micros bigint not null check (reserved_micros > 0),
  admitted_at timestamptz not null,
  settled_at timestamptz,
  actual_micros bigint check (actual_micros >= 0),
  check ((settled_at is null) = (actual_micros is null))
);

alter table public.ws_budget_gate enable row level security;
alter table public.ws_budget_reservations enable row level security;
revoke all on public.ws_budget_gate, public.ws_budget_reservations from public, anon, authenticated, service_role;
create index if not exists ws_budget_thread_idx on public.ws_budget_reservations(thread_id);
create index if not exists ws_budget_settled_idx on public.ws_budget_reservations(settled_at);

-- Deliberately does not use a caller-supplied clock. Pending reservations count against
-- every subsequent month until reconciled. Settled charges count in the settlement month.
-- The legacy message spend is counted too; this is intentionally conservative (may double
-- count after integration) until a reviewed accounting cutover establishes a single ledger.
create or replace function public.ws_budget_reserve(
  p_request uuid, p_thread uuid, p_micros bigint, p_month_cap bigint, p_thread_cap bigint
) returns table(decision text)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
declare
  v_now timestamptz;
  v_month timestamptz;
  v_month_used numeric;
  v_thread_used numeric;
begin
  if p_request is null or p_thread is null or p_micros is null or p_micros <= 0
    or p_month_cap is null or p_month_cap < 0 or p_thread_cap is null or p_thread_cap < 0 then
    return query select 'invalid'::text; return;
  end if;
  -- READ COMMITTED is required: later statements must see a previous lock holder's commit.
  if current_setting('transaction_isolation') <> 'read committed' then
    return query select 'isolation_unsupported'::text; return;
  end if;
  perform 1 from public.ws_budget_gate where id = 1 for update;
  if not found then return query select 'ledger_unavailable'::text; return; end if;
  -- Never regrant permission for a request whose response was lost.
  if exists(select 1 from public.ws_budget_reservations where request_id = p_request) then
    return query select 'duplicate'::text; return;
  end if;
  if not exists(select 1 from public.ws_threads where id = p_thread) then
    return query select 'unknown_thread'::text; return;
  end if;
  if not exists(select 1 from public.ws_control where id = 1 and stopped is false) then
    return query select 'stopped'::text; return;
  end if;
  -- An observed over-ceiling charge is a safety incident: deny new reservations.
  if exists(select 1 from public.ws_budget_reservations where actual_micros > reserved_micros) then
    return query select 'ceiling_violation'::text; return;
  end if;
  v_now := clock_timestamp();
  v_month := date_trunc('month', v_now at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(case when settled_at is null then reserved_micros
                      when settled_at >= v_month then actual_micros else 0 end),0),
         coalesce(sum(case when thread_id = p_thread then coalesce(actual_micros,reserved_micros) else 0 end),0)
    into v_month_used,v_thread_used from public.ws_budget_reservations;
  select v_month_used + coalesce(sum(cost_usd) filter(where created_at >= v_month),0)*1000000,
         v_thread_used + coalesce(sum(cost_usd) filter(where thread_id = p_thread),0)*1000000
    into v_month_used,v_thread_used from public.ws_messages;
  if v_month_used + p_micros > p_month_cap then
    return query select 'monthly_cap'::text; return;
  end if;
  if v_thread_used + p_micros > p_thread_cap then
    return query select 'thread_cap'::text; return;
  end if;
  insert into public.ws_budget_reservations(request_id,thread_id,reserved_micros,admitted_at)
    values(p_request,p_thread,p_micros,v_now);
  return query select 'reserved'::text;
end $$;

-- Only settle with authenticated, verified final usage. No timeout-based release.
-- A repeated identical receipt is idempotent; a conflicting receipt never overwrites.
-- Record an over-ceiling charge in full, so the next admission fails closed.
create or replace function public.ws_budget_settle(
  p_request uuid, p_thread uuid, p_actual bigint
) returns table(decision text)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
declare
  v_row public.ws_budget_reservations%rowtype;
begin
  if p_request is null or p_thread is null or p_actual is null or p_actual < 0 then
    return query select 'invalid'::text; return;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    return query select 'isolation_unsupported'::text; return;
  end if;
  perform 1 from public.ws_budget_gate where id = 1 for update;
  if not found then return query select 'ledger_unavailable'::text; return; end if;
  select * into v_row from public.ws_budget_reservations where request_id = p_request and thread_id = p_thread;
  if not found then return query select 'unknown_request'::text; return; end if;
  if v_row.settled_at is not null then
    return query select case when v_row.actual_micros = p_actual then 'already_settled' else 'receipt_conflict' end::text;
    return;
  end if;
  update public.ws_budget_reservations set actual_micros = p_actual, settled_at = clock_timestamp()
    where request_id = p_request;
  return query select case when p_actual > v_row.reserved_micros then 'ceiling_violation' else 'settled' end::text;
end $$;

revoke all on function public.ws_budget_reserve(uuid,uuid,bigint,bigint,bigint) from public, anon, authenticated;
revoke all on function public.ws_budget_settle(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.ws_budget_reserve(uuid,uuid,bigint,bigint,bigint) to service_role;
grant execute on function public.ws_budget_settle(uuid,uuid,bigint) to service_role;
commit;
