-- Structure of public and the privileges of each table and function, on a real Supabase database.
-- The general checks walk all of public: a new table without RLS, open to anon, writable by
-- authenticated, or a function without an empty search_path fails this file even if nobody wrote a
-- test for it. Adjust tables_are and functions_are when you add your own objects.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(50);

select tables_are('public', array['accounts', 'allowed_emails', 'otp_attempts'], 'public has only these tables');
select functions_are(
  'public',
  array['before_user_created_hook', 'block_email_change', 'create_account', 'discard_password', 'reserve_otp_attempt', 'set_updated_at'],
  'public has only these functions'
);
select enums_are('public', array['account_role', 'otp_attempt_outcome'], 'public has only these enums');
select enum_has_labels('public', 'account_role', array['admin', 'member'], 'account roles');
select enum_has_labels('public', 'otp_attempt_outcome', array['recorded', 'exhausted', 'no_code'], 'outcomes of an attempt reservation');

-- General checks over all of public
select is(
  array(
    select c.relname::text from pg_catalog.pg_class as c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
    order by 1
  ),
  array[]::text[],
  'every table in public has RLS'
);
select is(
  array(
    select c.relname::text from pg_catalog.pg_class as c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and (
        has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
        or has_table_privilege('anon', c.oid, 'DELETE, TRUNCATE, TRIGGER')
      )
    order by 1
  ),
  array[]::text[],
  'anon has no privilege on any table, view or sequence in public'
);
select is(
  array(
    select c.relname::text from pg_catalog.pg_class as c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and (
        has_any_column_privilege('authenticated', c.oid, 'INSERT, UPDATE, REFERENCES')
        or has_table_privilege('authenticated', c.oid, 'DELETE, TRUNCATE, TRIGGER')
      )
    order by 1
  ),
  array[]::text[],
  'authenticated cannot write to any table in public, not even one column'
);
select is(
  array(
    select p.oid::regprocedure::text from pg_catalog.pg_proc as p
    where p.pronamespace = 'public'::regnamespace
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    order by 1
  ),
  array[]::text[],
  'neither anon nor authenticated executes a function in public'
);
select is(
  array(
    select p.oid::regprocedure::text from pg_catalog.pg_proc as p
    where p.pronamespace = 'public'::regnamespace and has_function_privilege('service_role', p.oid, 'EXECUTE')
    order by 1
  ),
  array['reserve_otp_attempt(text)'],
  'service_role executes only the function the server calls'
);
select is(
  array(
    select p.oid::regprocedure::text from pg_catalog.pg_proc as p
    where p.pronamespace = 'public'::regnamespace
      and not coalesce(p.proconfig @> array['search_path=""'], false)
    order by 1
  ),
  array[]::text[],
  'every function in public sets an empty search_path'
);
select is(
  array(
    select c.relname::text from pg_catalog.pg_class as c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (
        has_any_column_privilege('service_role', c.oid, 'REFERENCES')
        or has_table_privilege('service_role', c.oid, 'TRUNCATE, TRIGGER')
      )
    order by 1
  ),
  array[]::text[],
  'service_role has no TRUNCATE, REFERENCES or TRIGGER on any table in public'
);

-- Table privileges per role
select table_privs_are('public', 'allowed_emails', 'anon', array[]::text[], 'allowed_emails: anon nothing');
select table_privs_are('public', 'allowed_emails', 'authenticated', array[]::text[], 'allowed_emails: authenticated nothing');
select table_privs_are('public', 'allowed_emails', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'allowed_emails: service_role manages it');
select table_privs_are('public', 'allowed_emails', 'supabase_auth_admin', array['SELECT'], 'allowed_emails: supabase_auth_admin reads');

select table_privs_are('public', 'accounts', 'anon', array[]::text[], 'accounts: anon nothing');
select table_privs_are('public', 'accounts', 'authenticated', array['SELECT'], 'accounts: authenticated reads');
select table_privs_are('public', 'accounts', 'service_role', array['SELECT'], 'accounts: service_role reads the table');
select column_privs_are('public', 'accounts', 'role', 'service_role', array['SELECT', 'UPDATE'], 'accounts.role: service_role changes it');
select column_privs_are('public', 'accounts', 'user_id', 'service_role', array['SELECT'], 'accounts.user_id: service_role only reads');
select table_privs_are('public', 'accounts', 'supabase_auth_admin', array[]::text[], 'accounts: supabase_auth_admin nothing (the trigger is definer)');

