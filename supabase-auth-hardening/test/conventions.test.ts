import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_SQL, FRESH_DB_TIMEOUT, MIGRATIONS, openDb } from './helpers/db.ts';

let db: PGlite;

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});

const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;
const ROLES = ['anon', 'authenticated', 'service_role', 'supabase_auth_admin'] as const;

/** The table-level privileges `role` holds on `table`, in a fixed order. */
async function tablePrivileges(role: string, table: string): Promise<string[]> {
  const held: string[] = [];
  for (const privilege of TABLE_PRIVILEGES) {
    const r = await db.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, table, privilege]);
    if (r.rows[0]?.ok === true) held.push(privilege);
  }
  return held;
}

async function columnPrivileges(role: string, table: string, column: string): Promise<string[]> {
  const held: string[] = [];
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    const r = await db.query<{ ok: boolean }>('select has_column_privilege($1, $2, $3, $4) as ok', [role, table, column, privilege]);
    if (r.rows[0]?.ok === true) held.push(privilege);
  }
  return held;
}

async function canExecute(role: string, fn: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn]);
  return r.rows[0]?.ok === true;
}

async function audit(target: PGlite): Promise<{ violation: string; object: string }[]> {
  return (await target.query<{ violation: string; object: string }>(AUDIT_SQL)).rows;
}

describe('the migrations', () => {
  it('are numbered and applied in name order', () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual([
      '0001_conventions.sql',
      '0002_closed_signups.sql',
      '0003_no_passwords.sql',
      '0004_no_email_change.sql',
      '0005_otp_attempt_cap.sql',
    ]);
  });

  it('create exactly these objects in public, so a new one has to pass through this test', async () => {
    const tables = await db.query<{ n: string }>(
      "select relname::text as n from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'S', 'f') order by 1",
    );
    expect(tables.rows.map((r) => r.n)).toEqual(['accounts', 'allowed_emails', 'otp_attempts']);
    const functions = await db.query<{ n: string }>("select oid::regprocedure::text as n from pg_proc where pronamespace = 'public'::regnamespace order by 1");
    expect(functions.rows.map((r) => r.n)).toEqual([
      'before_user_created_hook(jsonb)',
      'block_email_change()',
      'create_account()',
      'discard_password()',
      'reserve_otp_attempt(text)',
      'set_updated_at()',
    ]);
    const enums = await db.query<{ n: string; labels: string[] }>(
      "select t.typname::text as n, array_agg(e.enumlabel::text order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typnamespace = 'public'::regnamespace group by t.typname order by 1",
    );
    expect(enums.rows).toEqual([
      { n: 'account_role', labels: ['admin', 'member'] },
      { n: 'otp_attempt_outcome', labels: ['recorded', 'exhausted', 'no_code'] },
    ]);
  });

  it('install the triggers on auth.users with the timing each control needs', async () => {
    const r = await db.query<{ tgname: string; fn: string; timing: string; events: string }>(`
      select t.tgname::text, t.tgfoid::regproc::text as fn,
             case when t.tgtype & 2 = 2 then 'before' else 'after' end as timing,
             concat_ws(',', case when t.tgtype & 4 = 4 then 'insert' end, case when t.tgtype & 16 = 16 then 'update' end) as events
      from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal order by 1`);
    expect(r.rows).toEqual([
      { tgname: 'block_email_change', fn: 'block_email_change', timing: 'before', events: 'update' },
      { tgname: 'create_account', fn: 'create_account', timing: 'after', events: 'insert' },
      { tgname: 'discard_password', fn: 'discard_password', timing: 'before', events: 'insert,update' },
    ]);
  });
});

