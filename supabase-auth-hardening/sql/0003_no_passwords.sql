-- No account stores a password. Sign-in is by email code (and OAuth, if enabled).
--
-- Auth has no switch that turns off passwords for the email provider without also turning off the
-- email code, so the database discards them. Without this, anyone with the publishable key (it is
-- public: it ships in the browser bundle) can call /auth/v1/signup with a listed address that has
-- not signed in yet and a password of their choosing. The hook lets it through, because Auth sends
-- it the same event as a sign-up by code, and the user is left unconfirmed. When the owner later
-- signs in with their code, Auth confirms the address and keeps that password, and the other person
-- signs in with it. Seen on Auth v2.197.0: before this trigger, that sign-in returned a session.
-- The same holds for a stolen session: PUT /auth/v1/user with a new password would give an access
-- that outlives the session.
--
-- The trigger empties any password written to auth.users, at sign-up or later. Password sign-in
-- then answers 400 invalid_credentials, and the email code keeps working. A sign-up by code already
-- carries a random password from Auth, which is emptied too. What a stranger's sign-up still leaves
-- is raw_user_meta_data, which the caller of /signup writes: do not trust it for anything.
--
-- Requires "Confirm email" on. Without confirmation, a password sign-up returns a session in the
-- same response and this trigger comes too late.

-- Invoker: it only changes the row Auth is writing.
create function public.discard_password()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.encrypted_password := '';
  return new;
end;
$$;

comment on function public.discard_password() is
  'Trigger before insert or update of encrypted_password on auth.users: stores an empty password. The application does not use passwords.';

revoke execute on function public.discard_password() from public, anon, authenticated, service_role;

-- The when clause skips the call when there is no password (null or empty).
create trigger discard_password
  before insert or update of encrypted_password on auth.users
  for each row
  when (new.encrypted_password <> '')
  execute function public.discard_password();