select table_privs_are('public', 'otp_attempts', 'anon', array[]::text[], 'otp_attempts: anon nothing');
select table_privs_are('public', 'otp_attempts', 'authenticated', array[]::text[], 'otp_attempts: authenticated nothing');
select table_privs_are('public', 'otp_attempts', 'service_role', array[]::text[], 'otp_attempts: service_role nothing (reserve_otp_attempt is definer)');
select table_privs_are('public', 'otp_attempts', 'supabase_auth_admin', array[]::text[], 'otp_attempts: supabase_auth_admin nothing');

-- Function privileges
select function_privs_are('public', 'before_user_created_hook', array['jsonb'], 'anon', array[]::text[], 'hook: anon cannot execute');
select function_privs_are('public', 'before_user_created_hook', array['jsonb'], 'authenticated', array[]::text[], 'hook: authenticated cannot execute');
select function_privs_are('public', 'before_user_created_hook', array['jsonb'], 'service_role', array[]::text[], 'hook: service_role cannot execute');
select function_privs_are('public', 'before_user_created_hook', array['jsonb'], 'supabase_auth_admin', array['EXECUTE'], 'hook: supabase_auth_admin executes');

select function_privs_are('public', 'create_account', array[]::text[], 'service_role', array[]::text[], 'create_account: service_role cannot execute');
select function_privs_are('public', 'create_account', array[]::text[], 'supabase_auth_admin', array[]::text[], 'create_account: supabase_auth_admin cannot execute (it runs as a trigger)');
select function_privs_are('public', 'discard_password', array[]::text[], 'service_role', array[]::text[], 'discard_password: service_role cannot execute');
select function_privs_are('public', 'discard_password', array[]::text[], 'supabase_auth_admin', array[]::text[], 'discard_password: supabase_auth_admin cannot execute (it runs as a trigger)');
select function_privs_are('public', 'block_email_change', array[]::text[], 'service_role', array[]::text[], 'block_email_change: service_role cannot execute');
select function_privs_are('public', 'block_email_change', array[]::text[], 'supabase_auth_admin', array[]::text[], 'block_email_change: supabase_auth_admin cannot execute (it runs as a trigger)');
select function_privs_are('public', 'set_updated_at', array[]::text[], 'service_role', array[]::text[], 'set_updated_at: service_role cannot execute');

select function_privs_are('public', 'reserve_otp_attempt', array['text'], 'anon', array[]::text[], 'reserve_otp_attempt: anon cannot execute');
select function_privs_are('public', 'reserve_otp_attempt', array['text'], 'authenticated', array[]::text[], 'reserve_otp_attempt: authenticated cannot execute');
select function_privs_are('public', 'reserve_otp_attempt', array['text'], 'service_role', array['EXECUTE'], 'reserve_otp_attempt: service_role executes');

-- Security of each function
select is_definer('public', 'create_account', array[]::text[], 'create_account is security definer: Auth inserts as supabase_auth_admin');
select is_definer('public', 'reserve_otp_attempt', array['text'], 'reserve_otp_attempt is security definer: no role touches otp_attempts');
select isnt_definer('public', 'before_user_created_hook', array['jsonb'], 'the hook is invoker, as the hook documentation asks');
select isnt_definer('public', 'discard_password', array[]::text[], 'discard_password is invoker');
select isnt_definer('public', 'block_email_change', array[]::text[], 'block_email_change is invoker');
select isnt_definer('public', 'set_updated_at', array[]::text[], 'set_updated_at is invoker');

-- The triggers on auth.users
select trigger_is('auth', 'users', 'create_account', 'public', 'create_account', 'auth.users has the account trigger');
select trigger_is('auth', 'users', 'discard_password', 'public', 'discard_password', 'auth.users has the password trigger');
select trigger_is('auth', 'users', 'block_email_change', 'public', 'block_email_change', 'auth.users has the email change trigger');
select trigger_is('public', 'accounts', 'accounts_set_updated_at', 'public', 'set_updated_at', 'accounts stamps updated_at');

select * from finish();
rollback;
