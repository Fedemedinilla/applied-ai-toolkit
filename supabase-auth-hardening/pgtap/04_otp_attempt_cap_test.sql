-- The OTP attempt cap on a real Supabase database: 20 per address in 24 hours, with the three
-- outcomes of reserve_otp_attempt.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

-- Exact counts below: start from an empty table. Rows from other runs cannot be deleted by any
-- application role; this delete is undone with the transaction.
delete from public.otp_attempts;

-- ana and ben are users; cara is listed with no user yet; dora is a user whose address left the
-- list, stored in auth.users with uppercase letters.
insert into public.allowed_emails (email) values ('ana@example.test'), ('ben@example.test'), ('cara@example.test'), ('dora@example.test');
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ana@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'ben@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'DORA@Example.test');
delete from public.allowed_emails where email = 'dora@example.test';

select policies_are('public', 'otp_attempts', array[]::text[], 'no policies: only the function touches the table');

set local role service_role;
select is(
  (select array_agg(public.reserve_otp_attempt('ana@example.test')) from generate_series(1, 20)),
  array_fill('recorded'::otp_attempt_outcome, array[20]),
  'the first 20 attempts are recorded'
);
select is(public.reserve_otp_attempt('ana@example.test'), 'exhausted', 'the 21st is exhausted');
select is(public.reserve_otp_attempt('  ANA@Example.test '), 'exhausted', 'other case and spacing is the same address');
select is(public.reserve_otp_attempt('ben@example.test'), 'recorded', 'another address has its own attempts');
select throws_ok($$select public.reserve_otp_attempt(' ')$$, '22004', null, 'a missing address is refused');
select is(
  (select array_agg(public.reserve_otp_attempt('made-up-' || n || '@example.test')) from generate_series(1, 30) as n),
  array_fill('no_code'::otp_attempt_outcome, array[30]),
  'an address neither listed nor a user is no_code'
);
select is(
  (select array_agg(public.reserve_otp_attempt('cara@example.test')) from generate_series(1, 21)),
  array_append(array_fill('recorded'::otp_attempt_outcome, array[20]), 'exhausted'::otp_attempt_outcome),
  'a listed address with no user has its 20 attempts'
);
select is(
  array[public.reserve_otp_attempt('dora@example.test'), public.reserve_otp_attempt('  Dora@EXAMPLE.test')],
  array['recorded', 'recorded']::otp_attempt_outcome[],
  'a user whose address left the list is still counted'
);
select throws_ok($$select * from public.otp_attempts$$, '42501', null, 'service_role cannot read the table');
reset role;

select is(
  (select count(*)::integer from public.otp_attempts),
  43,
  'rows only for addresses that can hold a code: 20 for ana, 1 for ben, 20 for cara, 2 for dora'
);

update public.otp_attempts set created_at = now() - interval '25 hours'
where id in (select id from public.otp_attempts where email_hash = sha256(convert_to('ana@example.test', 'UTF8')) limit 5);
set local role service_role;
select is(
  (select array_agg(public.reserve_otp_attempt('ana@example.test')) from generate_series(1, 6)),
  array['recorded', 'recorded', 'recorded', 'recorded', 'recorded', 'exhausted']::otp_attempt_outcome[],
  'attempts that left the window free their slots'
);
reset role;
select is(
  (select count(*)::integer from public.otp_attempts where created_at < now() - interval '24 hours'),
  0,
  'the reservation deletes attempts that left the window'
);

select * from finish();
rollback;
