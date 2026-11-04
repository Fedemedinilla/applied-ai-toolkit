#!/usr/bin/env bash
# Opt-in check of the races on a real Postgres, with two sessions that overlap. The test suite runs
# the same functions in PGlite, which has one backend: calls there never overlap, so lock waits and
# the unique-index wait cannot happen. This script makes them happen by holding a transaction open
# with pg_sleep while a second session runs.
#
# Needs psql and DATABASE_URL pointing at an EMPTY scratch database (it refuses any other). It
# applies schema.sql, runs four races and prints one line per check.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to an empty scratch database}"
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

q() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -At "$@"; }

tables=$(q -c "select count(*) from pg_tables where schemaname = 'public'")
if [ "$tables" != 0 ]; then
  echo "refusing: the public schema of this database is not empty" >&2
  exit 1
fi
q -f "$here/schema.sql" > /dev/null
q -c "insert into products (name, price_cents) values ('Widget A', 450), ('Widget B', 2200);
      insert into stock values (1, 10), (2, 3);"

failures=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: expected $2, got $3"; failures=$((failures + 1)); fi
}
# Runs SQL in a session that keeps its transaction open for 1.5 s after it, in the background.
hold() { q -c "begin; $1; select pg_sleep(1.5); commit;" > "$tmp/$2" & }
# Milliseconds from the server clock, so the script needs no GNU date.
ms() { q -c "select floor(extract(epoch from clock_timestamp()) * 1000)::bigint"; }
# Places an order and prints its id. Ids come from the answer: the insert that lost race 1 used up
# an identity value, as a failed insert always does.
placed_id() { q -c "select place_order('$1', '$2', '$3')->'order'->>'id'"; }

lines='[{"product_id": 1, "quantity": 2}, {"product_id": 2, "quantity": 1}]'

# 1. Same key at once. B's lookup misses A's uncommitted order, B's insert waits on the unique
#    index, A commits, B gets a unique_violation and answers with A's order.
hold "select place_order('race-key-0000000001', 'shop-1', '$lines')->>'outcome'" a1
sleep 0.4
t0=$(ms)
b1=$(q -c "select place_order('race-key-0000000001', 'shop-1', '$lines')->>'outcome'")
waited=$(( $(ms) - t0 ))
wait
check "same key at once: first session" placed "$(head -n1 "$tmp/a1")"
check "same key at once: second session" already_placed "$b1"
check "same key at once: second session waited for the first" yes "$([ "$waited" -ge 700 ] && echo yes || echo "no (${waited} ms)")"
check "same key at once: orders" 1 "$(q -c 'select count(*) from orders')"

# 2. Two confirms of one order at once. B waits on the row lock and then sees it confirmed.
first=$(q -c "select id from orders where idempotency_key = 'race-key-0000000001'")
hold "select confirm_order($first, 1, 'confirm-key-0000000a')->>'outcome'" a2
sleep 0.4
b2=$(q -c "select confirm_order($first, 1, 'confirm-key-0000000b')->>'outcome'")
wait
check "two confirms: first session" confirmed "$(head -n1 "$tmp/a2")"
check "two confirms: second session" not_pending "$b2"
check "two confirms: product 1 stock taken once" 8 "$(q -c 'select on_hand from stock where product_id = 1')"

# 3. An edit and a confirm of one order at once. The confirm waits for the edit and then refuses the
#    version it was given.
edited=$(placed_id race-key-0000000002 shop-1 '[{"product_id": 1, "quantity": 1}]')
hold "select edit_order($edited, 1, '[{\"product_id\": 1, \"quantity\": 3}]')->>'outcome'" a3
sleep 0.4
b3=$(q -c "select confirm_order($edited, 1, 'confirm-key-0000000c')->>'outcome'")
wait
check "edit and confirm: edit" edited "$(head -n1 "$tmp/a3")"
check "edit and confirm: confirm" version_conflict "$b3"

# 4. Two confirms over the same two products at once, with enough of product 2 for only one of them.
x=$(placed_id race-key-0000000003 shop-1 '[{"product_id": 2, "quantity": 2}, {"product_id": 1, "quantity": 1}]')
y=$(placed_id race-key-0000000004 shop-2 '[{"product_id": 1, "quantity": 1}, {"product_id": 2, "quantity": 2}]')
hold "select confirm_order($x, 1, 'confirm-key-0000000d')->>'outcome'" a4
sleep 0.4
b4=$(q -c "select confirm_order($y, 1, 'confirm-key-0000000e')->>'outcome'")
wait
check "shared products: first confirm" confirmed "$(head -n1 "$tmp/a4")"
check "shared products: second confirm" insufficient_stock "$b4"
check "shared products: product 2 stock" 0 "$(q -c 'select on_hand from stock where product_id = 2')"

[ "$failures" = 0 ] && echo "all checks passed" || { echo "$failures check(s) failed"; exit 1; }
