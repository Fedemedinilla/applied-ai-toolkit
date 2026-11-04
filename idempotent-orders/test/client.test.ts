import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrdersClient, type OrdersClientOptions, type PlaceRequest } from '../src/index.ts';
import { count, key, onHand, openDb, orderOf, place, resetDb, seedProducts } from './helpers/db.ts';
import { FakePostgrest } from './helpers/fake-postgrest.ts';

let db: PGlite;
let fake: FakePostgrest;
let widgetA: number;
let widgetB: number;
let sleeps: number[];

beforeAll(async () => {
  db = await openDb();
  fake = new FakePostgrest(db);
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  fake.reset();
  sleeps = [];
  [widgetA, widgetB] = await seedProducts(db, [
    { name: 'Widget A', priceCents: 450, onHand: 10 },
    { name: 'Widget B', priceCents: 2200, onHand: 3 },
  ]);
});

function client(overrides: Partial<OrdersClientOptions> = {}) {
  return createOrdersClient({
    url: 'https://db.example.test/rest/v1/',
    headers: { apikey: 'test-key' },
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...overrides,
  });
}

const request = (k = key()): PlaceRequest => ({
  key: k,
  customerId: 'shop-1',
  lines: [
    { productId: widgetA, quantity: 2 },
    { productId: widgetB, quantity: 1 },
  ],
});

