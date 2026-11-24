-- Disposable PostgreSQL only. Run after db/workspace.sql and db/workspace-budget.sql.
-- All synthetic fixtures roll back. The test never touches provider APIs.
begin;
do $$
declare
  p uuid := gen_random_uuid();
  t uuid := gen_random_uuid();
  t2 uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  d uuid := gen_random_uuid();
  r text;
begin
  insert into public.ws_projects(id,name) values(p,'synthetic');
  insert into public.ws_threads(id,project_id,title,model) values(t,p,'A','chatgpt'),(t2,p,'B','chatgpt');
  update public.ws_control set stopped=false where id=1;
  select decision into r from public.ws_budget_reserve(a,t,60,100,100);
  if r <> 'reserved' then raise exception 'initial: %',r; end if;
  select decision into r from public.ws_budget_reserve(a,t,60,100,100);
  if r <> 'duplicate' then raise exception 'replay: %',r; end if;
  select decision into r from public.ws_budget_reserve(b,t2,41,100,100);
  if r <> 'monthly_cap' then raise exception 'outstanding cross-thread: %',r; end if;
  select decision into r from public.ws_budget_reserve(b,t,41,1000,100);
  if r <> 'thread_cap' then raise exception 'outstanding thread: %',r; end if;
  select decision into r from public.ws_budget_settle(a,t2,20);
  if r <> 'unknown_request' then raise exception 'wrong thread: %',r; end if;
  select decision into r from public.ws_budget_settle(a,t,20);
  if r <> 'settled' then raise exception 'settle: %',r; end if;
  select decision into r from public.ws_budget_settle(a,t,20);
  if r <> 'already_settled' then raise exception 'settle replay: %',r; end if;
  select decision into r from public.ws_budget_settle(a,t,0);
  if r <> 'receipt_conflict' then raise exception 'conflicting receipt: %',r; end if;
  select decision into r from public.ws_budget_reserve(b,t2,80,100,100);
  if r <> 'reserved' then raise exception 'released capacity: %',r; end if;
  update public.ws_budget_reservations set admitted_at=clock_timestamp()-interval '2 months' where request_id=b;
  select decision into r from public.ws_budget_reserve(c,t,1,100,100);
  if r <> 'monthly_cap' then raise exception 'prior-month unresolved hold: %',r; end if;
  update public.ws_control set stopped=true where id=1;
  select decision into r from public.ws_budget_reserve(c,t,1,1000,1000);
  if r <> 'stopped' then raise exception 'stop: %',r; end if;
  update public.ws_control set stopped=false where id=1;
  select decision into r from public.ws_budget_reserve(c,t,0,1000,1000);
  if r <> 'invalid' then raise exception 'zero reserve: %',r; end if;
  select decision into r from public.ws_budget_settle(b,t2,81);
  if r <> 'ceiling_violation' then raise exception 'overage: %',r; end if;
  select decision into r from public.ws_budget_reserve(d,t,1,1000,1000);
  if r <> 'ceiling_violation' then raise exception 'overage latch: %',r; end if;
  if not exists(select 1 from public.ws_budget_reservations where request_id=b and actual_micros=81) then
    raise exception 'overage lost';
  end if;
  raise notice 'ARN-136 sequential contract assertions passed';
end $$;
rollback;
