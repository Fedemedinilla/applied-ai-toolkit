-- Conventions every later migration in this folder follows, and the trigger function they share.
--
-- Supabase grants anon, authenticated and service_role every privilege on what the postgres role
-- creates in public (tables, sequences and functions), and Postgres itself grants EXECUTE on every
-- new function to PUBLIC. The publishable key, which ships in the browser bundle, resolves to anon.
-- So each object here is created closed and opened only as far as it is used:
--
-- 1. Every table turns on row level security and revokes all from public, anon, authenticated and
--    service_role, then grants back the exact privileges a role needs, with a policy where RLS
--    applies. anon is granted nothing anywhere.
-- 2. authenticated only reads. Every write goes through the server (service_role) or a trigger, and
--    no function is executable by anon or authenticated.
-- 3. service_role gets at most SELECT, INSERT, UPDATE and DELETE on a table; never TRUNCATE,
--    REFERENCES, TRIGGER or MAINTAIN.
-- 4. Every function sets search_path to '' and qualifies every name, including pg_catalog ones, and
--    revokes EXECUTE from public, anon, authenticated and service_role. A trigger function is never
--    granted to anyone: it runs as a trigger.
-- 5. Every table has a comment.
-- 6. security invoker is the default. security definer is used only where the caller must not have
--    the privilege itself, and the comment on the function says why.
-- 7. Error messages carry ids, never an email address: they end up in the Auth logs.
--
-- Rules 2, 3 and 5 are this folder's strict profile. An app that lets authenticated write behind a
-- policy breaks rule 2 on purpose; see the README before running sql/audit.sql on such a project.
-- sql/audit.sql checks rules 1 to 5 over the whole public schema.

-- Invoker: it needs no privilege beyond the update that fires it.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger before update: sets updated_at to the transaction time.';

revoke execute on function public.set_updated_at() from public, anon, authenticated, service_role;
