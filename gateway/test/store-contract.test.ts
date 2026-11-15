/**
 * The store contract (helpers/store-contract.ts) over both implementations: the in-memory stores
 * and the Postgres adapter on a real Postgres in process (PGlite) with sql/schema.sql applied.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll } from 'vitest';
import { createMemoryStores } from '../src/memory-store.ts';
import { openDb, seedDb } from './helpers/pg.ts';
import { describeStoreContract } from './helpers/store-contract.ts';

describeStoreContract('memory', async (seed) => createMemoryStores({ tasks: seed.tasks, globalCaps: seed.globalCaps, accounts: seed.accounts, prices: seed.prices }));

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

describeStoreContract('postgres', async (seed) => seedDb(db, seed));
