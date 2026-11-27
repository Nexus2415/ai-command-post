-- ARN-137 disposable PostgreSQL proof; rollback all test transitions.
begin;
do $$
declare r text; g bigint; m text;
begin
  select mode,generation into m,g from emergency_control.read_state();
  if m is distinct from 'BLACKOUT' or g is distinct from 1::bigint then raise exception 'initial latch not contained'; end if;
  if has_function_privilege('emergency_reader','emergency_control.contain(text,text)','EXECUTE')
     or has_function_privilege('emergency_reader','emergency_control.recover(bigint,text)','EXECUTE')
     or has_function_privilege('emergency_containment','emergency_control.recover(bigint,text)','EXECUTE')
     or has_table_privilege('emergency_owner','emergency_control.latch','UPDATE')
     or has_table_privilege('emergency_containment','emergency_control.events','DELETE') then
    raise exception 'role separation violated';
  end if;
  if not has_function_privilege('emergency_owner','emergency_control.recover(bigint,text)','EXECUTE') then raise exception 'owner recovery missing'; end if;
  select decision,generation into r,g from emergency_control.recover(1,'synthetic owner recovery');
  if r is distinct from 'recovered' or g is distinct from 2::bigint then raise exception 'recovery: %, %',r,g; end if;
  select decision,generation into r,g from emergency_control.contain('AEGIS','synthetic');
  if r is distinct from 'contained' or g is distinct from 3::bigint then raise exception 'AEGIS: %, %',r,g; end if;
  select decision,generation into r,g from emergency_control.contain('BLACKOUT','synthetic');
  if r is distinct from 'contained' or g is distinct from 4::bigint then raise exception 'BLACKOUT: %, %',r,g; end if;
  select decision,generation into r,g from emergency_control.contain('AEGIS','repeat synthetic');
  if r is distinct from 'contained' or g is distinct from 5::bigint then raise exception 'repeat generation: %, %',r,g; end if;
  select mode into m from emergency_control.read_state();
  if m is distinct from 'BLACKOUT' then raise exception 'BLACKOUT downgrade'; end if;
  select decision into r from emergency_control.recover(4,'stale decision');
  if r is distinct from 'stale' then raise exception 'stale recovery: %',r; end if;
  select decision into r from emergency_control.recover(5,'  ');
  if r is distinct from 'invalid' then raise exception 'missing recovery evidence'; end if;
  select decision,generation into r,g from emergency_control.recover(5,'synthetic verified recovery reference');
  if r is distinct from 'recovered' or g is distinct from 6::bigint then raise exception 'owner recovery: %, %',r,g; end if;
  if (select count(*) from emergency_control.events)<>5 then raise exception 'missing transition evidence'; end if;
  delete from emergency_control.latch;
  select decision into r from emergency_control.contain('BLACKOUT','missing latch');
  if r is distinct from 'unavailable' then raise exception 'missing latch not refused'; end if;
  raise notice 'ARN-137 native latch and role assertions passed';
end $$;
rollback;
