-- Reference schema for the chat widget, PostgreSQL 15 or newer. Tenancy is by row: every table
-- carries tenant_id, and every query in server/sql-store.ts filters on it. A new business is an
-- insert, not a deploy.
--
-- The checks repeat the zod schemas in server/tenant.ts and the limits in server/limits.ts, so a
-- row written by hand or by another tool cannot hold what the handlers would refuse to read.
-- Only the backend connects, with one role; the panel's isolation comes from the tenant id in the
-- signed session, so there is no row-level security here. A deploy that lets anything else
-- connect needs RLS on all three tables.
--
-- test/store-contract.test.ts applies this file to an in-process Postgres (PGlite) and runs the
-- same suite as the in-memory store.

create table widget_tenants (
  tenant_id text primary key
    constraint widget_tenants_tenant_id_format check (tenant_id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  -- The tenant's id in the gateway's ledger: its daily spending cap is per account.
  account_id uuid not null unique,
  plan_status text not null default 'active'
    constraint widget_tenants_plan_status check (plan_status in ('active', 'past_due', 'suspended', 'inactive')),
  -- The plan's own monthly turn cap. Null: the deploy's default. It can only lower the default.
  monthly_turns integer constraint widget_tenants_monthly_turns check (monthly_turns > 0),
  -- An empty list answers on no site at all.
  allowed_domains text[] not null default '{}'
    constraint widget_tenants_allowed_domains check (cardinality(allowed_domains) <= 20),
  bot_name text not null default 'Asistente' constraint widget_tenants_bot_name check (char_length(bot_name) between 1 and 60),
  header text not null default 'Asistente' constraint widget_tenants_header check (char_length(header) between 1 and 60),
  welcome text not null default 'Hola. ¿En qué te puedo ayudar?' constraint widget_tenants_welcome check (char_length(welcome) between 1 and 300),
  placeholder text not null default 'Escribe tu mensaje' constraint widget_tenants_placeholder check (char_length(placeholder) between 1 and 80),
  -- The two values the widget puts into CSS.
  primary_color text not null default '#1f6f5c' constraint widget_tenants_primary_color check (primary_color ~* '^#[0-9a-f]{6}$'),
  font text not null default 'system-ui' constraint widget_tenants_font check (font ~ '^[A-Za-z0-9 ,''-]{1,60}$'),
  suggested_questions text[] not null default '{}'
    constraint widget_tenants_suggested_questions check (cardinality(suggested_questions) <= 4),
  tone_preset text not null default 'friendly' constraint widget_tenants_tone_preset check (tone_preset in ('friendly', 'formal', 'direct')),
  tone text not null default '' constraint widget_tenants_tone check (char_length(tone) <= 1000),
  context text not null default '' constraint widget_tenants_context check (char_length(context) <= 20000),
  faq text not null default '' constraint widget_tenants_faq check (char_length(faq) <= 10000),
  updated_at timestamptz not null default now()
);

create table widget_owners (
  tenant_id text primary key references widget_tenants (tenant_id) on delete cascade,
  email text not null constraint widget_owners_email check (email = lower(email) and position('@' in email) > 1),
  -- Null until the owner accepts an invite. The format carries its scrypt parameters.
  password_hash text constraint widget_owners_password_hash check (password_hash like 'scrypt$%'),
  -- The nonce of the only invite link that still works. Accepting it clears it.
  invite_nonce text
);

create unique index widget_owners_email_key on widget_owners (email);

-- One row per visitor turn. A turn is reserved before the model is called, so concurrent requests
-- see each other in the counts, then closed as answered or failed. A turn refused before the model
-- was called is deleted. No conversation text is stored.
create table widget_turns (
  id uuid primary key,
  tenant_id text not null references widget_tenants (tenant_id) on delete cascade,
  session_id uuid not null,
  created_at timestamptz not null,
  status text not null default 'reserved' constraint widget_turns_status check (status in ('reserved', 'answered', 'failed')),
  model text,
  input_tokens integer,
  output_tokens integer,
  -- Null when the gateway could not price the call; the gateway's own ledger holds the bound.
  cost_usd numeric(12, 6),
  error_code text,
  constraint widget_turns_shape check (
    (status = 'reserved' and model is null and input_tokens is null and output_tokens is null and cost_usd is null and error_code is null)
    or (status = 'answered' and model is not null and input_tokens >= 0 and output_tokens >= 0 and error_code is null)
    or (status = 'failed' and error_code is not null and model is null and input_tokens is null and output_tokens is null and cost_usd is null)
  )
);

-- countTurnsSince: one range scan per tenant and window.
create index widget_turns_tenant_created on widget_turns (tenant_id, created_at);
