import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRESH_DB_TIMEOUT, address, allow, asRole, openDb, scalar, signUp, sqlState } from './helpers/db.ts';

let db: PGlite;

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});

const REFUSAL = { error: { http_code: 403, message: 'This email address is not allowed to sign up.' } };

/** Calls the hook as Auth does: as supabase_auth_admin, through RLS. */
const hook = (event: unknown, target: PGlite = db) =>
  asRole(target, 'supabase_auth_admin', () => scalar<unknown>(target, 'select public.before_user_created_hook($1::jsonb)', [JSON.stringify(event)]));

/** An event shaped like the one Auth sends for a sign-up. */
const event = (email: string, provider = 'email') => ({
  metadata: { name: 'before-user-created' },
  user: { email, app_metadata: { provider, providers: [provider] } },
});

const accountOf = (id: string) => db.query<{ role: string }>('select role::text as role from public.accounts where user_id = $1', [id]).then((r) => r.rows);
const userExists = (id: string) => scalar<boolean>(db, 'select exists (select 1 from auth.users where id = $1)', [id]);

describe('allowed_emails', () => {
  it.each([
    ['uppercase', 'Upper@Example.test'],
    ['a leading space', ' space@example.test'],
    ['no @', 'no-at-sign'],
    ['a space inside', 'two words@example.test'],
  ])('refuses an address with %s', async (_, email) => {
    expect(await sqlState(() => db.query('insert into public.allowed_emails (email) values ($1)', [email]))).toBe('23514');
  });

  it('gives a listed address the member role unless it says otherwise', async () => {
    const email = address('default-role');
    await db.query('insert into public.allowed_emails (email) values ($1)', [email]);
    expect(await scalar<string>(db, 'select role::text from public.allowed_emails where email = $1', [email])).toBe('member');
  });

  it('cannot be read or written by anon or authenticated', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      expect(await sqlState(() => asRole(db, role, () => db.query('select * from public.allowed_emails')))).toBe('42501');
      expect(await sqlState(() => asRole(db, role, () => db.query("insert into public.allowed_emails (email) values ('x@example.test')")))).toBe('42501');
    }
  });
});

describe('before_user_created_hook', () => {
  it('lets a listed address through, for an email code and for OAuth, whatever its case and spacing', async () => {
    const email = address('listed');
    await allow(db, email);
    expect(await hook(event(email))).toEqual({});
    expect(await hook(event(`  ${email.toUpperCase()} `, 'google'))).toEqual({});
  });

  it('refuses an address off the list with a 403 Auth passes to the client', async () => {
    expect(await hook(event(address('stranger')))).toEqual(REFUSAL);
  });

  it.each([
    ['an empty address', { user: { email: '', phone: '15550100' } }],
    ['no address', { user: { phone: '15550100' } }],
    ['no user', {}],
  ])('refuses an event with %s (closed by default)', async (_, e) => {
    expect(await hook(e)).toEqual(REFUSAL);
  });

  it('refuses everyone without the policy: supabase_auth_admin does not bypass RLS', async () => {
    // The reason the policy exists. A mutant database without it reads an empty list.
    const mutant = await openDb();
    try {
      const email = address('listed');
      await allow(mutant, email);
      expect(await hook(event(email), mutant)).toEqual({});
      await mutant.exec('drop policy allowed_emails_read_by_auth on public.allowed_emails');
      expect(await hook(event(email), mutant)).toEqual(REFUSAL);
    } finally {
      await mutant.close();
    }
  }, FRESH_DB_TIMEOUT);

  it.each(['anon', 'authenticated', 'service_role'] as const)('cannot be called by %s through the Data API', async (role) => {
    const call = () => asRole(db, role, () => db.query('select public.before_user_created_hook($1::jsonb)', [JSON.stringify(event('x@example.test'))]));
    expect(await sqlState(call)).toBe('42501');
  });
});

