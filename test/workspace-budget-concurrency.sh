#!/usr/bin/env bash
set -euo pipefail
# Never accept a remote DSN or non-CI database.
[[ "${GITHUB_ACTIONS:-}" == true && "${PGHOST:-}" == 127.0.0.1 && "${PGDATABASE:-}" == workspace_budget_test ]]
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
export PGCONNECT_TIMEOUT=5
sql() { psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d workspace_budget_test "$@"; }
sql -c "insert into ws_projects(id,name) values('00000000-0000-4000-8000-000000000001','synthetic'); insert into ws_threads(id,project_id,title,model) values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','A','chatgpt'),('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','B','chatgpt');"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
# Distinct sessions compete for 100 micros. Each requests 60.
sql -c "begin; select decision from ws_budget_reserve('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002',60,100,100); select pg_sleep(1); commit;" > "$dir/a" &
a=$!
sql -c "select decision from ws_budget_reserve('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003',60,100,100)" > "$dir/b" &
b=$!
wait "$a"; wait "$b"
[[ $(grep -hxc reserved "$dir/a" "$dir/b" | awk '{s+=$1} END{print s}') == 1 ]]
[[ $(grep -hxc monthly_cap "$dir/a" "$dir/b" | awk '{s+=$1} END{print s}') == 1 ]]
[[ $(sql -c 'select count(*) from ws_budget_reservations') == 1 ]]
[[ $(sql -c 'select sum(reserved_micros) from ws_budget_reservations') == 60 ]]
# Concurrent reuse of the same ID cannot admit a second execution.
sql -c "select decision from ws_budget_reserve('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000002',10,100,100)" > "$dir/c" &
c=$!
sql -c "select decision from ws_budget_reserve('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000002',10,100,100)" > "$dir/d" &
d=$!
wait "$c"; wait "$d"
[[ $(grep -hxc reserved "$dir/c" "$dir/d" | awk '{s+=$1} END{print s}') == 1 ]]
[[ $(grep -hxc duplicate "$dir/c" "$dir/d" | awk '{s+=$1} END{print s}') == 1 ]]
[[ $(sql -c 'select sum(reserved_micros) from ws_budget_reservations') == 70 ]]
# No direct ledger writes or public RPC access.
[[ $(sql -c "select has_table_privilege('service_role','ws_budget_reservations','INSERT')") == f ]]
[[ $(sql -c "select has_function_privilege('anon','ws_budget_reserve(uuid,uuid,bigint,bigint,bigint)','EXECUTE')") == f ]]
[[ $(sql -c "select has_function_privilege('service_role','ws_budget_reserve(uuid,uuid,bigint,bigint,bigint)','EXECUTE')") == t ]]
echo 'ARN-136 concurrent cap, duplicate identity and privilege assertions passed'
