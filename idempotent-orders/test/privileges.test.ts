import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { key, openDb, seedProducts } from './helpers/db.ts';

let db: PGlite;
let widgetA: number;

beforeAll(async () => {
  db = await openDb();
  [widgetA] = await seedProducts(db, [{ name: 'Widget A', priceCents: 450, onHand: 10 }]);
}, 60_000);
afterAll(async () => {
  await db.close();
});

const FUNCTIONS = [
  'validate_lines(jsonb)',
  'order_fingerprint(jsonb)',
  'order_view(bigint)',
  'in_resend_window(timestamptz)',
  'resend_outcome(orders, text, text)',
  'validate_key(text)',
  'place_order(text, text, jsonb)',
  'find_order(text, text)',
  'edit_order(bigint, integer, jsonb)',
  'confirm_order(bigint, integer, text)',
  'get_order(bigint)',
];

async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('reset role');
  }
}

describe('privileges', () => {
  it.each(['anon', 'authenticated'])('takes back from %s every function and table Supabase grants by default', async (role) => {
    for (const fn of FUNCTIONS) {
      const r = await db.query<{ ok: boolean }>('select has_function_privilege($1, $2, \'execute\') as ok', [role, fn]);
      expect([fn, r.rows[0]?.ok]).toEqual([fn, false]);
    }
    for (const table of ['products', 'stock', 'orders', 'order_lines']) {
      const r = await db.query<{ ok: boolean }>(
        "select has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as ok",
        [role, table],
      );
      expect([table, r.rows[0]?.ok]).toEqual([table, false]);
    }
    for (const sequence of ['products_id_seq', 'orders_id_seq']) {
      const r = await db.query<{ ok: boolean }>("select has_sequence_privilege($1, $2, 'USAGE,SELECT,UPDATE') as ok", [role, sequence]);
      expect([sequence, r.rows[0]?.ok]).toEqual([sequence, false]);
    }
  });

  it('refuses place_order to anon', async () => {
    await expect(
      asRole('anon', () => db.query('select place_order($1, $2, $3::jsonb)', [key(), 'shop-1', JSON.stringify([{ product_id: widgetA, quantity: 1 }])])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lets the server role place and confirm', async () => {
    const r = await asRole('service_role', () =>
      db.query<{ r: { outcome: string; order: { id: number } } }>('select place_order($1, $2, $3::jsonb) as r', [
        key(),
        'shop-1',
        JSON.stringify([{ product_id: widgetA, quantity: 1 }]),
      ]),
    );
    expect(r.rows[0]?.r.outcome).toBe('placed');
    const id = r.rows[0]?.r.order.id;
    const c = await asRole('service_role', () => db.query<{ r: { outcome: string } }>('select confirm_order($1, 1, $2) as r', [id, key()]));
    expect(c.rows[0]?.r.outcome).toBe('confirmed');
  });

  it('turns on row level security on every table', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('products', 'stock', 'orders', 'order_lines') order by relname",
    );
    expect(r.rows.every((row) => row.relrowsecurity)).toBe(true);
    expect(r.rows).toHaveLength(4);
  });

  it('applies again over itself without errors', async () => {
    const { SCHEMA_SQL } = await import('./helpers/db.ts');
    await expect(db.exec(SCHEMA_SQL)).resolves.toBeDefined();
  });
});
