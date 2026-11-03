-- Reference Postgres schema for the gateway's stores. Checked with sql/test.sql on PostgreSQL 16.
--
-- It is the persistent counterpart of src/memory-store.ts: the same ledger rules and the same cap
-- totals. A production adapter maps UsageRow (camelCase) to llm_usage (snake_case) one to one,
-- calls usage_for_caps for UsageStore.totalsForCaps (UsageWindows.excludeId is p_exclude_id), and
-- reads the three config tables.
--
-- UsageStore.record must insert with `insert into public.llm_usage (...) values (...) on conflict
-- (id) do nothing`. The gateway retries a failed insert once with the same id. When the first
-- insert went through and only its response was lost, a plain insert would fail the retry with a
-- unique violation on the primary key, and the gateway would report a reservation or a closing row
-- as not written when it was. The conflict target is the id only, so a second closing row for the
-- same reservation (a different id) still fails on llm_usage_replaces_key.
--
-- Rules the schema enforces:
-- - llm_usage is append-only. Grant the application role select and insert, never update or
--   delete. Closing a reservation is inserting a second row that names it in `replaces`.
-- - A price change is a new model_prices row with a later valid_from; old costs stay as recorded.
-- - A task can only use a model that has a price in force (trigger on llm_task_config).

create type public.llm_effort as enum ('low', 'medium', 'high', 'xhigh', 'max');

-- ---------------------------------------------------------------------------
-- Prices
-- ---------------------------------------------------------------------------

create table public.model_prices (
  model text not null
    constraint model_prices_model_format check (model ~ '^claude-[a-z0-9.-]+$'),
  valid_from timestamptz not null,
  -- US$ per million tokens. Four decimals, so the gateway can sum in integers.
  input numeric(10, 4) not null constraint model_prices_input_nonnegative check (input >= 0),
  output numeric(10, 4) not null constraint model_prices_output_nonnegative check (output >= 0),
  cache_read numeric(10, 4) not null constraint model_prices_cache_read_nonnegative check (cache_read >= 0),
  cache_write_5m numeric(10, 4) not null constraint model_prices_cache_write_5m_nonnegative check (cache_write_5m >= 0),
  cache_write_1h numeric(10, 4) not null constraint model_prices_cache_write_1h_nonnegative check (cache_write_1h >= 0),
  source text not null constraint model_prices_source_not_blank check (btrim(source) <> ''),
  created_at timestamptz not null default now(),
  primary key (model, valid_from)
);

comment on table public.model_prices is
  'US$ per million tokens per model. The row with the latest valid_from not after the call applies. Rows are never edited: a new price is a new row.';
comment on column public.model_prices.source is 'Where the price came from and when it was checked.';

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

-- One row (id = true). Typed columns rather than key/value jsonb, so the database rejects a
-- negative cap and the cap function reads values without casting text.
create table public.llm_global_caps (
  id boolean primary key default true constraint llm_global_caps_single_row check (id),
  per_job_usd numeric(10, 2) not null constraint llm_global_caps_per_job_positive check (per_job_usd > 0),
  daily_per_user_usd numeric(10, 2) not null constraint llm_global_caps_daily_positive check (daily_per_user_usd > 0),
  monthly_usd numeric(10, 2) not null constraint llm_global_caps_monthly_positive check (monthly_usd > 0),
  updated_at timestamptz not null default now()
);

comment on column public.llm_global_caps.monthly_usd is
  'Spend per month across all calls, eval runs included. Keep it below the spend limit of the provider account.';

create table public.llm_task_config (
  task text primary key constraint llm_task_config_task_not_blank check (btrim(task) <> ''),
  model text not null constraint llm_task_config_model_format check (model ~ '^claude-[a-z0-9.-]+$'),
  effort public.llm_effort not null,
  hard_case_effort public.llm_effort,
  updated_at timestamptz not null default now()
);

comment on table public.llm_task_config is
  'Model and effort per task. Effort stays fixed per task because changing it invalidates the prompt cache.';

