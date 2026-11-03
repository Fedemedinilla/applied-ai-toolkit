-- Assertions for schema.sql. The cap totals cases are those of test/memory-store.test.ts, so the
-- SQL function and the in-memory store cannot drift apart unnoticed; the constraint cases cover
-- the rules a gateway row could break. Everything runs in one transaction that is rolled back, so
-- the target database is left as it was. From the repository root:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f gateway/sql/test.sql
--
-- Any failed assertion raises and psql exits non-zero.

\set QUIET on
\set VERBOSITY terse
-- Query results are not needed; assertions report through notices and errors.
\o /dev/null
begin;
\ir schema.sql

create function pg_temp.check_eq(actual anyelement, expected anyelement, label text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAILED: % (expected %, got %)', label, expected, actual;
  end if;
  raise notice 'ok: %', label;
end;
$$;

-- Fails unless the statement raises check_violation (or the given SQLSTATE) naming the constraint.
create function pg_temp.check_rejects(statement text, constraint_name text, state text default '23514') returns void
language plpgsql as $$
declare
  rejected boolean := false;
begin
  begin
    execute statement;
  exception
    when others then
      if sqlstate <> state or position(constraint_name in sqlerrm) = 0 then
        raise exception 'FAILED: expected % (%), got % (%)', constraint_name, state, sqlerrm, sqlstate;
      end if;
      rejected := true;
  end;
  -- Outside the handler, so this failure is not caught by it.
  if not rejected then
    raise exception 'FAILED: expected % to reject: %', constraint_name, statement;
  end if;
  raise notice 'ok: rejects %', constraint_name;
end;
$$;

-- Fixture prices, the same as test/helpers/fake-stores.ts.
insert into public.model_prices (model, valid_from, input, output, cache_read, cache_write_5m, cache_write_1h, source) values
  ('claude-fable-5-1', '2026-01-01', 10, 50, 0.25, 12.5, 20, 'test fixture'),
  ('claude-sonnet-5-5', '2026-01-01', 2, 10, 0.2, 2.5, 4, 'test fixture'),
  ('claude-opus-5-5', '2026-01-01', 4, 20, 0.2, 5, 8, 'test fixture');

-- Fixture ids.
\set user_a '''00000000-0000-4000-8000-000000000001'''
\set user_b '''00000000-0000-4000-8000-000000000002'''
\set job '''00000000-0000-4000-8000-0000000000a1'''

create temp view t as
  select * from public.usage_for_caps(now() - interval '1 hour', now() - interval '1 day', :user_a, :job);

-- A minimal finished row; columns not listed take their defaults.
create function pg_temp.add_row(p_user uuid, p_cost numeric, p_job uuid default null) returns uuid
language sql as $$
  insert into public.llm_usage (id, user_id, task, job_id, prompt_version, model_requested, model_responded, cost_usd, max_tokens, stop_reason)
  values (gen_random_uuid(), p_user, 'triage', p_job, 'triage@1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', p_cost, 1000, 'end_turn')
  returning id;
$$;

-- A reservation as the gateway writes it: nothing measured, 1000 estimated input, 2000 max_tokens.
create function pg_temp.add_reservation(p_user uuid) returns uuid
language sql as $$
  insert into public.llm_usage (id, reservation, user_id, task, prompt_version, model_requested, incomplete, estimated_input_tokens, max_tokens)
  values (gen_random_uuid(), true, p_user, 'triage', 'triage@1', 'claude-sonnet-5-5', true, 1000, 2000)
  returning id;
$$;

-- 1. Costs per window, nulls for windows not requested.
select pg_temp.add_row(:user_a, 1.5);
select pg_temp.add_row(:user_a, 2, :job);
select pg_temp.add_row(:user_b, 4);
select pg_temp.check_eq((select user_day_usd from t), 3.5::numeric, 'user day cost');
select pg_temp.check_eq((select month_usd from t), 7.5::numeric, 'month cost');
select pg_temp.check_eq((select job_usd from t), 2::numeric, 'job cost');
select pg_temp.check_eq((select user_day_bound_usd from t), 0::numeric, 'no bound without unpriced rows');
select pg_temp.check_eq(
  (select user_day_usd from public.usage_for_caps(now() - interval '1 hour', now() - interval '1 day')), null::numeric,
  'user day is null without a user');
select pg_temp.check_eq(
  (select job_bound_usd from public.usage_for_caps(now() - interval '1 hour', now() - interval '1 day', :user_a)), null::numeric,
  'job is null without a job');
delete from public.llm_usage;

-- 2. An open reservation counts in the bound at the highest price, not as an unpriced call.
--    Fable fixture: 1000 x 10 + 2000 x 50 = 110,000 per million.
select pg_temp.add_reservation(:user_a);
select pg_temp.check_eq((select user_day_bound_usd from t), 0.11::numeric, 'open reservation bound');
select pg_temp.check_eq((select user_day_unpriced from t), 0, 'open reservation is not an unpriced call');

-- 3. A closed reservation does not count.
insert into public.llm_usage (id, replaces, user_id, task, prompt_version, model_requested, model_responded, cost_usd, max_tokens)
  select gen_random_uuid(), id, user_id, 'triage', 'triage@1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 0.25, 2000
  from public.llm_usage where reservation;
select pg_temp.check_eq((select user_day_usd from t), 0.25::numeric, 'closing row cost');
select pg_temp.check_eq((select user_day_bound_usd from t), 0::numeric, 'closed reservation has no bound');
delete from public.llm_usage where not reservation;
delete from public.llm_usage;

-- 3b. p_exclude_id leaves one row out: the gateway's second check skips its own reservation.
create temp table own as select pg_temp.add_reservation(:user_a) as id;
select pg_temp.add_reservation(:user_a);
select pg_temp.check_eq(
  (select user_day_bound_usd from public.usage_for_caps(now() - interval '1 hour', now() - interval '1 day', :user_a, :job, (select id from own))),
  0.11::numeric, 'excluded reservation');
select pg_temp.check_eq((select user_day_bound_usd from t), 0.22::numeric, 'both reservations without the exclusion');
delete from public.llm_usage;

-- 3c. Rows before the day window do not count for the day; job rows count whatever their date.
insert into public.llm_usage (id, user_id, task, job_id, prompt_version, model_requested, model_responded, cost_usd, max_tokens, created_at)
  values (gen_random_uuid(), :user_a, 'triage', :job, 'triage@1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 3, 1000, now() - interval '3 hours');
select pg_temp.check_eq((select user_day_usd from t), 0::numeric, 'earlier row outside the day');
select pg_temp.check_eq((select month_usd from t), 3::numeric, 'earlier row inside the month');
select pg_temp.check_eq(
  (select job_usd from public.usage_for_caps(now() - interval '1 hour', now() - interval '1 hour', :user_a, :job)), 3::numeric,
  'job row outside both windows still counts for the job');
delete from public.llm_usage;

-- 3d. The adapter's insert: the same id twice leaves one row, so a retried insert does not double the cost.
create temp table dup as select gen_random_uuid() as id;
insert into public.llm_usage (id, user_id, task, prompt_version, model_requested, model_responded, cost_usd, max_tokens)
  select id, :user_a, 'triage', 'triage@1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 1, 1000 from dup
  on conflict (id) do nothing;
insert into public.llm_usage (id, user_id, task, prompt_version, model_requested, model_responded, cost_usd, max_tokens)
  select id, :user_a, 'triage', 'triage@1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 1, 1000 from dup
  on conflict (id) do nothing;
select pg_temp.check_eq((select count(*) from public.llm_usage), 1::bigint, 'retried insert stores one row');
select pg_temp.check_eq((select user_day_usd from t), 1::numeric, 'retried insert counts once');
delete from public.llm_usage;

-- 4. An incomplete row is valued at the price of the model that was answering.
--    Sonnet fixture: 2000 x 2 + 1 x 10 + 16,000 x 10 = 164,010 per million.
insert into public.llm_usage (id, user_id, task, prompt_version, model_requested, model_responded, input_tokens, output_tokens, max_tokens, incomplete, error_code)
  values (gen_random_uuid(), :user_a, 'triage', 'triage@1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 2000, 1, 16000, true, 'timeout');
select pg_temp.check_eq((select user_day_bound_usd from t), 0.16401::numeric, 'incomplete row at its own model price');
select pg_temp.check_eq((select user_day_unpriced from t), 1, 'incomplete row is an unpriced call');
delete from public.llm_usage;

-- 5. Cache reads of an unpriced model: floored at 0.1x the highest input price (0.1 x 10 = 1 per million).
insert into public.llm_usage (id, user_id, task, prompt_version, model_requested, model_responded, cache_read_tokens, max_tokens)
  values (gen_random_uuid(), :user_a, 'triage', 'triage@1', 'claude-sonnet-5-5', 'claude-sonnet-5', 1000000, 1000);
select pg_temp.check_eq((select user_day_bound_usd from t), 1::numeric, 'cache read floor');

-- 6. With unpriced rows and no price in force, the bound is null, not zero.
delete from public.model_prices;
select pg_temp.check_eq((select user_day_bound_usd from t), null::numeric, 'null bound without prices');
select pg_temp.check_eq((select month_bound_usd from t), null::numeric, 'null month bound without prices');
delete from public.llm_usage;

-- 7. Constraints, with the names src/memory-store.ts uses.
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, reservation, task, prompt_version, model_requested, incomplete, input_tokens, max_tokens)
  values (gen_random_uuid(), true, 'triage', 'v1', 'claude-sonnet-5-5', true, 5, 10) $q$, 'llm_usage_reservation_unmeasured');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, model_responded, cost_usd, max_tokens, incomplete)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 1, 10, true) $q$, 'llm_usage_incomplete_without_cost');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, model_responded, cost_usd, max_tokens, estimated_input_tokens)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 1, 10, 10) $q$, 'llm_usage_estimate_only_if_incomplete');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, input_tokens, cost_usd, max_tokens)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', 3, 0, 10) $q$, 'llm_usage_model_responded_if_consumed');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, cost_usd, max_tokens, error_code)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', null, 10, 'overloaded') $q$, 'llm_usage_model_responded_if_consumed');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, model_responded, output_tokens, max_tokens)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', -1, 10) $q$, 'llm_usage_tokens_nonnegative');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, replaces, task, prompt_version, model_requested, model_responded, max_tokens)
  values (gen_random_uuid(), '00000000-0000-4000-8000-00000000dead', 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 10) $q$,
  'llm_usage_replaces_fkey', '23503');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, model_responded, max_tokens)
  values (gen_random_uuid(), ' ', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 10) $q$, 'llm_usage_task_not_blank');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, model_responded, max_tokens, duration_ms)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 10, -1) $q$, 'llm_usage_duration_nonnegative');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, model_responded, max_tokens, attempts)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 10, '{}') $q$, 'llm_usage_attempts_is_array');
