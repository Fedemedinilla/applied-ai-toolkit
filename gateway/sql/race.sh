#!/usr/bin/env bash
# Opt-in check that reserve_usage orders concurrent reservations across connections, which the
# PGlite suites (one connection) cannot show. It creates a scratch database, applies schema.sql,
# fires CALLS reserve_usage statements at once from separate psql processes, and drops the
# database. With the advisory lock each call sees every reservation committed before it, so the
# open bounds returned are 0, 1 x, 2 x ... (CALLS - 1) x one reservation, all distinct. Without
# the lock, calls that start together read the same totals and the values repeat.
#
# Connection through the libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD), with a role that
# can create databases. From the repository root:
#
#   PGHOST=localhost PGUSER=postgres bash gateway/sql/race.sh [calls] [rounds]
#
# Exits non-zero on the first round whose totals repeat.
set -euo pipefail

calls="${1:-20}"
rounds="${2:-3}"
here="$(cd "$(dirname "$0")" && pwd)"
db="gateway_race_$$"

psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database $db" >/dev/null
trap 'psql -X -q -d postgres -c "drop database if exists $db" >/dev/null' EXIT

psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/schema.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null <<'SQL'
insert into public.model_prices (model, valid_from, input, output, cache_read, cache_write_5m, cache_write_1h, source)
  values ('claude-sonnet-5-5', '2026-01-01T00:00:00Z', 2, 10, 0.2, 2.5, 4, 'race fixture');
insert into public.llm_task_config (task, model, effort) values ('triage', 'claude-sonnet-5-5', 'medium');
SQL

# One reservation: 1000 estimated input at 2 and 2000 output at 10 per million = US$0.022.
expected="$(seq 0 $((calls - 1)) | awk '{ printf "%.6f\n", $1 * 0.022 }')"
out="$(mktemp -d)"
trap 'rm -rf "$out"; psql -X -q -d postgres -c "drop database if exists $db" >/dev/null' EXIT

for round in $(seq 1 "$rounds"); do
  user="00000000-0000-4000-8000-$(printf '%012d' "$round")"
  for i in $(seq 1 "$calls"); do
    psql -X -At -v ON_ERROR_STOP=1 -d "$db" -c "select round(user_day_bound_usd, 6) from public.reserve_usage(
      gen_random_uuid(), '$user', 'triage', null, 'medium', 'triage@1', 'claude-sonnet-5-5', 2000, 1000,
      now() - interval '1 hour', now() - interval '1 day')" >"$out/$i" &
  done
  wait
  got="$(cat "$out"/* | sort -n)"
  if [ "$got" != "$expected" ]; then
    echo "race.sh: round $round, totals repeat or are missing:" >&2
    echo "$got" | uniq -c | awk '$1 > 1 { print "  " $2 " x" $1 }' >&2
    exit 1
  fi
  echo "race.sh: round $round, $calls parallel reservations, all totals distinct"
done
