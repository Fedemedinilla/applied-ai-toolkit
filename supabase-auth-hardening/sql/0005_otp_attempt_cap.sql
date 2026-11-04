-- A cap on attempts to verify an email sign-in code, per address.
--
-- Auth does not invalidate a code after failed attempts: on Auth v2.197.0, after 120 failed
-- verifications of the same code, the right one still signed in. The only brake is Auth's per-IP
-- limit on token verifications, and when sign-in runs on a server, every request reaches Auth from
-- the host's IPs: one shared limit for everybody. Anyone can request a code for a listed address and
-- try codes through the application for as long as the code lives.
--
-- The application's verify endpoint calls public.reserve_otp_attempt(email) before verifyOtp. It
-- returns an otp_attempt_outcome:
-- - recorded: the attempt is counted; ask Auth.
-- - exhausted: the address already has the cap inside the window. Nothing is recorded and Auth is
--   not asked.
-- - no_code: the address is neither on allowed_emails nor a user, so no code can be valid. Nothing
--   is recorded, Auth is not asked, and the endpoint answers as it does to a wrong code.
--
-- With 20 attempts a day, guessing an 8-digit code has about 7 chances in 100,000 a year
-- (20 x 365 / 100,000,000). Under a limit of 30 verifications per 5 minutes alone, it is 8,640
-- guesses a day.
--
-- Every attempt counts, including the one that succeeds. The reservation happens before Auth is
-- asked, under a lock per address, so two verifications of the same address at once cannot both
-- slip under the cap, and nothing has to be deleted on success.
--
-- The table stores a sha256 of the normalized address, never the address. The address comes from
-- the client, so it can be any text. That is why only addresses that can hold a code are recorded:
-- those on allowed_emails (the only ones that can sign up) and those in auth.users (a user whose
-- address was taken off the list still signs in). Recording any text would let anonymous requests
-- with made-up addresses grow the table without bound. Counting listed addresses that have no user
-- yet leaves no uncounted window between the first code and the user it creates.
--
-- On no_code the endpoint does not ask Auth, because every verifyOtp spends the shared per-IP limit:
-- requests with made-up addresses would otherwise lock out everybody.

create type public.otp_attempt_outcome as enum ('recorded', 'exhausted', 'no_code');
comment on type public.otp_attempt_outcome is
  'What reserve_otp_attempt returns. recorded: counted, ask Auth. exhausted: cap reached in the window; nothing recorded, do not ask Auth. no_code: the address cannot hold a code; nothing recorded, answer as a wrong code without asking Auth.';

create table public.otp_attempts (
  -- uuid, not identity: a sequence in public would receive the default grants to anon and
  -- authenticated.
  id uuid primary key default gen_random_uuid(),
  email_hash bytea not null
    constraint otp_attempts_email_hash_sha256 check (octet_length(email_hash) = 32),
  created_at timestamptz not null default now()
);

comment on table public.otp_attempts is
  'Attempts to verify a sign-in code, per address (its sha256), for the cap in reserve_otp_attempt. Only that function touches it: no role has a privilege on the table.';
comment on column public.otp_attempts.email_hash is 'sha256 of the lowercase, trimmed address. The table does not store the address.';

create index otp_attempts_email_hash_created_at_idx on public.otp_attempts (email_hash, created_at);
-- The cleanup deletes by date the rows that left the window.
create index otp_attempts_created_at_idx on public.otp_attempts (created_at);

alter table public.otp_attempts enable row level security;
revoke all on table public.otp_attempts from public, anon, authenticated, service_role;

-- Definer: no role, not even service_role, has a privilege on otp_attempts. The server can reserve
-- an attempt but cannot read, forge or delete the count.
create function public.reserve_otp_attempt(p_email text)
returns public.otp_attempt_outcome
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Changing the cap or the window is a new migration.
  c_cap constant integer := 20;
  c_window constant interval := interval '24 hours';
  v_email text;
  v_hash bytea;
  v_used integer;
begin
  if p_email is null or pg_catalog.btrim(p_email) = '' then
    raise exception 'reserve_otp_attempt: the email address is missing' using errcode = 'null_value_not_allowed';
  end if;
  v_email := pg_catalog.lower(pg_catalog.btrim(p_email));

  -- An address that is neither listed nor a user cannot hold a valid code: record nothing. The list
  -- is looked up by its key; auth.users only when that misses, and in lowercase, because it does
  -- not require a normalized address as the list does.
  if not exists (select 1 from public.allowed_emails as a where a.email = v_email)
     and not exists (select 1 from auth.users as u where pg_catalog.lower(u.email) = v_email) then
    return 'no_code'::public.otp_attempt_outcome;
  end if;

  v_hash := pg_catalog.sha256(pg_catalog.convert_to(v_email, 'UTF8'));

  -- One at a time per address, until the end of the transaction: two verifications at once do not
  -- both count the same attempts and pass.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.encode(v_hash, 'hex'), 0));

  delete from public.otp_attempts where created_at < pg_catalog.now() - c_window;

  select pg_catalog.count(*) into v_used
  from public.otp_attempts
  where email_hash = v_hash and created_at >= pg_catalog.now() - c_window;

  if v_used >= c_cap then
    return 'exhausted'::public.otp_attempt_outcome;
  end if;

  insert into public.otp_attempts (email_hash) values (v_hash);
  return 'recorded'::public.otp_attempt_outcome;
end;
$$;

comment on function public.reserve_otp_attempt(text) is
  'Server only, before verifyOtp. For a listed address or a user: records an attempt and returns recorded, or returns exhausted without recording when it already has 20 in the last 24 hours. Otherwise returns no_code and records nothing. Security definer: nothing else touches otp_attempts.';

revoke execute on function public.reserve_otp_attempt(text) from public, anon, authenticated;
grant execute on function public.reserve_otp_attempt(text) to service_role;
