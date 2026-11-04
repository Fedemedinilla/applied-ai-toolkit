/**
 * Mutation check, opt-in and offline: `node supabase-auth-hardening/test/mutations.ts` from the
 * repository root. Each mutation reintroduces one gap in a copy of sql/, the suite runs against the
 * copy (through HARDENING_SQL_DIR), and the mutation must make it fail. The script exits 1 if any
 * mutation survives, or if a mutation no longer matches the SQL it was written for.
 *
 * Not a *.test.ts file, so `npm test` does not pick it up: seven full runs (one control and
 * six mutations) take about two minutes.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Mutation = { readonly name: string; readonly file: string; readonly from: string; readonly to: string };

const MUTATIONS: readonly Mutation[] = [
  // The control: an unchanged copy has to pass, or every "killed" below means nothing.
  { name: 'none (the copy as it is)', file: '0001_conventions.sql', from: '-- Conventions', to: '-- Conventions' },
  {
    name: 'match auth.users without lower()',
    file: '0005_otp_attempt_cap.sql',
    from: 'pg_catalog.lower(u.email) = v_email',
    to: 'u.email = v_email',
  },
  {
    name: "remove the hook's revoke",
    file: '0002_closed_signups.sql',
    from: 'revoke execute on function public.before_user_created_hook(jsonb) from public, anon, authenticated, service_role;',
    to: '',
  },
  {
    name: 'drop the email_change clause from the trigger',
    file: '0004_no_email_change.sql',
    from: "\n    or (new.email_change is distinct from old.email_change and new.email_change <> '')",
    to: '',
  },
  {
    name: 'fire the password trigger on insert only',
    file: '0003_no_passwords.sql',
    from: '\n  before insert or update of encrypted_password on auth.users',
    to: '\n  before insert on auth.users',
  },
  {
    name: 'use > instead of >= for the cap',
    file: '0005_otp_attempt_cap.sql',
    from: 'if v_used >= c_cap then',
    to: 'if v_used > c_cap then',
  },
  {
    name: 'a using (true) policy on accounts',
    file: '0002_closed_signups.sql',
    from: 'using (user_id = (select auth.uid()));',
    to: 'using (true);',
  },
];

const SQL_DIR = fileURLToPath(new URL('../sql/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let failed = false;
for (const mutation of MUTATIONS) {
  const copy = mkdtempSync(join(tmpdir(), 'auth-hardening-mutation-'));
  try {
    cpSync(SQL_DIR, copy, { recursive: true });
    const path = join(copy, mutation.file);
    const sql = readFileSync(path, 'utf8');
    if (sql.split(mutation.from).length !== 2) {
      console.log(`stale     ${mutation.name}: the text to change is not in ${mutation.file} exactly once`);
      failed = true;
      continue;
    }
    writeFileSync(path, sql.replace(mutation.from, mutation.to));
    const run = spawnSync('npx', ['vitest', 'run', 'supabase-auth-hardening'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HARDENING_SQL_DIR: copy },
      encoding: 'utf8',
    });
    const control = mutation.from === mutation.to;
    if (control) {
      console.log(`${run.status === 0 ? 'passed' : 'FAILED'}    ${mutation.name}`);
      if (run.status !== 0) failed = true;
    } else if (run.status === 0) {
      console.log(`survived  ${mutation.name}`);
      failed = true;
    } else {
      const summary = /Tests\s+(.*)/.exec(run.stdout)?.[1]?.trim() ?? `exit ${String(run.status)}`;
      console.log(`killed    ${mutation.name} (${summary})`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
process.exitCode = failed ? 1 : 0;
