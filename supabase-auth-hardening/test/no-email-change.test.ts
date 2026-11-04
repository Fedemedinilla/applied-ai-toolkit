import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRESH_DB_TIMEOUT, address, allow, asRole, openDb, scalar, signUp, sqlState } from './helpers/db.ts';

let db: PGlite;
let ana: string;
let ben: string;
let anaEmail: string;
let benEmail: string;

beforeAll(async () => {
  db = await openDb();
  anaEmail = address('ana');
  benEmail = address('ben');
  await allow(db, { email: anaEmail, role: 'admin' }, benEmail);
  ana = await signUp(db, anaEmail);
  ben = await signUp(db, benEmail);
}, 60_000);
afterAll(async () => {
  await db.close();
});

/** Auth writes auth.users as supabase_auth_admin. */
const authWrite = (sql: string, params: readonly unknown[] = [], target: PGlite = db) =>
  asRole(target, 'supabase_auth_admin', () => target.query(sql, [...params]));

describe('block_email_change trigger', () => {
  it('lets one listed row become two admin accounts without the trigger, which is the gap it closes', async () => {
    const open = await openDb({ upTo: '0003' });
    try {
      const listed = address('owner');
      await allow(open, { email: listed, role: 'admin' });
      const first = await signUp(open, listed);
      // The two codes of an email change confirmed: the user moves to an address off the list.
      await authWrite('update auth.users set email = $1 where id = $2', [address('elsewhere'), first], open);
      // The listed address is free again, and signs up as a second admin.
      await signUp(open, listed);
      expect(await scalar<number>(open, "select count(*)::int from public.accounts where role = 'admin'")).toBe(2);
    } finally {
      await open.close();
    }
  }, FRESH_DB_TIMEOUT);

  it.each([
    ['to an address off the list', () => address('off-list')],
    ['to another listed address', () => benEmail],
    ['to another spelling of the same address', () => anaEmail.toUpperCase()],
    ['to no address', () => null],
  ])('refuses a change %s', async (_, to) => {
    expect(await sqlState(() => authWrite('update auth.users set email = $1 where id = $2', [to(), ana]))).toBe('42501');
  });

  it('refuses a change request, as PUT /auth/v1/user with a new address stores it', async () => {
    const state = await sqlState(() =>
      authWrite("update auth.users set email_change = $1, email_change_token_new = 'token', email_change_sent_at = now() where id = $2", [address('new'), ana]),
    );
    expect(state).toBe('42501');
  });

  it('refuses a request in an update of several rows', async () => {
    expect(await sqlState(() => authWrite('update auth.users set email_change = $1 where id = any($2::uuid[])', [address('bulk'), [ana, ben]]))).toBe('42501');
  });

  it("refuses Auth's soft delete, which rewrites the address", async () => {
    const state = await sqlState(() => authWrite("update auth.users set email = $1, deleted_at = now() where id = $2", [`${ben}@deleted.example.test`, ben]));
    expect(state).toBe('42501');
  });

  it('refuses the change even with the secret key, as auth.admin.updateUserById', async () => {
    // service_role has no UPDATE on auth.users in the stub; the superuser stands in for any role that does.
    expect(await sqlState(() => db.query('update auth.users set email = $1 where id = $2', [address('admin-path'), ana]))).toBe('42501');
  });

  it('lets through writes that name the columns without changing them, and clearing a request', async () => {
    await authWrite('update auth.users set email = email, email_change = email_change where id = $1', [ana]);
    await authWrite("update auth.users set email_change = '', email_change_token_new = '', email_change_confirm_status = 0 where id = $1", [ana]);
    await authWrite("update auth.users set email_confirmed_at = now(), last_sign_in_at = now(), raw_user_meta_data = '{\"name\":\"Ana\"}' where id = $1", [ana]);
    const row = await db.query<{ email: string; email_change: string; confirmed: boolean; name: string }>(
      "select email, email_change, email_confirmed_at is not null as confirmed, raw_user_meta_data->>'name' as name from auth.users where id = $1",
      [ana],
    );
    expect(row.rows).toEqual([{ email: anaEmail, email_change: '', confirmed: true, name: 'Ana' }]);
  });

  it('leaves both users on their own address with no request pending', async () => {
    const r = await db.query<{ email: string; pending: string }>(
      "select email, coalesce(email_change, '') as pending from auth.users where id = any($1::uuid[]) order by email",
      [[ana, ben]],
    );
    expect(r.rows).toEqual([
      { email: anaEmail, pending: '' },
      { email: benEmail, pending: '' },
    ].sort((x, y) => x.email.localeCompare(y.email)));
  });

  it('lets a user be deleted for real, and its account goes with it', async () => {
    await authWrite('delete from auth.users where id = $1', [ben]);
    expect(await scalar<number>(db, 'select count(*)::int from public.accounts where user_id = $1', [ben])).toBe(0);
  });
});
