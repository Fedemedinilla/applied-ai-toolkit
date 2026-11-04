-- No passwords on a real Supabase database: discard_password empties them at sign-up and later.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

insert into public.allowed_emails (email) values ('ana@example.test'), ('ben@example.test');

-- A sign-up with a password, as /auth/v1/signup writes it (a fake bcrypt hash), and one without.
insert into auth.users (id, email, encrypted_password) values
  ('11111111-1111-1111-1111-111111111111', 'ana@example.test', '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234');
insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222', 'ben@example.test');

select is((select encrypted_password from auth.users where id = '11111111-1111-1111-1111-111111111111'), '', 'a sign-up with a password is left without one');
select is((select encrypted_password from auth.users where id = '22222222-2222-2222-2222-222222222222'), null, 'a sign-up without a password stays without one');

update auth.users set email_confirmed_at = now() where id = '11111111-1111-1111-1111-111111111111';
select is((select encrypted_password from auth.users where id = '11111111-1111-1111-1111-111111111111'), '', 'confirming the address brings no password back');

update auth.users set encrypted_password = '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ56789'
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
select is(
  (select array_agg(encrypted_password order by id) from auth.users
   where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')),
  array['', '']::varchar[],
  'a password set later is not kept either'
);

update auth.users set raw_user_meta_data = '{"name":"Ana"}' where id = '11111111-1111-1111-1111-111111111111';
select is((select raw_user_meta_data ->> 'name' from auth.users where id = '11111111-1111-1111-1111-111111111111'), 'Ana', 'other writes pass');

select is_empty($$select 1 from auth.users where encrypted_password <> ''$$, 'no user in auth.users stores a password');

select * from finish();
rollback;
