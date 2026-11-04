/**
 * A real Postgres (PGlite, in process) set up like a Supabase project, with this folder's
 * migrations applied in order. `auth-stub.sql` creates the roles, Supabase's default grants on
 * public and the parts of the auth schema the migrations use, so the revokes are tested against
 * the grants they undo and the triggers fire on the same table Auth writes to.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

/** This folder's sql/, or the copy `test/mutations.ts` points the suite at. */
const SQL_DIR = process.env['HARDENING_SQL_DIR'] === undefined ? new URL('../../sql/', import.meta.url) : pathToFileURL(`${process.env['HARDENING_SQL_DIR']}/`);

export const AUTH_STUB_SQL = readFileSync(new URL('./auth-stub.sql', import.meta.url), 'utf8');
export const AUDIT_SQL = readFileSync(new URL('audit.sql', SQL_DIR), 'utf8');

/** The migrations in the order Supabase would apply them: by file name. */
export const MIGRATIONS: readonly { readonly name: string; readonly sql: string }[] = readdirSync(SQL_DIR)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, SQL_DIR), 'utf8') }));

/**
 * Timeout for a test that opens its own database. Starting PGlite and applying the stub and the
 * migrations can pass Vitest's 5 s default on a loaded machine (seen at a load average of 10).
 */
export const FRESH_DB_TIMEOUT = 60_000;

export type Role = 'anon' | 'authenticated' | 'service_role' | 'supabase_auth_admin';

/**
 * Opens a database with the stub and the migrations. `upTo` stops after the migration whose name
 * starts with it, for tests that show a gap is open before the control that closes it.
 */
export async function openDb(options: { upTo?: string } = {}): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(AUTH_STUB_SQL);
  for (const migration of MIGRATIONS) {
    await db.exec(migration.sql);
    if (options.upTo !== undefined && migration.name.startsWith(options.upTo)) break;
  }
  return db;
}

/**
 * Runs `run` as `role`, optionally with the JWT claims PostgREST would set for a session, and always
 * goes back to the superuser, also when `run` throws.
 */
export async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>, claims?: Record<string, unknown>): Promise<T> {
  if (claims !== undefined) {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  }
  await db.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('reset role');
    await db.exec('reset request.jwt.claims');
  }
}

/** The first column of the first row. Throws when there is no row, so a test cannot read undefined as a result. */
export async function scalar<T>(db: PGlite, sql: string, params: readonly unknown[] = []): Promise<T> {
  const result = await db.query<Record<string, T>>(sql, [...params]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no row from: ${sql}`);
  const [value] = Object.values(row);
  return value as T;
}

/** The SQLSTATE of the error `run` throws, or null if it does not throw. */
export async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
    throw error;
  }
}

/** Adds addresses to the list as the server would, with an optional role. */
export async function allow(db: PGlite, ...entries: readonly (string | { email: string; role: 'admin' | 'member' })[]): Promise<void> {
  for (const entry of entries) {
    const { email, role } = typeof entry === 'string' ? { email: entry, role: 'member' } : entry;
    await asRole(db, 'service_role', () => db.query('insert into public.allowed_emails (email, role) values ($1, $2)', [email, role]));
  }
}

/**
 * Inserts a user the way Auth does: as supabase_auth_admin, the role Auth connects as. Returns the
 * new id. `password` is the hash Auth would write (a fake bcrypt string is enough for the trigger).
 */
export async function signUp(db: PGlite, email: string | null, options: { password?: string; phone?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await asRole(db, 'supabase_auth_admin', () =>
    db.query("insert into auth.users (id, aud, role, email, encrypted_password, phone, email_change, created_at) values ($1, 'authenticated', 'authenticated', $2, $3, $4, '', now())", [
      id,
      email,
      options.password ?? null,
      options.phone ?? null,
    ]),
  );
  return id;
}

/** A unique address under the reserved .test domain. */
export const address = (label: string): string => `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;

/** A fake bcrypt hash, the shape Auth stores. */
export const FAKE_BCRYPT = '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
