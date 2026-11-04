import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, findOrder, injectTwinAfterLookup, key, openDb, orderOf, place, resetDb, seedProducts } from './helpers/db.ts';

let db: PGlite;
let widgetA: number;
let widgetC: number;
let widgetB: number;

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  [widgetA, widgetC, widgetB] = await seedProducts(db, [
    { name: 'Widget A', priceCents: 450, onHand: 20 },
    { name: 'Widget C', priceCents: 300, onHand: 20 },
    { name: 'Widget B', priceCents: 2200, onHand: 2 },
  ]);
});

const cart = () => [
  { product_id: widgetA, quantity: 2 },
  { product_id: widgetC, quantity: 1 },
];

describe('place_order', () => {
  it('places an order with prices read from products, not from the request', async () => {
    const r = await place(db, key(), 'shop-1', [{ product_id: widgetA, quantity: 2, unit_price_cents: 1 } as never]);
    expect(r['outcome']).toBe('placed');
    const order = orderOf(r);
    expect(order).toMatchObject({ status: 'pending', version: 1, total_cents: 900, customer_id: 'shop-1' });
    expect(order['lines']).toEqual([{ product_id: widgetA, quantity: 2, unit_price_cents: 450 }]);
  });

  it('answers a resend of the same order with that order and writes nothing', async () => {
    const k = key();
    const first = await place(db, k, 'shop-1', cart());
    // Same lines in another order: the fingerprint sorts by product.
    const again = await place(db, k, 'shop-1', [...cart()].reverse());
    expect(again['outcome']).toBe('already_placed');
    expect(orderOf(again).id).toBe(orderOf(first).id);
    expect(await count(db, 'orders')).toBe(1);
    expect(await count(db, 'order_lines')).toBe(2);
  });

  it('turns ten calls with one key, sent together, into one order', async () => {
    const k = key();
    const results = await Promise.all(Array.from({ length: 10 }, () => place(db, k, 'shop-1', cart())));
    expect(results.filter((r) => r['outcome'] === 'placed')).toHaveLength(1);
    expect(results.filter((r) => r['outcome'] === 'already_placed')).toHaveLength(9);
    expect(new Set(results.map((r) => orderOf(r).id)).size).toBe(1);
    expect(await count(db, 'orders')).toBe(1);
  });

  it('refuses a changed order under the same key and keeps the first one as it was', async () => {
    const k = key();
    const first = orderOf(await place(db, k, 'shop-1', cart()));
    const changed = await place(db, k, 'shop-1', [{ product_id: widgetA, quantity: 3 }, { product_id: widgetC, quantity: 1 }]);
    expect(changed['outcome']).toBe('key_reused');
    expect(orderOf(changed)).toMatchObject({ id: first.id, total_cents: 1200, fingerprint: `${widgetA}x2,${widgetC}x1` });
    const added = await place(db, k, 'shop-1', [...cart(), { product_id: widgetB, quantity: 1 }]);
    expect(added['outcome']).toBe('key_reused');
    expect(await count(db, 'orders')).toBe(1);
    expect(await count(db, 'order_lines')).toBe(2);
  });

  it("does not show another customer's order under a reused key", async () => {
    const k = key();
    await place(db, k, 'shop-1', cart());
    const other = await place(db, k, 'shop-2', cart());
    expect(other).toEqual({ outcome: 'key_taken' });
    expect(await findOrder(db, k, 'shop-2')).toEqual({ outcome: 'key_taken' });
    expect(await count(db, 'orders')).toBe(1);
  });

  it('does not answer a key older than 60 minutes as the same send', async () => {
    const k = key();
    const first = orderOf(await place(db, k, 'shop-1', cart()));
    await db.query("update orders set created_at = now() - interval '59 minutes' where id = $1", [first.id]);
    expect((await place(db, k, 'shop-1', cart()))['outcome']).toBe('already_placed');
    await db.query("update orders set created_at = now() - interval '61 minutes' where id = $1", [first.id]);
    const late = await place(db, k, 'shop-1', cart());
    expect(late).toMatchObject({ outcome: 'key_expired', why: 'age' });
    expect(await findOrder(db, k, 'shop-1')).toMatchObject({ outcome: 'found', within_window: false });
    expect(orderOf(late).id).toBe(first.id);
    expect(await count(db, 'orders')).toBe(1);
  });

  it('does not answer a key whose order was already confirmed as the same send', async () => {
    const k = key();
    const first = orderOf(await place(db, k, 'shop-1', cart()));
    await db.query('select confirm_order($1, 1, $2)', [first.id, key()]);
    expect(await place(db, k, 'shop-1', cart())).toMatchObject({ outcome: 'key_expired', why: 'not_pending' });
    expect(await findOrder(db, k, 'shop-1')).toMatchObject({ outcome: 'found', within_window: true });
  });

  it('compares a resend with the request that placed the order, not with lines edited since', async () => {
    const k = key();
    const first = orderOf(await place(db, k, 'shop-1', cart()));
    await db.query('select edit_order($1, 1, $2::jsonb)', [first.id, JSON.stringify([{ product_id: widgetB, quantity: 1 }])]);
    expect((await place(db, k, 'shop-1', cart()))['outcome']).toBe('already_placed');
  });

  it('reports unavailable products without writing, and only after the key lookup', async () => {
    await db.query('update products set active = false where id = $1', [widgetC]);
    const missing = await place(db, key(), 'shop-1', [...cart(), { product_id: 999, quantity: 1 }]);
    expect(missing).toEqual({ outcome: 'unavailable', product_ids: [widgetC, 999] });
    expect(await count(db, 'orders')).toBe(0);

    // An order that went in before the product was hidden is still found by its resend.
    await db.query('update products set active = true where id = $1', [widgetC]);
    const k = key();
    await place(db, k, 'shop-1', cart());
    await db.query('update products set active = false where id = $1', [widgetC]);
    expect((await place(db, k, 'shop-1', cart()))['outcome']).toBe('already_placed');
  });

  it.each([
    ['a short key', 'short', [{ product_id: 1, quantity: 1 }]],
    ['a key with a space', 'abcdefgh ijklmnop', [{ product_id: 1, quantity: 1 }]],
    ['no lines', null, []],
    ['a quantity of zero', null, [{ product_id: 1, quantity: 0 }]],
    ['a quantity as a string', null, [{ product_id: 1, quantity: '2' }]],
    ['a fractional quantity', null, [{ product_id: 1, quantity: 1.5 }]],
    ['a quantity over 9999', null, [{ product_id: 1, quantity: 10000 }]],
    ['a product twice', null, [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 2 }]],
    ['a line without product_id', null, [{ quantity: 1 }]],
    ['a line that is not an object', null, [1]],
  ])('raises 22023 for %s and writes nothing', async (_, badKey, lines) => {
    await expect(place(db, badKey ?? key(), 'shop-1', lines as never)).rejects.toMatchObject({ code: '22023' });
    expect(await count(db, 'orders')).toBe(0);
  });

  it('raises 22023 for 201 lines', async () => {
    const lines = Array.from({ length: 201 }, (_, i) => ({ product_id: i + 1, quantity: 1 }));
    await expect(place(db, key(), 'shop-1', lines)).rejects.toMatchObject({ code: '22023' });
  });
});

