-- No email change on a real Supabase database: block_email_change refuses the change and the
-- change request in auth.users.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(11);

insert into public.allowed_emails (email, role) values ('ana@example.test', 'admin'), ('ben@example.test', 'member');
insert into auth.users (id, email, email_change) values
  ('11111111-1111-1111-1111-111111111111', 'ana@example.test', ''),
  ('22222222-2222-2222-2222-222222222222', 'ben@example.test', '');

select throws_ok($$update auth.users set email = 'other@example.test' where id = '11111111-1111-1111-1111-111111111111'$$, '42501', null, 'no move to an address off the list');
select throws_ok($$update auth.users set email = 'ben@example.test' where id = '11111111-1111-1111-1111-111111111111'$$, '42501', null, 'no move to a listed address');
select throws_ok($$update auth.users set email = 'Ana@Example.test' where id = '11111111-1111-1111-1111-111111111111'$$, '42501', null, 'no move to another spelling');
select throws_ok($$update auth.users set email = null where id = '11111111-1111-1111-1111-111111111111'$$, '42501', null, 'no move to no address');
select throws_ok(
  $$update auth.users set email_change = 'other@example.test', email_change_token_new = 'x' where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501', null, 'no change request'
);
select throws_ok(
  $$update auth.users set email = '22222222@deleted.example.test', deleted_at = now() where id = '22222222-2222-2222-2222-222222222222'$$,
  '42501', null, 'no soft delete that rewrites the address'
);
select lives_ok($$update auth.users set email = email, email_change = email_change where id = '11111111-1111-1111-1111-111111111111'$$, 'rewriting the same address is not a change');
select lives_ok(
  $$update auth.users set email_change = '', email_change_token_new = '', email_change_confirm_status = 0 where id = '11111111-1111-1111-1111-111111111111'$$,
  'clearing email_change is not a change'
);
select lives_ok(
  $$update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = '11111111-1111-1111-1111-111111111111'$$,
  'confirming and signing in pass'
);
select lives_ok($$delete from auth.users where id = '22222222-2222-2222-2222-222222222222'$$, 'a user can be deleted for real');
select is_empty($$select 1 from public.accounts where user_id = '22222222-2222-2222-2222-222222222222'$$, 'and its account goes with it');

select * from finish();
rollback;
