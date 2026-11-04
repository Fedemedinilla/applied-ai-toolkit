// PGlite has one backend: calls sent together with Promise.all run interleaved whole, never
// overlapped. Real lock waits on a real Postgres are covered by the opt-in sql/race.sh.

import type { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { confirm, count, edit, key, onHand, openDb, orderOf, place, resetDb, seedProducts } from './helpers/db.ts';

let db: PGlite;
let widgetA: number;
let widgetB: number;

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  [widgetA, widgetB] = await seedProducts(db, [
    { name: 'Widget A', priceCents: 450, onHand: 10 },
    { name: 'Widget B', priceCents: 2200, onHand: 3 },
  ]);
});

async function placed(lines = [{ product_id: widgetA, quantity: 4 }, { product_id: widgetB, quantity: 1 }]): Promise<number> {
  return orderOf(await place(db, key(), 'shop-1', lines)).id;
}

describe('confirm_order', () => {
  it('claims a pending order and takes its stock', async () => {
    const id = await placed();
    const r = await confirm(db, id, 1, key());
    expect(r['outcome']).toBe('confirmed');
    expect(orderOf(r).status).toBe('confirmed');
    expect(await onHand(db, widgetA)).toBe(6);
    expect(await onHand(db, widgetB)).toBe(2);
  });

  it('lets one of two interleaved confirms win and takes the stock once', async () => {
    const id = await placed();
    const [a, b] = await Promise.all([confirm(db, id, 1, key()), confirm(db, id, 1, key())]);
    expect([a['outcome'], b['outcome']].sort()).toEqual(['confirmed', 'not_pending']);
    expect(await onHand(db, widgetA)).toBe(6);
    expect(await onHand(db, widgetB)).toBe(2);
  });

  it('answers a resend of the winning confirm as already_confirmed, without taking stock again', async () => {
    const id = await placed();
    const k = key();
    await confirm(db, id, 1, k);
    const again = await confirm(db, id, 1, k);
    expect(again['outcome']).toBe('already_confirmed');
    expect(orderOf(again).confirm_key).toBe(k);
    expect(await onHand(db, widgetA)).toBe(6);
  });

  it('refuses a confirm made on a version that was edited since', async () => {
    const id = await placed();
    await edit(db, id, 1, [{ product_id: widgetA, quantity: 9 }]);
    const stale = await confirm(db, id, 1, key());
    expect(stale).toEqual({ outcome: 'version_conflict', current_version: 2 });
    expect(await onHand(db, widgetA)).toBe(10);
    expect((await confirm(db, id, 2, key()))['outcome']).toBe('confirmed');
    expect(await onHand(db, widgetA)).toBe(1);
  });

  it('refuses an order it cannot cover and writes nothing', async () => {
    const id = await placed([{ product_id: widgetA, quantity: 2 }, { product_id: widgetB, quantity: 5 }]);
    const r = await confirm(db, id, 1, key());
    expect(r).toEqual({ outcome: 'insufficient_stock', shortages: [{ product_id: widgetB, requested: 5, on_hand: 3 }] });
    expect(await onHand(db, widgetA)).toBe(10);
    const status = await db.query<{ status: string }>('select status from orders where id = $1', [id]);
    expect(status.rows[0]?.status).toBe('pending');
  });

  it('treats a product without a stock row as having none', async () => {
    const id = await placed([{ product_id: widgetB, quantity: 1 }]);
    await db.query('delete from stock where product_id = $1', [widgetB]);
    expect(await confirm(db, id, 1, key())).toEqual({
      outcome: 'insufficient_stock',
      shortages: [{ product_id: widgetB, requested: 1, on_hand: 0 }],
    });
  });

  it('answers not_found for an order that does not exist', async () => {
    expect(await confirm(db, 999, 1, key())).toEqual({ outcome: 'not_found' });
  });

  it('never lets stock go below zero, whatever the mix of interleaved confirms', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ widgetA: fc.integer({ min: 0, max: 6 }), widgetB: fc.integer({ min: 0, max: 3 }) }), { minLength: 1, maxLength: 8 }),
        async (orders) => {
          await resetDb(db);
          [widgetA, widgetB] = await seedProducts(db, [
            { name: 'Widget A', priceCents: 450, onHand: 10 },
            { name: 'Widget B', priceCents: 2200, onHand: 3 },
          ]);
          const ids: number[] = [];
          for (const o of orders) {
            const lines = [
              ...(o.widgetA ? [{ product_id: widgetA, quantity: o.widgetA }] : []),
              ...(o.widgetB ? [{ product_id: widgetB, quantity: o.widgetB }] : []),
            ];
            if (lines.length) ids.push(await placed(lines));
          }
          // Each order confirmed twice at once, from two screens.
          const results = await Promise.all(ids.flatMap((id) => [confirm(db, id, 1, key()), confirm(db, id, 1, key())]));
          const confirmed = await db.query<{ product_id: number; taken: number }>(
            `select l.product_id, sum(l.quantity)::int as taken
               from order_lines l join orders o on o.id = l.order_id
              where o.status = 'confirmed' group by l.product_id`,
          );
          const taken = new Map(confirmed.rows.map((r) => [Number(r.product_id), Number(r.taken)]));
          expect(await onHand(db, widgetA)).toBe(10 - (taken.get(widgetA) ?? 0));
          expect(await onHand(db, widgetB)).toBe(3 - (taken.get(widgetB) ?? 0));
          expect(await onHand(db, widgetA)).toBeGreaterThanOrEqual(0);
          expect(await onHand(db, widgetB)).toBeGreaterThanOrEqual(0);
          expect(results.filter((r) => r['outcome'] === 'confirmed').length).toBeLessThanOrEqual(ids.length);
        },
      ),
      { numRuns: 25 },
    );
  }, 60_000);

  it('keeps the check constraint as the last line of defense', async () => {
    await expect(db.query('update stock set on_hand = on_hand - 11 where product_id = $1', [widgetA])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('raises 22023 for an invalid confirm key', async () => {
    const id = await placed();
    await expect(confirm(db, id, 1, 'nope')).rejects.toMatchObject({ code: '22023' });
  });
});

describe('edit_order', () => {
  it('replaces the lines, recomputes the total and bumps the version', async () => {
    const id = await placed();
    const r = await edit(db, id, 1, [{ product_id: widgetB, quantity: 2 }]);
    expect(r['outcome']).toBe('edited');
    expect(orderOf(r)).toMatchObject({ version: 2, total_cents: 4400, lines: [{ product_id: widgetB, quantity: 2, unit_price_cents: 2200 }] });
  });

  it('refuses an edit built on an old version and writes nothing', async () => {
    const id = await placed();
    await edit(db, id, 1, [{ product_id: widgetB, quantity: 2 }]);
    expect(await edit(db, id, 1, [{ product_id: widgetA, quantity: 1 }])).toEqual({ outcome: 'version_conflict', current_version: 2 });
    expect(await count(db, 'order_lines')).toBe(1);
  });

  it('lets one of two interleaved edits on the same version win', async () => {
    const id = await placed();
    const [a, b] = await Promise.all([
      edit(db, id, 1, [{ product_id: widgetB, quantity: 1 }]),
      edit(db, id, 1, [{ product_id: widgetA, quantity: 1 }]),
    ]);
    expect([a['outcome'], b['outcome']].sort()).toEqual(['edited', 'version_conflict']);
  });

  it('refuses to edit a confirmed order', async () => {
    const id = await placed();
    await confirm(db, id, 1, key());
    expect(await edit(db, id, 2, [{ product_id: widgetB, quantity: 1 }])).toEqual({ outcome: 'not_pending', status: 'confirmed' });
  });

  it('refuses an empty edit with 22023 and unavailable products without writing', async () => {
    const id = await placed();
    await expect(edit(db, id, 1, [])).rejects.toMatchObject({ code: '22023' });
    await db.query('update products set active = false where id = $1', [widgetB]);
    expect(await edit(db, id, 1, [{ product_id: widgetB, quantity: 1 }])).toEqual({ outcome: 'unavailable', product_ids: [widgetB] });
    expect(await count(db, 'order_lines')).toBe(2);
  });

  it('answers not_found for an order that does not exist', async () => {
    expect(await edit(db, 999, 1, [{ product_id: widgetB, quantity: 1 }])).toEqual({ outcome: 'not_found' });
  });
});