describe('the race between the lookup and the insert', () => {
  it('answers with the order the other transaction committed', async () => {
    const k = key();
    const undo = await injectTwinAfterLookup(db, { key: k, customer: 'shop-1', lines: cart() });
    try {
      const r = await place(db, k, 'shop-1', cart());
      expect(r['outcome']).toBe('already_placed');
      expect(await count(db, 'orders')).toBe(1);
      // The order is the twin: this call's insert and its lines were rolled back.
      expect(orderOf(r).total_cents).toBe(0);
    } finally {
      await undo();
    }
  });

  it('applies the resend rules to the twin: other lines under the key are key_reused', async () => {
    const k = key();
    const undo = await injectTwinAfterLookup(db, { key: k, customer: 'shop-1', lines: [{ product_id: widgetB, quantity: 1 }] });
    try {
      expect((await place(db, k, 'shop-1', cart()))['outcome']).toBe('key_reused');
      expect(await count(db, 'order_lines')).toBe(1);
    } finally {
      await undo();
    }
  });

  it('lets a unique violation of another constraint through as an error', async () => {
    await db.exec('alter table orders add constraint orders_one_per_customer unique (customer_id)');
    try {
      await place(db, key(), 'shop-1', cart());
      await expect(place(db, key(), 'shop-1', cart())).rejects.toMatchObject({ code: '23505', constraint: 'orders_one_per_customer' });
      expect(await count(db, 'orders')).toBe(1);
    } finally {
      await db.exec('alter table orders drop constraint orders_one_per_customer');
    }
  });

  it('leaves no order without lines when a line fails', async () => {
    // A product deleted between the price read and the line insert breaks the foreign key.
    await db.exec(`create function fail_lines() returns trigger language plpgsql as $$
      begin raise exception 'line rejected' using errcode = '23503'; end $$;
      create trigger fail_lines before insert on order_lines for each row execute function fail_lines();`);
    try {
      await expect(place(db, key(), 'shop-1', cart())).rejects.toMatchObject({ code: '23503' });
      expect(await count(db, 'orders')).toBe(0);
    } finally {
      await db.exec('drop trigger fail_lines on order_lines; drop function fail_lines();');
    }
  });
});

describe('find_order', () => {
  it('finds an order by key for its customer only', async () => {
    const k = key();
    const placed = orderOf(await place(db, k, 'shop-1', cart()));
    const found = await findOrder(db, k, 'shop-1');
    expect(found['outcome']).toBe('found');
    expect(orderOf(found)).toEqual(placed);
    expect(await findOrder(db, key(), 'shop-1')).toEqual({ outcome: 'not_found' });
  });
});
