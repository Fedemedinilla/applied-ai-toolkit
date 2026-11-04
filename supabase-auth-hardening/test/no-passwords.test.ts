import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_BCRYPT, FRESH_DB_TIMEOUT, address, allow, asRole, openDb, scalar, signUp } from './helpers/db.ts';

let db: PGlite;

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});

const passwordOf = (target: PGlite, id: string) => scalar<string | null>(target, 'select encrypted_password from auth.users where id = $1', [id]);
/** Auth writes auth.users as supabase_auth_admin. */
const authUpdate = (sql: string, params: readonly unknown[]) => asRole(db, 'supabase_auth_admin', () => db.query(sql, [...params]));

describe('discard_password trigger', () => {
  it('keeps a pre-registered password without the trigger, which is the gap it closes', async () => {
    // A stranger calls /auth/v1/signup with a listed address and a password of their own. The hook
    // lets it through, and the row keeps the hash the owner's later code sign-in will not remove.
    const open = await openDb({ upTo: '0002' });
    try {
      const email = address('owner');
      await allow(open, email);
      const id = await signUp(open, email, { password: FAKE_BCRYPT });
      await asRole(open, 'supabase_auth_admin', () => open.query('update auth.users set email_confirmed_at = now() where id = $1', [id]));
      expect(await passwordOf(open, id)).toBe(FAKE_BCRYPT);
    } finally {
      await open.close();
    }
  }, FRESH_DB_TIMEOUT);

  it('empties a password written at sign-up, and the user still gets its account', async () => {
    const email = address('presigned');
    await allow(db, email);
    const id = await signUp(db, email, { password: FAKE_BCRYPT });
    expect(await passwordOf(db, id)).toBe('');
    expect(await scalar<number>(db, 'select count(*)::int from public.accounts where user_id = $1', [id])).toBe(1);
  });

  it('leaves a sign-up with no password as it was', async () => {
    const email = address('code-only');
    await allow(db, email);
    const id = await signUp(db, email);
    expect(await passwordOf(db, id)).toBeNull();
  });

  it('keeps the password empty when the owner confirms the address with its code', async () => {
    const email = address('confirmed');
    await allow(db, email);
    const id = await signUp(db, email, { password: FAKE_BCRYPT });
    await authUpdate('update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = $1', [id]);
    expect(await passwordOf(db, id)).toBe('');
  });

  it('empties a password set later, as PUT /auth/v1/user with a session would', async () => {
    const a = address('later-a');
    const b = address('later-b');
    await allow(db, a, b);
    const ids = [await signUp(db, a), await signUp(db, b, { password: FAKE_BCRYPT })];
    await authUpdate('update auth.users set encrypted_password = $1 where id = any($2::uuid[])', [FAKE_BCRYPT.replace('01234', '56789'), ids]);
    for (const id of ids) expect(await passwordOf(db, id)).toBe('');
  });

  it('lets other writes through unchanged', async () => {
    const email = address('metadata');
    await allow(db, email);
    const id = await signUp(db, email);
    await authUpdate('update auth.users set raw_user_meta_data = $1::jsonb where id = $2', ['{"name":"Ana"}', id]);
    expect(await scalar<string>(db, "select raw_user_meta_data ->> 'name' from auth.users where id = $1", [id])).toBe('Ana');
  });

  it('leaves no stored password anywhere in auth.users', async () => {
    expect(await scalar<number>(db, "select count(*)::int from auth.users where encrypted_password <> ''")).toBe(0);
  });
});