select pg_temp.check_rejects($q$
  insert into public.llm_usage (id, task, prompt_version, model_requested, model_responded, max_tokens, error_code)
  values (gen_random_uuid(), 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 10, ' ') $q$, 'llm_usage_error_code_not_blank');

-- One closing row per reservation; an unbilled error row without a model is accepted.
create temp table r as select pg_temp.add_reservation(:user_a) as id;
insert into public.llm_usage (id, replaces, task, prompt_version, model_requested, cost_usd, max_tokens, error_code)
  select gen_random_uuid(), id, 'triage', 'v1', 'claude-sonnet-5-5', 0, 2000, 'overloaded' from r;
select pg_temp.check_rejects(format($q$
  insert into public.llm_usage (id, replaces, task, prompt_version, model_requested, model_responded, max_tokens)
  values (gen_random_uuid(), %L, 'triage', 'v1', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 10) $q$, (select id from r)),
  'llm_usage_replaces_key', '23505');

-- 8. A task cannot use a model without a price in force (prices were deleted in case 6).
select pg_temp.check_rejects($q$
  insert into public.llm_task_config (task, model, effort) values ('triage', 'claude-sonnet-5-5', 'medium') $q$,
  'no price in force', '23503');

-- 9. A null window is refused instead of summing zero.
select pg_temp.check_rejects($q$ select * from public.usage_for_caps(null, now()) $q$, 'p_day_start and p_month_start are required', '22004');

\o
\echo 'sql/test.sql: all assertions passed'
rollback;