describe('placeOrder', () => {
  it('places an order on the first attempt', async () => {
    const r = await client().placeOrder(request());
    expect(r).toMatchObject({ kind: 'placed', requests: 1, order: { totalCents: 3100, status: 'pending', version: 1 } });
    expect(fake.requests[0]?.args).toMatchObject({ p_customer: 'shop-1', p_lines: [{ product_id: widgetA, quantity: 2 }, { product_id: widgetB, quantity: 1 }] });
  });

  it.each(['drop-after-commit', 'gateway-timeout-after-commit', 'truncated-after-commit', 'wrong-shape-after-commit'] as const)(
    'retries after %s and reports the order the lost attempt placed',
    async (fault) => {
      fake.fail('place_order', fault);
      const r = await client().placeOrder(request());
      expect(r).toMatchObject({ kind: 'already_placed', afterLostResponse: true, via: 'resend', requests: 2 });
      expect(await count(db, 'orders')).toBe(1);
    },
  );

  it('retries a request that never reached the database, and places it', async () => {
    fake.fail('place_order', 'drop-before', { status: 503 });
    const r = await client().placeOrder(request());
    expect(r).toMatchObject({ kind: 'placed', requests: 3 });
    expect(await count(db, 'orders')).toBe(1);
  });

  it('reads the order back by key when every attempt loses its response', async () => {
    fake.failAlways('place_order', 'drop-after-commit');
    const r = await client().placeOrder(request());
    expect(r).toMatchObject({ kind: 'already_placed', afterLostResponse: true, via: 'reread', requests: 4 });
    expect(fake.count('place_order')).toBe(3);
    expect(fake.count('find_order')).toBe(1);
    expect(await count(db, 'orders')).toBe(1);
  });

  it('says unknown, and keeps the key usable, when nothing can be confirmed', async () => {
    fake.failAlways('place_order', 'drop-before');
    fake.fail('find_order', 'drop-before');
    const k = key();
    const r = await client().placeOrder(request(k));
    expect(r).toEqual({ kind: 'unknown', key: k, reason: 'retries_exhausted', requests: 4 });
    // The next tap, with the same key, once the connection is back.
    fake.reset();
    expect(await client().placeOrder(request(k))).toMatchObject({ kind: 'placed' });
    expect(await count(db, 'orders')).toBe(1);
  });

  it('says unknown when the re-read finds nothing: a lost attempt may still commit', async () => {
    fake.failAlways('place_order', { status: 502 });
    const r = await client().placeOrder(request());
    expect(r).toMatchObject({ kind: 'unknown', reason: 'retries_exhausted' });
    expect(fake.count('find_order')).toBe(1);
  });

  it('does not retry a refusal, and maps a missing function to not_deployed', async () => {
    fake.fail('place_order', { status: 400, body: { code: '22023', message: 'echoed request text' } });
    expect(await client().placeOrder(request())).toEqual({ kind: 'rejected', reason: 'refused', status: 400, code: '22023', requests: 1 });
    fake.missing.add('place_order');
    expect(await client().placeOrder(request())).toEqual({
      kind: 'rejected',
      reason: 'not_deployed',
      status: 404,
      code: 'PGRST202',
      requests: 1,
    });
    expect(fake.count('place_order')).toBe(2);
  });

  it('lets the re-read decide when a refusal follows a lost response', async () => {
    // The first attempt committed; then the function disappears (a rollback of the deploy).
    fake.fail('place_order', 'drop-after-commit', { status: 404, body: { code: 'PGRST202' } });
    const r = await client().placeOrder(request());
    expect(r).toMatchObject({ kind: 'already_placed', via: 'reread' });
  });

  it('refuses a changed cart under the same key and says the change was not saved', async () => {
    const k = key();
    await client().placeOrder(request(k));
    const changed = await client().placeOrder({ ...request(k), lines: [{ productId: widgetA, quantity: 5 }] });
    expect(changed).toMatchObject({ kind: 'rejected', reason: 'key_reused', order: { fingerprint: `${widgetA}x2,${widgetB}x1` } });
    expect(await count(db, 'orders')).toBe(1);
  });

  it('treats a changed cart found by the re-read as key_reused, not as placed', async () => {
    const k = key();
    await place(db, k, 'shop-1', [{ product_id: widgetB, quantity: 1 }]);
    fake.failAlways('place_order', 'drop-before');
    expect(await client().placeOrder(request(k))).toMatchObject({ kind: 'rejected', reason: 'key_reused', requests: 4 });
  });

  it('reports a lost placement that was confirmed before the resend as placed by this call', async () => {
    fake.fail('place_order', 'drop-after-commit', { status: 503 });
    const lostThenConfirmed = client({
      sleep: async () => {
        // Between the attempts, someone confirms the order the lost attempt placed.
        const id = (await db.query<{ id: number }>('select id from orders')).rows[0]?.id;
        if (id !== undefined) await db.query('select confirm_order($1, 1, $2)', [id, key()]).catch(() => undefined);
      },
    });
    expect(await lostThenConfirmed.placeOrder(request())).toMatchObject({ kind: 'already_placed', afterLostResponse: true });
  });

  it('keeps the 60-minute rule after a lost attempt: an old order under the key is not this call', async () => {
    const k = key();
    const old = orderOf(await place(db, k, 'shop-1', [{ product_id: widgetA, quantity: 2 }, { product_id: widgetB, quantity: 1 }]));
    await db.query("update orders set created_at = now() - interval '61 minutes' where id = $1", [old.id]);
    fake.fail('place_order', { status: 503 });
    expect(await client().placeOrder(request(k))).toMatchObject({ kind: 'rejected', reason: 'key_expired', why: 'age', requests: 2 });
    // The same order confirmed inside the window is still rejected outside it.
    await db.query('select confirm_order($1, 1, $2)', [old.id, key()]);
    fake.reset();
    fake.fail('place_order', { status: 503 });
    expect(await client().placeOrder(request(k))).toMatchObject({ kind: 'rejected', reason: 'key_expired', why: 'age' });
    expect(await count(db, 'orders')).toBe(1);
  });

  it('keeps the 60-minute rule in the re-read', async () => {
    const k = key();
    const old = orderOf(await place(db, k, 'shop-1', [{ product_id: widgetA, quantity: 2 }, { product_id: widgetB, quantity: 1 }]));
    await db.query("update orders set created_at = now() - interval '61 minutes' where id = $1", [old.id]);
    fake.failAlways('place_order', { status: 503 });
    expect(await client().placeOrder(request(k))).toMatchObject({ kind: 'rejected', reason: 'key_expired', why: 'age', requests: 4 });
  });

  it('reports a confirmed order found by the re-read inside the window as this call\'s', async () => {
    const k = key();
    const id = orderOf(await place(db, k, 'shop-1', [{ product_id: widgetA, quantity: 2 }, { product_id: widgetB, quantity: 1 }])).id;
    await db.query('select confirm_order($1, 1, $2)', [id, key()]);
    fake.failAlways('place_order', 'drop-before');
    expect(await client().placeOrder(request(k))).toMatchObject({ kind: 'already_placed', via: 'reread', order: { status: 'confirmed' } });
  });

  it('answers a confirmed order with no lost attempt as key_expired, not_pending', async () => {
    const k = key();
    const id = orderOf(await place(db, k, 'shop-1', [{ product_id: widgetA, quantity: 2 }, { product_id: widgetB, quantity: 1 }])).id;
    await db.query('select confirm_order($1, 1, $2)', [id, key()]);
    expect(await client().placeOrder(request(k))).toMatchObject({ kind: 'rejected', reason: 'key_expired', why: 'not_pending', requests: 1 });
  });

  it('joins a double tap in the same process into one request', async () => {
    const c = client();
    const r = request();
    const [a, b] = await Promise.all([c.placeOrder(r), c.placeOrder(r)]);
    expect(a).toBe(b);
    expect(fake.count('place_order')).toBe(1);
  });

  it('does not join a call that brings its own signal, so one abort does not end the other tap', async () => {
    const c = client();
    const r = request();
    fake.fail('place_order', 'hang');
    const controller = new AbortController();
    const first = c.placeOrder(r, { signal: controller.signal });
    const second = c.placeOrder(r);
    controller.abort();
    expect(await first).toMatchObject({ kind: 'unknown', reason: 'aborted' });
    expect(await second).toMatchObject({ kind: 'placed', requests: 1 });
    expect(await count(db, 'orders')).toBe(1);
  });

  it('sends a double tap from two clients twice and still writes one order', async () => {
    const r = request();
    const [a, b] = await Promise.all([client().placeOrder(r), client().placeOrder(r)]);
    expect([a.kind, b.kind].sort()).toEqual(['already_placed', 'placed']);
    expect(b.kind === 'already_placed' ? b.afterLostResponse : a.kind === 'already_placed' && a.afterLostResponse).toBe(false);
    expect(await count(db, 'orders')).toBe(1);
  });

  it('bounds a retry storm: attempts, backoff and the Retry-After ceiling', async () => {
    fake.failAlways('place_order', { status: 503 });
    fake.failAlways('find_order', { status: 503 });
    const r = await client({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 }).placeOrder(request());
    expect(r.kind).toBe('unknown');
    expect(fake.count('place_order')).toBe(4);
    expect(fake.count('find_order')).toBe(1);
    // Full jitter at random() = 0.5 under ceilings of 100, 200 and 400.
    expect(sleeps).toEqual([50, 100, 200]);

    fake.reset();
    sleeps = [];
    fake.failAlways('place_order', { status: 429, retryAfter: '1' });
    await client({ maxDelayMs: 2000 }).placeOrder(request());
    expect(sleeps).toEqual([1000, 1000]);

    fake.reset();
    sleeps = [];
    // A server that asks for a longer pause than the client will wait gets no more attempts.
    fake.failAlways('place_order', { status: 503, retryAfter: '30' });
    await client().placeOrder(request());
    expect(fake.count('place_order')).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('times out a hung attempt and retries it', async () => {
    fake.fail('place_order', 'hang');
    const r = await client({ timeoutMs: 20 }).placeOrder(request());
    expect(r).toMatchObject({ kind: 'placed', requests: 2 });
  });

  it('stops when the caller aborts and says unknown', async () => {
    fake.failAlways('place_order', 'hang');
    const controller = new AbortController();
    const pending = client().placeOrder(request(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toMatchObject({ kind: 'unknown', reason: 'aborted', requests: 1 });
    expect(fake.count('find_order')).toBe(0);
  });

  it('reports unavailable products and another customer key without retrying', async () => {
    await db.query('update products set active = false where id = $1', [widgetB]);
    expect(await client().placeOrder(request())).toMatchObject({ kind: 'rejected', reason: 'unavailable', productIds: [widgetB] });
    const k = key();
    await place(db, k, 'shop-2', [{ product_id: widgetA, quantity: 1 }]);
    expect(await client().placeOrder(request(k))).toEqual({ kind: 'rejected', reason: 'key_taken', requests: 1 });
  });

  it.each<[string, Partial<PlaceRequest>]>([
    ['a short key', { key: 'abc' }],
    ['an empty customer', { customerId: '' }],
    ['no lines', { lines: [] }],
    ['a zero quantity', { lines: [{ productId: 1, quantity: 0 }] }],
    ['a product twice', { lines: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 2 }] }],
  ])('sends nothing for %s', async (_, change) => {
    const r = await client().placeOrder({ ...request(), ...change });
    expect(r).toMatchObject({ kind: 'rejected', reason: 'invalid_request', requests: 0 });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('confirmOrder', () => {
  async function pendingOrder(): Promise<number> {
    return orderOf(await place(db, key(), 'shop-1', [{ product_id: widgetA, quantity: 4 }])).id;
  }

  it('confirms and takes stock once when the response is lost', async () => {
    const id = await pendingOrder();
    fake.fail('confirm_order', 'drop-after-commit');
    const r = await client().confirmOrder({ orderId: id, expectedVersion: 1, key: key() });
    expect(r).toMatchObject({ kind: 'already_confirmed', afterLostResponse: true, via: 'resend', requests: 2 });
    expect(await onHand(db, widgetA)).toBe(6);
  });

  it('reads the order back when every confirm attempt is lost', async () => {
    const id = await pendingOrder();
    const k = key();
    fake.failAlways('confirm_order', 'drop-after-commit');
    expect(await client().confirmOrder({ orderId: id, expectedVersion: 1, key: k })).toMatchObject({
      kind: 'already_confirmed',
      via: 'reread',
      order: { confirmKey: k },
    });
    expect(await onHand(db, widgetA)).toBe(6);
  });

  it('tells a lost confirm from one made on another screen', async () => {
    const id = await pendingOrder();
    await db.query('select confirm_order($1, 1, $2)', [id, key()]);
    fake.failAlways('confirm_order', 'drop-before');
    expect(await client().confirmOrder({ orderId: id, expectedVersion: 1, key: key() })).toMatchObject({
      kind: 'rejected',
      reason: 'not_pending',
      requests: 4,
    });
  });

  it('says unknown when the order is still pending after every attempt failed', async () => {
    const id = await pendingOrder();
    fake.failAlways('confirm_order', { status: 503 });
    expect(await client().confirmOrder({ orderId: id, expectedVersion: 1, key: key() })).toMatchObject({ kind: 'unknown' });
    expect(await onHand(db, widgetA)).toBe(10);
  });

  it('lets one of two racing confirms win', async () => {
    const id = await pendingOrder();
    const [a, b] = await Promise.all([
      client().confirmOrder({ orderId: id, expectedVersion: 1, key: key() }),
      client().confirmOrder({ orderId: id, expectedVersion: 1, key: key() }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['confirmed', 'rejected']);
    expect(await onHand(db, widgetA)).toBe(6);
  });

  it('passes on version conflicts and shortages', async () => {
    const id = orderOf(await place(db, key(), 'shop-1', [{ product_id: widgetB, quantity: 3 }])).id;
    await db.query('select edit_order($1, 1, $2::jsonb)', [id, JSON.stringify([{ product_id: widgetB, quantity: 4 }])]);
    expect(await client().confirmOrder({ orderId: id, expectedVersion: 1, key: key() })).toMatchObject({
      kind: 'rejected',
      reason: 'version_conflict',
      currentVersion: 2,
    });
    expect(await client().confirmOrder({ orderId: id, expectedVersion: 2, key: key() })).toMatchObject({
      kind: 'rejected',
      reason: 'insufficient_stock',
      shortages: [{ productId: widgetB, requested: 4, onHand: 3 }],
    });
  });
});