-- A task whose model has no price would leave every call of that task without a cost, and the caps
-- could only count them at an upper bound. The database refuses the assignment instead. Fallback
-- models are chosen by the API, not by this table, and are not checked here.
create function public.require_current_price()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.model_prices as p where p.model = new.model and p.valid_from <= pg_catalog.now()
  ) then
    raise exception 'Model % has no price in force in public.model_prices.', new.model
      using errcode = 'foreign_key_violation',
            hint = 'Load its checked price into public.model_prices before assigning it to a task.';
  end if;
  return new;
end;
$$;

create trigger llm_task_config_require_price
  before insert or update of model on public.llm_task_config
  for each row execute function public.require_current_price();

-- An account's own caps. Null: the global cap applies. The gateway takes the lower of the two, so
-- an account can lower a cap but never raise it. A user without a row is rejected (fail closed).
create table public.llm_account_caps (
  user_id uuid primary key,
  per_job_usd numeric(10, 2) constraint llm_account_caps_per_job_positive check (per_job_usd > 0),
  daily_per_user_usd numeric(10, 2) constraint llm_account_caps_daily_positive check (daily_per_user_usd > 0)
);

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create table public.llm_usage (
  -- Generated by the gateway before inserting: retrying the insert with the same id cannot double the cost.
  id uuid primary key,
  -- Written before calling, at the call's worst case. No row, no call.
  reservation boolean not null default false,
  -- The reservation this row closes. Each reservation is closed by one row at most (unique index below).
  replaces uuid constraint llm_usage_replaces_fkey references public.llm_usage (id),
  -- Reference your users table here, with on delete set null so deleting a user keeps the spend.
  user_id uuid,
  task text not null constraint llm_usage_task_not_blank check (btrim(task) <> ''),
  job_id uuid,
  effort public.llm_effort,
  prompt_version text not null constraint llm_usage_prompt_version_not_blank check (btrim(prompt_version) <> ''),
  model_requested text not null constraint llm_usage_model_requested_not_blank check (btrim(model_requested) <> ''),
  -- response.model: another model after a server-side fallback. Null on a reservation, on a cut
  -- before message_start, and on an unbilled error.
  model_responded text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_5m_tokens integer not null default 0,
  cache_write_1h_tokens integer not null default 0,
  thinking_tokens integer constraint llm_usage_thinking_nonnegative check (thinking_tokens >= 0),
  -- Null when any model that answered has no price, or usage is incomplete. Never invented.
  cost_usd numeric(12, 6) constraint llm_usage_cost_nonnegative check (cost_usd >= 0),
  stop_reason text,
  refusal_category text,
  -- Per-attempt tokens when a fallback ran, so the cost can be recomputed once a missing price is loaded.
  attempts jsonb constraint llm_usage_attempts_is_array check (jsonb_typeof(attempts) = 'array'),
  request_id text,
  duration_ms integer constraint llm_usage_duration_nonnegative check (duration_ms >= 0),
  -- Bounds the output of one attempt: the worst case of an incomplete row.
  max_tokens integer not null constraint llm_usage_max_tokens_positive check (max_tokens > 0),
  -- Cut before the API reported all usage. The caps value it at its worst case.
  incomplete boolean not null default false,
  -- Input bound for an incomplete row whose input was never measured.
  estimated_input_tokens integer constraint llm_usage_estimated_input_nonnegative check (estimated_input_tokens >= 0),
  error_code text constraint llm_usage_error_code_not_blank check (error_code is null or btrim(error_code) <> ''),
  -- The caps' windows use this time: the end of the call, or for a reservation, the moment before it.
  created_at timestamptz not null default now(),

  constraint llm_usage_tokens_nonnegative check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0 and cache_write_5m_tokens >= 0 and cache_write_1h_tokens >= 0
  ),
  -- A reservation has measured nothing, does not know which model answers, and closes nothing.
  constraint llm_usage_reservation_unmeasured check (
    not reservation
    or (incomplete and model_responded is null and duration_ms is null and replaces is null and error_code is null
      and input_tokens = 0 and output_tokens = 0 and cache_read_tokens = 0 and cache_write_5m_tokens = 0 and cache_write_1h_tokens = 0)
  ),
  constraint llm_usage_incomplete_without_cost check (not incomplete or cost_usd is null),
  constraint llm_usage_estimate_only_if_incomplete check (estimated_input_tokens is null or incomplete),
  -- Every finished row names the model that answered, except an unbilled error: code set, zero cost, zero tokens.
  -- `is not distinct from` because a plain `= 0` on a null cost would make the check pass.
  constraint llm_usage_model_responded_if_consumed check (
    incomplete
    or model_responded is not null
    or (error_code is not null and cost_usd is not distinct from 0
      and input_tokens = 0 and output_tokens = 0 and cache_read_tokens = 0 and cache_write_5m_tokens = 0 and cache_write_1h_tokens = 0)
  ),
  constraint llm_usage_replaces_other check (replaces <> id)
);

