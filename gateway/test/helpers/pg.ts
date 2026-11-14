/**
 * A real Postgres in process (PGlite) with sql/schema.sql applied, and the fixtures of
 * fake-stores.ts loaded through plain SQL. PGlite has one connection, so statements never overlap
 * inside the database; what the tests exercise is the SQL as written and the interleaving of the
 * gateway's own steps between statements.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresStores, type PgQueryable, type PostgresStores } from '../../src/postgres-store.ts';

const SCHEMA_SQL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');

export async function openDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SCHEMA_SQL);
  return db;
}

export interface PgSeed {
  readonly prices: ReadonlyArray<{ model: string; validFrom: string; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }>;
  readonly tasks: ReadonlyArray<{ task: string; model: string; effort: string; hardCaseEffort: string | null }>;
  readonly globalCaps: { perJobUsd: number; dailyPerUserUsd: number; monthlyUsd: number };
  readonly accounts: Readonly<Record<string, { perJobUsd: number | null; dailyPerUserUsd: number | null }>>;
}

/** Empties every table and loads the seed. Prices go first: a task needs a price in force for its model. */
export async function seedDb(db: PGlite, seed: PgSeed, client: PgQueryable = db): Promise<PostgresStores> {
  await db.exec('truncate public.llm_usage, public.llm_task_config, public.llm_account_caps, public.llm_global_caps, public.model_prices');
  const stores = createPostgresStores(client);
  await stores.loadPrices(seed.prices.map((row) => ({ ...row, source: 'test fixture' })));
  for (const t of seed.tasks) {
    await db.query('insert into public.llm_task_config (task, model, effort, hard_case_effort) values ($1, $2, $3, $4)', [t.task, t.model, t.effort, t.hardCaseEffort]);
  }
  const g = seed.globalCaps;
  await db.query('insert into public.llm_global_caps (per_job_usd, daily_per_user_usd, monthly_usd) values ($1, $2, $3)', [g.perJobUsd, g.dailyPerUserUsd, g.monthlyUsd]);
  for (const [userId, caps] of Object.entries(seed.accounts)) {
    await db.query('insert into public.llm_account_caps (user_id, per_job_usd, daily_per_user_usd) values ($1, $2, $3)', [userId, caps.perJobUsd, caps.dailyPerUserUsd]);
  }
  return stores;
}

export interface LedgerRow {
  readonly id: string;
  readonly reservation: boolean;
  readonly replaces: string | null;
  readonly incomplete: boolean;
  readonly costUsd: number | null;
  readonly errorCode: string | null;
  readonly modelResponded: string | null;
  readonly inputTokens: number;
  readonly estimatedInputTokens: number | null;
}

/** The ledger in insertion order, with the columns the tests look at. */
export async function ledger(db: PGlite): Promise<LedgerRow[]> {
  const result = await db.query<LedgerRow>(
    `select id, reservation, replaces, incomplete, cost_usd::float8 as "costUsd", error_code as "errorCode", model_responded as "modelResponded",
       input_tokens as "inputTokens", estimated_input_tokens as "estimatedInputTokens"
     from public.llm_usage order by created_at, reservation desc`,
  );
  return result.rows;
}

export async function openReservations(db: PGlite): Promise<number> {
  const result = await db.query<{ open: number }>(
    'select count(*)::integer as open from public.llm_usage as u where u.reservation and not exists (select 1 from public.llm_usage as r where r.replaces = u.id)',
  );
  return result.rows[0]?.open ?? -1;
}
