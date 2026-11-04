import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { address, allow, asRole, openDb, scalar, signUp, sqlState } from './helpers/db.ts';

let db: PGlite;

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec('delete from public.otp_attempts');
});

type Outcome = 'recorded' | 'exhausted' | 'no_code';

/** Calls the function as the application server does: with the secret key, as service_role. */
const reserve = (email: string | null) =>
  asRole(db, 'service_role', () => scalar<Outcome>(db, 'select public.reserve_otp_attempt($1)::text', [email]));

async function reserveTimes(email: string, n: number): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (let i = 0; i < n; i += 1) out.push(await reserve(email));
  return out;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
const rowsFor = (email: string) => scalar<number>(db, 'select count(*)::int from public.otp_attempts where email_hash = $1', [sha256(email)]);

/** A listed address with a user, as after its first code. */
async function user(label: string): Promise<string> {
  const email = address(label);
  await allow(db, email);
  await signUp(db, email);
  return email;
}

describe('reserve_otp_attempt', () => {
  it('records 20 attempts in 24 hours, then answers exhausted without recording', async () => {
    const email = await user('ana');
    expect(await reserveTimes(email, 20)).toEqual(Array<Outcome>(20).fill('recorded'));
    expect(await reserve(email)).toBe('exhausted');
    expect(await reserve(email)).toBe('exhausted');
    expect(await rowsFor(email)).toBe(20);
  });

  it('treats another case or spacing of the address as the same address', async () => {
    const email = await user('case');
    await reserveTimes(email, 20);
    expect(await reserve(`  ${email.toUpperCase()} `)).toBe('exhausted');
  });

  it('counts each address on its own', async () => {
    const a = await user('first');
    const b = await user('second');
    await reserveTimes(a, 20);
    expect(await reserve(b)).toBe('recorded');
  });

  it('answers no_code for an address neither listed nor a user, and records nothing for it', async () => {
    const made = Array.from({ length: 30 }, (_, i) => address(`made-up-${i}`));
    for (const email of made) expect(await reserve(email)).toBe('no_code');
    expect(await scalar<number>(db, 'select count(*)::int from public.otp_attempts')).toBe(0);
  });

  it('counts a listed address before its user exists, so the first code is not an uncounted window', async () => {
    const email = address('listed-only');
    await allow(db, email);
    expect(await reserveTimes(email, 20)).toEqual(Array<Outcome>(20).fill('recorded'));
    expect(await reserve(email)).toBe('exhausted');
  });

  it('keeps counting a user whose address left the list, matched in lowercase against auth.users', async () => {
    const email = address('dora');
    await allow(db, email);
    // auth.users keeps the address as it arrived; the trigger found it on the list in lowercase.
    await signUp(db, email.toUpperCase());
    await asRole(db, 'service_role', () => db.query('delete from public.allowed_emails where email = $1', [email]));
    expect([await reserve(email), await reserve(` ${email.replace('dora', 'Dora')}`)]).toEqual(['recorded', 'recorded']);
    expect(await rowsFor(email)).toBe(2);
  });

  it('stores the sha256 of the normalized address and never the address', async () => {
    const email = await user('hash');
    await reserve(`  ${email.toUpperCase()}`);
    expect(await rowsFor(email)).toBe(1);
    // No column could hold the address: only the id, the hash and the time.
    const columns = await db.query<{ name: string; type: string }>(
      "select attname::text as name, format_type(atttypid, atttypmod) as type from pg_attribute where attrelid = 'public.otp_attempts'::regclass and attnum > 0 and not attisdropped order by attnum",
    );
    expect(columns.rows.map((c) => c.type).sort()).toEqual(['bytea', 'timestamp with time zone', 'uuid']);
    expect(await sqlState(() => db.query("insert into public.otp_attempts (email_hash) values ('\\x00'::bytea)"))).toBe('23514');
  });

  it('frees a slot for each attempt older than 24 hours, and deletes those rows', async () => {
    const email = await user('window');
    await reserveTimes(email, 20);
    await db.query("update public.otp_attempts set created_at = now() - interval '25 hours' where id in (select id from public.otp_attempts where email_hash = $1 limit 5)", [sha256(email)]);
    expect(await reserveTimes(email, 6)).toEqual(['recorded', 'recorded', 'recorded', 'recorded', 'recorded', 'exhausted']);
    expect(await scalar<number>(db, "select count(*)::int from public.otp_attempts where created_at < now() - interval '24 hours'")).toBe(0);
  });

  it('counts an attempt exactly 24 hours old as still inside the window', async () => {
    const email = await user('edge');
    await reserveTimes(email, 20);
    // now() is the transaction time, so a row dated now() - 24h inside the same transaction is at the edge.
    await db.exec('begin');
    try {
      await db.query("update public.otp_attempts set created_at = now() - interval '24 hours' where id = (select id from public.otp_attempts where email_hash = $1 limit 1)", [sha256(email)]);
      expect(await reserve(email)).toBe('exhausted');
    } finally {
      await db.exec('rollback');
    }
  });

  it('holds an advisory lock for the address until the transaction ends', async () => {
    const email = await user('lock');
    const advisoryLocks = () => scalar<number>(db, "select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()");
    await db.exec('begin');
    try {
      await reserve(email);
      expect(await advisoryLocks()).toBe(1);
    } finally {
      await db.exec('commit');
    }
    expect(await advisoryLocks()).toBe(0);
  });

  it.each([null, '', '   '])('refuses a missing address (%j) with 22004', async (email) => {
    expect(await sqlState(() => reserve(email))).toBe('22004');
  });

  it('is closed to anon and authenticated, and service_role cannot read or edit the count', async () => {
    const email = await user('closed');
    for (const role of ['anon', 'authenticated'] as const) {
      expect(await sqlState(() => asRole(db, role, () => db.query('select public.reserve_otp_attempt($1)', [email])))).toBe('42501');
    }
    for (const sql of ['select * from public.otp_attempts', 'delete from public.otp_attempts', "insert into public.otp_attempts (email_hash) values (sha256('x'))"]) {
      expect([sql, await sqlState(() => asRole(db, 'service_role', () => db.query(sql)))]).toEqual([sql, '42501']);
    }
  });
});