comment on table public.llm_usage is
  'Append-only ledger: one reservation per call written before calling, and one row that closes it with what happened.';

-- One closing row per reservation. Also the index usage_for_caps uses to skip closed reservations.
create unique index llm_usage_replaces_key on public.llm_usage (replaces) where replaces is not null;

-- Indexes for the cap sums: by user and time, by time, by job, and the rows without a cost.
create index llm_usage_user_created_at_idx on public.llm_usage (user_id, created_at) include (cost_usd, id, reservation);
create index llm_usage_created_at_idx on public.llm_usage (created_at) include (cost_usd, id, reservation);
create index llm_usage_job_id_idx on public.llm_usage (job_id) include (cost_usd, id, reservation) where job_id is not null;
create index llm_usage_unpriced_created_at_idx on public.llm_usage (created_at)
  include (id, user_id, job_id, model_responded, input_tokens, output_tokens, cache_read_tokens,
    cache_write_5m_tokens, cache_write_1h_tokens, incomplete, max_tokens, estimated_input_tokens)
  where cost_usd is null;

-- ---------------------------------------------------------------------------
-- Cap totals
-- ---------------------------------------------------------------------------

-- What the caps need, in one query. The caller passes the windows (start of day and month in its
-- configured time zone, from its own clock): the database only sums. For each window it returns
-- the measured cost, the number of calls that ended without a cost, and an upper bound for those
-- calls plus any open reservation. The gateway adds bound to cost before comparing with a cap.
--
-- p_exclude_id leaves one row out. The gateway passes its own reservation in the second cap check,
-- after reserving: it needs everything else in flight, not itself.
--
-- The bound of a row without a cost is its measured tokens and, if incomplete, the estimated input
-- at the input price plus max_tokens at the output price. The price is that of the model that was
-- answering when the row is incomplete and that model has a price in force; otherwise the highest
-- price in force for each token type (an open reservation does not know which model will answer).
-- Cache reads use at least 0.1x the highest input price, which covers a fallback model whose price
-- is not loaded but reads cache at 0.1x its input. The bound uses standard prices: a complete row
-- left without a cost because its usage reported another tariff (priority tier, fast speed, a
-- pinned region) is billed at a premium the bound does not include.
--
-- Without a user the user_day_* fields are null, and without a job the job_* fields are null. A
-- bound is also null when there are rows without a cost and no price is in force at all. Null and
-- not zero on purpose: a zero would let a call through without having summed anything.
create function public.usage_for_caps(
  p_day_start timestamptz,
  p_month_start timestamptz,
  p_user_id uuid default null,
  p_job_id uuid default null,
  p_exclude_id uuid default null
)
returns table (
  user_day_usd numeric,
  user_day_unpriced integer,
  user_day_bound_usd numeric,
  month_usd numeric,
  month_unpriced integer,
  month_bound_usd numeric,
  job_usd numeric,
  job_unpriced integer,
  job_bound_usd numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- A null window would sum zero and switch the cap off silently.
  if p_day_start is null or p_month_start is null then
    raise exception 'usage_for_caps: p_day_start and p_month_start are required'
      using errcode = 'null_value_not_allowed';
  end if;

  return query
  with in_force as (
    select distinct on (p.model) p.model, p.input, p.output, p.cache_read, p.cache_write_5m, p.cache_write_1h
    from public.model_prices as p
    where p.valid_from <= pg_catalog.now()
    order by p.model, p.valid_from desc
  ),
  highest as (
    select
      max(f.input) as input,
      max(f.output) as output,
      greatest(max(f.cache_read), 0.1 * max(f.input)) as cache_read,
      max(f.cache_write_5m) as cache_write_5m,
      max(f.cache_write_1h) as cache_write_1h
    from in_force as f
  ),
  -- Live rows: a reservation that another row closed does not count, so each call counts once.
  live as (
    select u.*
    from public.llm_usage as u
    where (u.created_at >= least(p_day_start, p_month_start) or u.job_id = p_job_id)
      and not exists (select 1 from public.llm_usage as r where r.replaces = u.id)
      and u.id is distinct from p_exclude_id
  ),
  bounds as (
    select
      l.id,
      (
        l.input_tokens * coalesce(f.input, h.input)
        + l.output_tokens * coalesce(f.output, h.output)
        + l.cache_read_tokens * coalesce(f.cache_read, h.cache_read)
        + l.cache_write_5m_tokens * coalesce(f.cache_write_5m, h.cache_write_5m)
        + l.cache_write_1h_tokens * coalesce(f.cache_write_1h, h.cache_write_1h)
        + case
            when l.incomplete
              then coalesce(l.estimated_input_tokens, 0) * coalesce(f.input, h.input) + l.max_tokens * coalesce(f.output, h.output)
            else 0
          end
      ) / 1000000 as bound
    from live as l
    cross join highest as h
    left join in_force as f on l.incomplete and f.model = l.model_responded
    where l.cost_usd is null
  ),
  windows as (
    select
      l.*,
      b.bound,
      p_user_id is not null and l.user_id = p_user_id and l.created_at >= p_day_start as in_user_day,
      l.created_at >= p_month_start as in_month,
      p_job_id is not null and l.job_id = p_job_id as in_job
    from live as l
    left join bounds as b on b.id = l.id
  ),
  totals as (
    select
      coalesce(sum(w.cost_usd) filter (where w.in_user_day), 0) as user_day_cost,
      count(*) filter (where w.in_user_day and w.cost_usd is null and not w.reservation) as user_day_unpriced,
      count(*) filter (where w.in_user_day and w.cost_usd is null) as user_day_with_bound,
      sum(w.bound) filter (where w.in_user_day) as user_day_bound,
      coalesce(sum(w.cost_usd) filter (where w.in_month), 0) as month_cost,
      count(*) filter (where w.in_month and w.cost_usd is null and not w.reservation) as month_unpriced,
      count(*) filter (where w.in_month and w.cost_usd is null) as month_with_bound,
      sum(w.bound) filter (where w.in_month) as month_bound,
      coalesce(sum(w.cost_usd) filter (where w.in_job), 0) as job_cost,
      count(*) filter (where w.in_job and w.cost_usd is null and not w.reservation) as job_unpriced,
      count(*) filter (where w.in_job and w.cost_usd is null) as job_with_bound,
      sum(w.bound) filter (where w.in_job) as job_bound
    from windows as w
  )
  select
    case when p_user_id is null then null else t.user_day_cost end,
    case when p_user_id is null then null else t.user_day_unpriced::integer end,
    case when p_user_id is null then null when t.user_day_with_bound = 0 then 0 else round(t.user_day_bound, 6) end,
    t.month_cost,
    t.month_unpriced::integer,
    case when t.month_with_bound = 0 then 0 else round(t.month_bound, 6) end,
    case when p_job_id is null then null else t.job_cost end,
    case when p_job_id is null then null else t.job_unpriced::integer end,
    case when p_job_id is null then null when t.job_with_bound = 0 then 0 else round(t.job_bound, 6) end
  from totals as t;
end;
$$;

comment on function public.usage_for_caps(timestamptz, timestamptz, uuid, uuid, uuid) is
  'Cap totals for the gateway: cost, unpriced call count and an upper bound for unpriced usage and open reservations, per user day, month and job. Null where a window was not requested, or where a bound cannot be computed.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table public.model_prices, public.llm_global_caps, public.llm_task_config, public.llm_account_caps, public.llm_usage from public;
revoke execute on function public.require_current_price() from public;
revoke execute on function public.usage_for_caps(timestamptz, timestamptz, uuid, uuid, uuid) from public;
-- For the application role (replace app_server with yours):
--   grant select, insert on public.model_prices, public.llm_usage to app_server;
--   grant select on public.llm_global_caps, public.llm_task_config, public.llm_account_caps to app_server;
--   grant execute on function public.usage_for_caps(timestamptz, timestamptz, uuid, uuid, uuid) to app_server;
