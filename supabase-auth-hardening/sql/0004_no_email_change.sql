-- Every user keeps the address it signed up with.
--
-- Auth lets a user change its address with a session (PUT /auth/v1/user with a new email; the
-- publishable key is enough) and lets the server do it with the secret key
-- (auth.admin.updateUserById, or generateLink of type email_change_*). The before-user-created hook
-- runs only on sign-up, so none of those paths passes through allowed_emails.
--
-- Seen on Auth v2.197.0 without this trigger: the change request succeeded and, with the two codes,
-- the user ended up on the new address. The original address could then sign up again, and
-- create_account gave it a second account with the same role. One row of the list became as many
-- accounts as the person had addresses, and the list stopped saying who has an account.
--
-- The trigger refuses the change request, which Auth stores in email_change, and any change to
-- email, whatever path it came from. It does not consult allowed_emails: moving to another listed
-- address would keep the old row's role, and the old row could then produce a second user.
--
-- It also refuses Auth's soft delete (deleteUser with shouldSoftDelete), which rewrites the address.
-- Delete users for real. If an address ever has to change, do it in its own migration that moves
-- the allowed_emails row and auth.users.email in the same transaction, with this trigger disabled
-- for that statement.
--
-- Seen on Auth v2.197.0 with this trigger: the change request answers 500 "Error sending email
-- change email", updateUserById answers 500 "Error updating user", and a soft delete answers 500
-- "Error soft deleting user". supabase-js returns them as AuthRetryableFetchError.

-- Invoker: it reads and writes nothing; it only stops the write.
create function public.block_email_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The id, not the address, because the message ends up in the Auth logs.
  raise exception 'User % cannot change its email address.', new.id
    using errcode = 'insufficient_privilege',
          hint = 'Email changes are closed (0004_no_email_change.sql).';
end;
$$;

comment on function public.block_email_change() is
  'Trigger before update of email, email_change on auth.users: refuses every email change and every change request, so allowed_emails keeps saying who has an account.';

revoke execute on function public.block_email_change() from public, anon, authenticated, service_role;

-- The when clause lets through writes that name those columns without changing them, and the one
-- that clears email_change: it fires only on a real change.
create trigger block_email_change
  before update of email, email_change on auth.users
  for each row
  when (
    new.email is distinct from old.email
    or (new.email_change is distinct from old.email_change and new.email_change <> '')
  )
  execute function public.block_email_change();
