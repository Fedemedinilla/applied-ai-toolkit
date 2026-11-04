-- Closed sign-ups on a real Supabase database: the list, the hook and the create_account trigger.
-- pgTAP runs as postgres, which cannot take the supabase_auth_admin role, so the hook is called
-- here as postgres. The Vitest suite calls it as supabase_auth_admin through RLS.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

insert into public.allowed_emails (email, role) values
  ('ana@example.test', 'admin'),
  ('ben@example.test', 'member');

-- The list
select col_is_pk('public', 'allowed_emails', 'email', 'the address is the key');
select throws_ok($$insert into public.allowed_emails (email) values ('Upper@Example.test')$$, '23514', null, 'refuses uppercase');
select throws_ok($$insert into public.allowed_emails (email) values (' space@example.test')$$, '23514', null, 'refuses spaces');
select throws_ok($$insert into public.allowed_emails (email) values ('no-at-sign')$$, '23514', null, 'refuses text without @');
select policies_are('public', 'allowed_emails', array['allowed_emails_read_by_auth'], 'one policy on the list');
select policy_roles_are('public', 'allowed_emails', 'allowed_emails_read_by_auth', array['supabase_auth_admin'], 'the policy is for supabase_auth_admin only');
select ok(has_schema_privilege('supabase_auth_admin', 'public', 'USAGE'), 'supabase_auth_admin can use schema public');

-- The hook, with events shaped like Auth's
select is(
  public.before_user_created_hook('{"metadata":{"name":"before-user-created"},"user":{"email":"ana@example.test","app_metadata":{"provider":"email"}}}'::jsonb),
  '{}'::jsonb,
  'a listed address passes'
);
select is(
  public.before_user_created_hook('{"user":{"email":"  Ana@Example.TEST ","app_metadata":{"provider":"google"}}}'::jsonb),
  '{}'::jsonb,
  'a listed address with other case and spacing passes'
);
select is(
  public.before_user_created_hook('{"user":{"email":"other@example.test"}}'::jsonb),
  '{"error":{"http_code":403,"message":"This email address is not allowed to sign up."}}'::jsonb,
  'an address off the list gets a 403'
);
select is(public.before_user_created_hook('{"user":{"email":"","phone":"15550100"}}'::jsonb) -> 'error' ->> 'http_code', '403', 'no address: 403');
select is(public.before_user_created_hook('{}'::jsonb) -> 'error' ->> 'http_code', '403', 'no user: 403');

-- The trigger: Auth inserts into auth.users
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'Ana@Example.test'),
  ('22222222-2222-2222-2222-222222222222', 'ben@example.test');
select results_eq(
  $$select user_id::text, role::text from public.accounts
    where user_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222') order by user_id$$,
  $$values ('11111111-1111-1111-1111-111111111111', 'admin'), ('22222222-2222-2222-2222-222222222222', 'member')$$,
  'each user gets the listed role'
);
select throws_ok(
  $$insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'nobody@example.test')$$,
  '42501', null, 'a user off the list is refused'
);
select throws_ok(
  $$insert into auth.users (id, phone) values ('44444444-4444-4444-4444-444444444444', '15550101')$$,
  '42501', null, 'a user with no address is refused'
);

-- RLS on accounts with two users
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select results_eq($$select user_id::text from public.accounts$$, $$values ('11111111-1111-1111-1111-111111111111')$$, 'ana sees only her account');
select throws_ok($$update public.accounts set role = 'admin'$$, '42501', null, 'a user cannot change its role');
select throws_ok($$delete from public.accounts$$, '42501', null, 'a user cannot delete accounts');
select throws_ok($$select public.before_user_created_hook('{}'::jsonb)$$, '42501', null, 'authenticated cannot call the hook');
select throws_ok($$select * from public.allowed_emails$$, '42501', null, 'authenticated cannot read the list');
reset role;

set local role anon;
select throws_ok($$select * from public.allowed_emails$$, '42501', null, 'anon cannot read the list');
reset role;

delete from auth.users where id = '22222222-2222-2222-2222-222222222222';
select is_empty($$select 1 from public.accounts where user_id = '22222222-2222-2222-2222-222222222222'$$, 'deleting the user deletes its account');

select * from finish();
rollback;