describe('sql/audit.sql', () => {
  it('finds nothing in the migrated schema', async () => {
    expect(await audit(db)).toEqual([]);
  });

  it('reports a table and a function created the way Supabase leaves them by default', async () => {
    // The stub's default grants are Supabase's: this is what any object gets without the revokes.
    const scratch = await openDb();
    try {
      await scratch.exec(`
        create table public.notes (id uuid primary key, body text);
        create sequence public.counter;
        create function public.helper() returns int language sql as 'select 1';
      `);
      expect(await audit(scratch)).toEqual([
        { violation: 'anon has a privilege', object: 'counter' },
        { violation: 'anon has a privilege', object: 'notes' },
        { violation: 'anon or authenticated can execute', object: 'helper()' },
        { violation: 'authenticated can write', object: 'counter' },
        { violation: 'authenticated can write', object: 'notes' },
        { violation: 'function without an empty search_path', object: 'helper()' },
        { violation: 'service_role has TRUNCATE, REFERENCES, TRIGGER or MAINTAIN', object: 'notes' },
        { violation: 'table without a comment', object: 'notes' },
        { violation: 'table without row level security', object: 'notes' },
      ]);
    } finally {
      await scratch.close();
    }
  }, FRESH_DB_TIMEOUT);

  it.each(['anon', 'authenticated', 'service_role'] as const)('reports MAINTAIN left to %s on a table that is otherwise closed', async (role) => {
    // PostgreSQL 17 added MAINTAIN, and Supabase's default grant all includes it.
    const scratch = await openDb();
    try {
      await scratch.exec(`
        create table public.notes (id uuid primary key);
        alter table public.notes enable row level security;
        comment on table public.notes is 'Scratch table.';
        revoke all on table public.notes from public, anon, authenticated, service_role;
        grant maintain on table public.notes to ${role};
      `);
      const expected = {
        anon: 'anon has a privilege',
        authenticated: 'authenticated can write',
        service_role: 'service_role has TRUNCATE, REFERENCES, TRIGGER or MAINTAIN',
      }[role];
      expect(await audit(scratch)).toEqual([{ violation: expected, object: 'notes' }]);
    } finally {
      await scratch.close();
    }
  }, FRESH_DB_TIMEOUT);
});

describe('privileges', () => {
  it.each([
    ['allowed_emails', { anon: [], authenticated: [], service_role: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], supabase_auth_admin: ['SELECT'] }],
    ['accounts', { anon: [], authenticated: ['SELECT'], service_role: ['SELECT'], supabase_auth_admin: [] }],
    ['otp_attempts', { anon: [], authenticated: [], service_role: [], supabase_auth_admin: [] }],
  ] as const)('%s grants each role exactly what it uses', async (table, expected) => {
    for (const role of ROLES) {
      expect([role, await tablePrivileges(role, `public.${table}`)]).toEqual([role, expected[role]]);
    }
  });

  it('lets service_role change an account role and nothing else in accounts', async () => {
    expect(await columnPrivileges('service_role', 'public.accounts', 'role')).toEqual(['SELECT', 'UPDATE']);
    for (const column of ['user_id', 'created_at', 'updated_at']) {
      expect([column, await columnPrivileges('service_role', 'public.accounts', column)]).toEqual([column, ['SELECT']]);
    }
  });

  it.each([
    ['before_user_created_hook(jsonb)', ['supabase_auth_admin']],
    ['reserve_otp_attempt(text)', ['service_role']],
    ['create_account()', []],
    ['discard_password()', []],
    ['block_email_change()', []],
    ['set_updated_at()', []],
  ] as const)('%s is executable only by %j', async (fn, allowed) => {
    for (const role of ROLES) {
      expect([role, await canExecute(role, `public.${fn}`)]).toEqual([role, (allowed as readonly string[]).includes(role)]);
    }
    const r = await db.query<{ ok: boolean }>(
      "select exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as ok",
      [`public.${fn}`],
    );
    expect(r.rows[0]?.ok).toBe(false);
  });

  it('marks as security definer only the two functions that act for a caller without the privilege', async () => {
    const r = await db.query<{ n: string; definer: boolean }>(
      "select proname::text as n, prosecdef as definer from pg_proc where pronamespace = 'public'::regnamespace order by 1",
    );
    expect(r.rows).toEqual([
      { n: 'before_user_created_hook', definer: false },
      { n: 'block_email_change', definer: false },
      { n: 'create_account', definer: true },
      { n: 'discard_password', definer: false },
      { n: 'reserve_otp_attempt', definer: true },
      { n: 'set_updated_at', definer: false },
    ]);
  });

  it('turns on RLS with exactly one policy where a role reads through RLS, and none on otp_attempts', async () => {
    const r = await db.query<{ table: string; policy: string; roles: string[]; cmd: string }>(
      "select tablename::text as table, policyname::text as policy, roles::text[] as roles, cmd from pg_policies where schemaname = 'public' order by 1",
    );
    expect(r.rows).toEqual([
      { table: 'accounts', policy: 'accounts_read_own', roles: ['authenticated'], cmd: 'SELECT' },
      { table: 'allowed_emails', policy: 'allowed_emails_read_by_auth', roles: ['supabase_auth_admin'], cmd: 'SELECT' },
    ]);
  });
});
