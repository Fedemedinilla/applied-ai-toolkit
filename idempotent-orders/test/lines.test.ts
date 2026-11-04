import type { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprint, linesProblem, type OrderLine } from '../src/index.ts';
import { toSqlLines } from '../src/lines.ts';
import { openDb } from './helpers/db.ts';

let db: PGlite;

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});

const lineList = fc.uniqueArray(
  fc.record({ productId: fc.integer({ min: 1, max: 2 ** 40 }), quantity: fc.integer({ min: 1, max: 9999 }) }),
  { minLength: 1, maxLength: 30, selector: (l) => l.productId },
);

describe('fingerprint', () => {
  it('sorts by product id as a number', () => {
    expect(fingerprint([{ productId: 10, quantity: 1 }, { productId: 3, quantity: 2 }])).toBe('3x2,10x1');
  });

  it('matches order_fingerprint in SQL for any valid line list', async () => {
    await fc.assert(
      fc.asyncProperty(lineList, async (lines: OrderLine[]) => {
        const r = await db.query<{ fp: string }>('select order_fingerprint($1::jsonb) as fp', [JSON.stringify(toSqlLines(lines))]);
        expect(r.rows[0]?.fp).toBe(fingerprint(lines));
      }),
      { numRuns: 200 },
    );
  });

  it('accepts exactly what validate_lines accepts', async () => {
    const candidate = fc.array(
      fc.record({
        productId: fc.oneof(fc.integer({ min: -2, max: 5 }), fc.double({ min: 0, max: 5, noNaN: true })),
        quantity: fc.oneof(fc.integer({ min: -1, max: 10_001 }), fc.constant(1.5)),
      }),
      { maxLength: 4 },
    );
    await fc.assert(
      fc.asyncProperty(candidate, async (lines: OrderLine[]) => {
        const sqlAccepts = await db
          .query('select validate_lines($1::jsonb)', [JSON.stringify(toSqlLines(lines))])
          .then(() => true, (e: { code?: string }) => (e.code === '22023' ? false : Promise.reject(e)));
        expect(linesProblem(lines) === null).toBe(sqlAccepts);
      }),
      { numRuns: 300 },
    );
  });
});