describe('create_account trigger', () => {
  it('creates the account with the listed role when Auth inserts the user', async () => {
    const admin = address('admin');
    const member = address('member');
    await allow(db, { email: admin, role: 'admin' }, member);
    const adminId = await signUp(db, admin);
    // auth.users does not require a normalized address; the trigger normalizes it.
    const memberId = await signUp(db, member.toUpperCase());
    expect(await accountOf(adminId)).toEqual([{ role: 'admin' }]);
    expect(await accountOf(memberId)).toEqual([{ role: 'member' }]);
  });

  it('refuses a user off the list, as auth.admin.createUser would insert it without calling the hook', async () => {
    const id = crypto.randomUUID();
    const email = address('unlisted');
    let message = '';
    const state = await sqlState(async () => {
      try {
        await asRole(db, 'supabase_auth_admin', () => db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]));
      } catch (error) {
        message = error instanceof Error ? error.message : '';
        throw error;
      }
    });
    expect(state).toBe('42501');
    expect(await userExists(id)).toBe(false);
    // The message goes to the Auth logs: it names the id, never the address.
    expect(message).toContain(id);
    expect(message).not.toContain(email);
  });

  it('refuses a user with no address, such as a phone sign-up', async () => {
    expect(await sqlState(() => signUp(db, null, { phone: '15550101' }))).toBe('42501');
    expect(await scalar<number>(db, "select count(*)::int from auth.users where phone = '15550101'")).toBe(0);
  });

  it('keeps an existing user when its address leaves the list: the list gates sign-ups, not access', async () => {
    const email = address('removed');
    await allow(db, email);
    const id = await signUp(db, email);
    await asRole(db, 'service_role', () => db.query('delete from public.allowed_emails where email = $1', [email]));
    expect(await userExists(id)).toBe(true);
    expect(await accountOf(id)).toEqual([{ role: 'member' }]);
  });

  it('removes the account with the user', async () => {
    const email = address('deleted');
    await allow(db, email);
    const id = await signUp(db, email);
    await asRole(db, 'supabase_auth_admin', () => db.query('delete from auth.users where id = $1', [id]));
    expect(await accountOf(id)).toEqual([]);
  });

  it('lets any user in without the trigger, which is the gap it closes', async () => {
    const open = await openDb({ upTo: '0001' });
    try {
      await asRole(open, 'supabase_auth_admin', () => open.query('insert into auth.users (id, email) values ($1, $2)', [crypto.randomUUID(), address('anyone')]));
      expect(await scalar<number>(open, 'select count(*)::int from auth.users')).toBe(1);
    } finally {
      await open.close();
    }
  }, FRESH_DB_TIMEOUT);
});

describe('accounts', () => {
  let ana: string;
  let ben: string;

  beforeAll(async () => {
    const a = address('ana');
    const b = address('ben');
    await allow(db, { email: a, role: 'admin' }, b);
    ana = await signUp(db, a);
    ben = await signUp(db, b);
  });

  const asUser = <T>(sub: string | null, run: () => Promise<T>) =>
    asRole(db, 'authenticated', run, sub === null ? { role: 'authenticated' } : { sub, role: 'authenticated' });

  it('shows a user only its own account, even when it asks for another by id', async () => {
    const own = await asUser(ana, () => db.query<{ user_id: string }>('select user_id from public.accounts'));
    expect(own.rows).toEqual([{ user_id: ana }]);
    const other = await asUser(ana, () => db.query('select 1 from public.accounts where user_id = $1', [ben]));
    expect(other.rows).toEqual([]);
  });

  it('shows nothing to a token without a sub, and refuses anon', async () => {
    expect((await asUser(null, () => db.query('select 1 from public.accounts'))).rows).toEqual([]);
    expect(await sqlState(() => asRole(db, 'anon', () => db.query('select * from public.accounts')))).toBe('42501');
  });

  it('does not let a user change its role, create an account or delete one', async () => {
    expect(await sqlState(() => asUser(ben, () => db.query("update public.accounts set role = 'admin' where user_id = $1", [ben])))).toBe('42501');
    expect(await sqlState(() => asUser(ben, () => db.query('insert into public.accounts (user_id) values ($1)', [crypto.randomUUID()])))).toBe('42501');
    expect(await sqlState(() => asUser(ben, () => db.query('delete from public.accounts')))).toBe('42501');
  });

  it('lets the server change a role and stamps updated_at, but not move, create or delete an account', async () => {
    await db.query("update public.accounts set created_at = '2026-01-01T00:00:00Z', updated_at = '2026-01-01T00:00:00Z' where user_id = $1", [ben]);
    await asRole(db, 'service_role', () => db.query("update public.accounts set role = 'admin' where user_id = $1", [ben]));
    const row = await db.query<{ role: string; created_at: Date; updated_at: Date }>('select role::text as role, created_at, updated_at from public.accounts where user_id = $1', [ben]);
    expect(row.rows[0]?.role).toBe('admin');
    expect(row.rows[0]?.created_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row.rows[0]?.updated_at.getTime()).toBeGreaterThan(Date.parse('2026-01-02T00:00:00Z'));

    expect(await sqlState(() => asRole(db, 'service_role', () => db.query('update public.accounts set user_id = $1 where user_id = $2', [ana, ben])))).toBe('42501');
    expect(await sqlState(() => asRole(db, 'service_role', () => db.query('insert into public.accounts (user_id) values ($1)', [crypto.randomUUID()])))).toBe('42501');
    expect(await sqlState(() => asRole(db, 'service_role', () => db.query('delete from public.accounts')))).toBe('42501');
  });
});
