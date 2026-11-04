-- The parts of a Supabase project the migrations depend on, for PGlite.
--
-- Roles: anon, authenticated and service_role as PostgREST uses them (service_role bypasses RLS),
-- and supabase_auth_admin, the role Auth connects as. It owns the auth schema and does not bypass
-- RLS, which is why the hook needs a policy to read allowed_emails.
--
-- Default privileges: what Supabase sets up for objects the postgres role creates in public. Every
-- table, sequence and function is granted to anon, authenticated and service_role. The migrations'
-- revokes are therefore tested against the grants they undo.
--
-- auth.users: the columns the triggers, the functions and the tests touch, with the types Auth
-- uses. auth.uid(): reads the sub claim the way Supabase's does.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role supabase_auth_admin nologin noinherit;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  confirmation_token varchar(255),
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0,
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  phone text unique default null,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);
alter table auth.users owner to supabase_auth_admin;
grant select on auth.users to service_role;

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
alter function auth.uid() owner to supabase_auth_admin;
grant execute on function auth.uid() to anon, authenticated, service_role;
