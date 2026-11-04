-- Closed sign-ups: only the addresses in public.allowed_emails can become users.
--
-- Two layers, because Auth has two ways to create a user and only one of them calls the hook:
--
-- 1. public.before_user_created_hook, registered as the "Before User Created" Postgres hook. Auth
--    calls it for sign-ups through the public API (email code, password sign-up, OAuth) and for
--    auth.admin.generateLink. A rejection reaches the client as HTTP 403 with
--    {"code":403,"error_code":"unknown","msg":<the hook's message>}.
-- 2. The trigger create_account on auth.users. auth.admin.createUser does not call the hook (seen
--    on Auth v2.197.0), and neither does a direct insert. The trigger refuses any new row whose
--    email is not on the list, so the insert fails and Auth answers 500 "Database error creating
--    new user". It also creates the account row with the role the list gives. This trigger is the
--    guarantee: with no row on the list there is no user, wherever the sign-up came from.
--
-- Removing an address from the list does not lock out a user who already exists. Changing the email
-- of an existing user is closed by 0004_no_email_change.sql; without it, an account could move to an
-- address off the list and free its listed address for a second account.
--
-- No real address goes in a migration. Load the list from the SQL editor, lowercase and trimmed:
--   insert into public.allowed_emails (email, role) values ('<address>', 'admin');

create type public.account_role as enum ('admin', 'member');
comment on type public.account_role is
  'Role of an account. admin manages the application; member uses it. Set from public.allowed_emails at sign-up.';

create table public.allowed_emails (
  email text primary key
    constraint allowed_emails_email_normalized
      check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role public.account_role not null default 'member',
  note text,
  created_at timestamptz not null default now()
);

comment on table public.allowed_emails is
  'Addresses allowed to sign up, with the role each account gets. Read by the before-user-created hook (role supabase_auth_admin) and by the create_account trigger. Removing a row does not remove the user.';
comment on column public.allowed_emails.email is 'Lowercase and trimmed; the hook and the trigger normalize the incoming address the same way.';
comment on column public.allowed_emails.note is 'For whoever manages the list. Not exposed to users.';

alter table public.allowed_emails enable row level security;
revoke all on table public.allowed_emails from public, anon, authenticated, service_role;

-- Not exposed through the Data API to users. Auth reads it; the server manages it.
grant usage on schema public to supabase_auth_admin;
grant select on table public.allowed_emails to supabase_auth_admin;
grant select, insert, update, delete on table public.allowed_emails to service_role;

-- supabase_auth_admin does not bypass RLS. Without this policy the hook reads an empty list and
-- refuses every sign-up.
create policy allowed_emails_read_by_auth
  on public.allowed_emails
  for select
  to supabase_auth_admin
  using (true);

-- Invoker, as the Supabase hook documentation asks: it runs with the privileges of
-- supabase_auth_admin, which can only read this table.
create function public.before_user_created_hook(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if v_email <> '' and exists (
    select 1 from public.allowed_emails as a where a.email = v_email
  ) then
    return '{}'::jsonb;
  end if;

  -- Closed by default: no address, or an address off the list, is refused.
  return pg_catalog.jsonb_build_object(
    'error', pg_catalog.jsonb_build_object(
      'http_code', 403,
      'message', 'This email address is not allowed to sign up.'
    )
  );
end;
$$;

comment on function public.before_user_created_hook(jsonb) is
  'Before User Created hook. Returns {} when the address is in public.allowed_emails, otherwise a 403 error. Not called by auth.admin.createUser: the create_account trigger refuses those.';

revoke execute on function public.before_user_created_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.before_user_created_hook(jsonb) to supabase_auth_admin;

-- One row per user, created by the trigger below. A user reads its own row; the server changes the
-- role.
create table public.accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.account_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.accounts is
  'The account of each Auth user. Created by the create_account trigger at sign-up with the role from allowed_emails; deleted with the user.';

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

alter table public.accounts enable row level security;
revoke all on table public.accounts from public, anon, authenticated, service_role;

grant select on table public.accounts to authenticated;
-- Rows come from the trigger and go with the user: the server only changes the role.
grant select on table public.accounts to service_role;
grant update (role) on table public.accounts to service_role;

create policy accounts_read_own
  on public.accounts
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Definer: Auth inserts as supabase_auth_admin, which has no privilege on public.accounts. It runs
-- as the table owner, with an empty search_path and qualified names.
create function public.create_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed public.allowed_emails%rowtype;
begin
  select a.* into v_allowed
  from public.allowed_emails as a
  where a.email = pg_catalog.lower(pg_catalog.btrim(coalesce(new.email, '')));

  -- Closed by default, and the layer the hook cannot be: admin sign-ups and direct inserts do not
  -- call the hook. The message carries the id, not the address, because it ends up in the logs.
  if not found then
    raise exception 'User % is not in allowed_emails; no account is created.', new.id
      using errcode = 'insufficient_privilege',
            hint = 'Add the address to public.allowed_emails before the sign-up.';
  end if;

  insert into public.accounts (user_id, role)
  values (new.id, v_allowed.role);

  return new;
end;
$$;

comment on function public.create_account() is
  'Trigger after insert on auth.users: refuses a user whose address is not in allowed_emails and creates its account with the listed role. Covers auth.admin.createUser, which does not call the hook.';

revoke execute on function public.create_account() from public, anon, authenticated, service_role;

create trigger create_account
  after insert on auth.users
  for each row execute function public.create_account();
