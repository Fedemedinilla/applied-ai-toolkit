// The handler with an in-memory store and a fake sender. The real web-push path is in ttl.test.ts.

import { describe, expect, it } from 'vitest';
import { createHandler, MAX_BODY_BYTES, type HandlerDeps } from '../server/handler.ts';
import type { Sender } from '../server/push.ts';
import { memoryStore, type SubscriptionStore } from '../server/store.ts';
import { generateVapidPair } from '../server/vapid.ts';
import { fakeDevice } from './helpers/fake-push-service.ts';

const vapid = { ...generateVapidPair(), subject: 'mailto:lab@example.test' };
const BASE = 'http://lab.test/push-lab/';

interface Sent {
  endpoint: string;
  payload: unknown;
  ttl: number;
}

function setup(overrides: Partial<HandlerDeps> = {}) {
  const sent: Sent[] = [];
  const send: Sender = async (sub, payload, { ttl }) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), ttl });
  };
  const store = memoryStore();
  let clock = 1_000_000;
  const slept: number[] = [];
  const handler = createHandler({
    store,
    send,
    vapid,
    // The fake push service lives at push.example.test; the allowlist has its own tests below.
    allowAnyEndpoint: true,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...overrides,
  });
  const call = (path: string, body?: unknown, init: RequestInit = {}) =>
    handler(
      new Request(BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        ...init,
      }),
    );
  return { handler, store, sent, slept, call, tick: (ms: number) => (clock += ms) };
}

/** A store whose every method throws, like a database that is down. */
const brokenStore: SubscriptionStore = {
  put: async () => {
    throw new Error('db down');
  },
  get: async () => {
    throw new Error('db down');
  },
  remove: async () => {
    throw new Error('db down');
  },
  list: async () => {
    throw new Error('db down');
  },
};

describe('POST api/subscribe', () => {
  it('stores a subscription, is idempotent, and updates rotated keys in place', async () => {
    const { call, store } = setup();
    const device = fakeDevice('a');
    const first = await call('api/subscribe', device);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ result: 'created' });
    expect(await (await call('api/subscribe', device)).json()).toEqual({ result: 'unchanged' });
    const createdAt = (await store.get(device.endpoint))?.createdAt;

    const rotated = { ...device, keys: fakeDevice('b').keys };
    expect(await (await call('api/subscribe', rotated)).json()).toEqual({ result: 'updated' });
    expect(await store.get(device.endpoint)).toMatchObject({ keys: rotated.keys, createdAt });
  });

  it("accepts PushSubscription.toJSON() as the worker sends it, and keeps only what it needs", async () => {
    const { call, store } = setup();
    const device = fakeDevice('json');
    expect((await call('api/subscribe', { ...device, expirationTime: null })).status).toBe(201);
    expect(Object.keys((await store.get(device.endpoint)) ?? {}).sort()).toEqual(['createdAt', 'endpoint', 'keys']);
  });

  it.each([
    ['an http endpoint', { ...fakeDevice('x'), endpoint: 'http://push.example.test/x' }],
    ['a non-URL endpoint', { ...fakeDevice('x'), endpoint: 'push.example.test' }],
    ['an endpoint over 2000 characters', { ...fakeDevice('x'), endpoint: `https://push.example.test/${'a'.repeat(2000)}` }],
    ['a short p256dh', { ...fakeDevice('x'), keys: { p256dh: 'BAAA', auth: fakeDevice('y').keys.auth } }],
    ['a 15-byte auth', { ...fakeDevice('x'), keys: { p256dh: fakeDevice('y').keys.p256dh, auth: Buffer.alloc(15).toString('base64url') } }],
    ['no keys', { endpoint: 'https://push.example.test/x' }],
  ])('refuses %s with 400', async (_label, body) => {
    const { call, store } = setup();
    const response = await call('api/subscribe', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_subscription' });
    expect(await store.list()).toEqual([]);
  });

  it('accepts a long endpoint that is still under the cap', async () => {
    const { call } = setup();
    const device = { ...fakeDevice('long'), endpoint: `https://push.example.test/${'a'.repeat(1500)}` };
    expect((await call('api/subscribe', device)).status).toBe(201);
  });

  it('refuses anything but JSON, oversized bodies and broken JSON', async () => {
    const { call } = setup();
    const form = await call('api/subscribe', undefined, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'endpoint=x' });
    expect(form.status).toBe(415);
    const big = await call('api/subscribe', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(MAX_BODY_BYTES + 1) });
    expect(big.status).toBe(413);
    const broken = await call('api/subscribe', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(await broken.json()).toEqual({ error: 'invalid_json' });
  });

  it('refuses a chunked body over the cap that declares no Content-Length', async () => {
    const { handler } = setup();
    const chunk = new Uint8Array(1024).fill(0x20);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request(BASE + 'api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
    expect(request.headers.get('content-length')).toBeNull();
    const response = await handler(request);
    expect(response.status).toBe(413);
    // Stopped at the first chunk past 4096 bytes, not after all 64 KiB.
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_BODY_BYTES / chunk.byteLength) + 2);
  });

  it('reports a store failure and a full store as such', async () => {
    const failed = await setup({ store: brokenStore }).call('api/subscribe', fakeDevice('a'));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'store_failed' });

    const tiny = memoryStore({ capacity: 1, whenFull: 'refuse' });
    const { call } = setup({ store: tiny });
    await call('api/subscribe', fakeDevice('one'));
    const full = await call('api/subscribe', fakeDevice('two'));
    expect(await full.json()).toEqual({ error: 'store_full' });
  });
});

describe('POST api/test', () => {
  async function subscribed(overrides: Partial<HandlerDeps> = {}) {
    const ctx = setup(overrides);
    const device = fakeDevice('t');
    await ctx.call('api/subscribe', device);
    return { ...ctx, device };
  }

  it('sends to the asking device only, with the TTL of its kind and the badge number', async () => {
    const { call, sent, device } = await subscribed();
    await call('api/subscribe', fakeDevice('other'));
    const response = await call('api/test', { endpoint: device.endpoint, kind: 'reminder', badge: 3 });
    expect(await response.json()).toEqual({ status: 'delivered', kind: 'reminder', ttl: 86400 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ endpoint: device.endpoint, ttl: 86400, payload: { kind: 'reminder', badge: 3, url: './?from=notification' } });
  });

  it('leaves the badge out of the payload when no number is sent: absent is not zero', async () => {
    const { call, sent, device } = await subscribed();
    await call('api/test', { endpoint: device.endpoint, kind: 'test', badge: null });
    expect(sent[0]?.payload).not.toHaveProperty('badge');
  });

  it('gives each test its own tag, so the second does not silently replace the first', async () => {
    const { call, sent, device, tick } = await subscribed();
    await call('api/test', { endpoint: device.endpoint, kind: 'test' });
    tick(5000);
    await call('api/test', { endpoint: device.endpoint, kind: 'test' });
    const tags = sent.map((s) => (s.payload as { tag: string }).tag);
    expect(new Set(tags).size).toBe(2);
  });

  it('tells "the store failed" (503) from "this device is not subscribed" (404)', async () => {
    const endpoint = fakeDevice('x').endpoint;
    const failed = await setup({ store: brokenStore }).call('api/test', { endpoint, kind: 'test' });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'store_failed' });

    const missing = await setup().call('api/test', { endpoint, kind: 'test' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_subscribed' });
  });

  it('on 410 from the push service, answers gone and removes the subscription', async () => {
    const send: Sender = async () => {
      throw Object.assign(new Error('Received unexpected response code'), { statusCode: 410 });
    };
    const { call, store, device } = await subscribed({ send });
    const response = await call('api/test', { endpoint: device.endpoint, kind: 'test' });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'gone', statusCode: 410, removed: true });
    expect(await store.list()).toEqual([]);
  });

  it('on a 5xx or a timeout, answers push_failed and keeps the subscription', async () => {
    let error: Error = Object.assign(new Error('Received unexpected response code'), { statusCode: 503 });
    const send: Sender = async () => {
      throw error;
    };
    const { call, store, device, tick } = await subscribed({ send });
    const first = await call('api/test', { endpoint: device.endpoint, kind: 'test' });
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ error: 'push_failed', statusCode: 503 });
    error = new Error('Socket timeout');
    tick(5000);
    expect(await (await call('api/test', { endpoint: device.endpoint, kind: 'test' })).json()).toEqual({ error: 'push_failed', statusCode: null });
    expect(await store.list()).toHaveLength(1);
  });

  it('limits one device to one test every few seconds', async () => {
    const { call, sent, device, tick } = await subscribed();
    await call('api/test', { endpoint: device.endpoint, kind: 'test' });
    tick(1000);
    const early = await call('api/test', { endpoint: device.endpoint, kind: 'test' });
    expect(early.status).toBe(429);
    expect(early.headers.get('retry-after')).toBe('2');
    expect(await early.json()).toEqual({ error: 'too_soon', retryAfterSeconds: 2 });
    tick(2000);
    expect((await call('api/test', { endpoint: device.endpoint, kind: 'test' })).status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it('waits the requested delay, capped at 5 seconds', async () => {
    const { call, slept, device } = await subscribed();
    await call('api/test', { endpoint: device.endpoint, kind: 'test', delaySeconds: 5 });
    expect(slept).toEqual([5000]);
    const tooLong = await call('api/test', { endpoint: device.endpoint, kind: 'test', delaySeconds: 60 });
    expect(tooLong.status).toBe(400);
  });

  it('refuses an unknown kind and a badge outside 0 to 999', async () => {
    const { call, device } = await subscribed();
    expect((await call('api/test', { endpoint: device.endpoint, kind: 'marketing' })).status).toBe(400);
    expect((await call('api/test', { endpoint: device.endpoint, kind: 'test', badge: -1 })).status).toBe(400);
    expect((await call('api/test', { endpoint: device.endpoint, kind: 'test', badge: 1.5 })).status).toBe(400);
  });

  it('does not send with a key pair that cannot sign', async () => {
    const other = generateVapidPair();
    const { call, sent, device } = await subscribed({ vapid: { ...vapid, privateKey: other.privateKey } });
    const response = await call('api/test', { endpoint: device.endpoint, kind: 'test' });
    expect(await response.json()).toEqual({ error: 'not_configured' });
    expect(sent).toEqual([]);
  });
});

describe('endpoints outside the known push services', () => {
  // The default: no allowAnyEndpoint. POST api/test makes the server send to the endpoint, so a
  // free endpoint field would let a visitor aim it at any host and read the status code back.
  const strict = () => setup({ allowAnyEndpoint: false });

  it.each([
    ['an internal address', 'https://10.0.0.1/'],
    ['localhost', 'https://localhost/admin'],
    ['a look-alike host', 'https://web.push.apple.com.example.test/x'],
    ['another Google host', 'https://storage.googleapis.com/bucket/x'],
    ['a push host on another port', 'https://web.push.apple.com:8443/x'],
  ])('refuses %s on subscribe and on test, and sends nothing', async (_label, endpoint) => {
    const { call, store, sent } = strict();
    const subscribe = await call('api/subscribe', { ...fakeDevice('x'), endpoint });
    expect(subscribe.status).toBe(400);
    expect(await subscribe.json()).toEqual({ error: 'unknown_push_service' });
    expect(await store.list()).toEqual([]);

    // Even a row that got into the store some other way is not sent to.
    await store.put({ ...fakeDevice('x'), endpoint });
    const test = await call('api/test', { endpoint, kind: 'test' });
    expect(test.status).toBe(400);
    expect(await test.json()).toEqual({ error: 'unknown_push_service' });
    expect(sent).toEqual([]);
  });

  it('accepts the four push services', async () => {
    const { call, sent } = strict();
    for (const endpoint of [
      'https://web.push.apple.com/a',
      'https://fcm.googleapis.com/fcm/send/b',
      'https://updates.push.services.mozilla.com/wpush/v2/c',
      'https://wns2-par02p.notify.windows.com/w/?token=d',
    ]) {
      expect((await call('api/subscribe', { ...fakeDevice(endpoint), endpoint })).status).toBe(201);
      expect((await call('api/test', { endpoint, kind: 'test' })).status).toBe(200);
    }
    expect(sent).toHaveLength(4);
  });
});

describe('the rate limit', () => {
  it('is not reset by unsubscribing and subscribing again', async () => {
    const { call } = setup();
    const device = fakeDevice('r');
    await call('api/subscribe', device);
    expect((await call('api/test', { endpoint: device.endpoint, kind: 'test' })).status).toBe(200);
    await call('api/unsubscribe', { endpoint: device.endpoint });
    await call('api/subscribe', device);
    expect((await call('api/test', { endpoint: device.endpoint, kind: 'test' })).status).toBe(429);
  });

  it('still applies to a device after many others were tested and aged out', async () => {
    const { call, tick } = setup();
    const devices = Array.from({ length: 20 }, (_, i) => fakeDevice(`many-${i}`));
    for (const d of devices) {
      await call('api/subscribe', d);
      expect((await call('api/test', { endpoint: d.endpoint, kind: 'test' })).status).toBe(200);
      tick(3000);
    }
    const last = devices.at(-1);
    if (!last) throw new Error('no devices');
    tick(-2000); // back inside the last device's interval
    expect((await call('api/test', { endpoint: last.endpoint, kind: 'test' })).status).toBe(429);
  });
});

describe('GET api/public-key', () => {
  it('returns the public key of a valid pair', async () => {
    expect(await (await setup().call('api/public-key')).json()).toEqual({ publicKey: vapid.publicKey });
  });

  it('withholds it when the halves do not match, so no device subscribes to a key that cannot be signed for', async () => {
    const response = await setup({ vapid: { ...vapid, privateKey: generateVapidPair().privateKey } }).call('api/public-key');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });
});

describe('GET api/diagnose', () => {
  it('counts devices by service and never returns an endpoint or a key', async () => {
    const { call } = setup();
    const apple = { ...fakeDevice('a'), endpoint: 'https://web.push.apple.com/QWxhZGRpbg' };
    const google = { ...fakeDevice('g'), endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' };
    await call('api/subscribe', apple);
    await call('api/subscribe', google);
    const response = await call('api/diagnose');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      ready: true,
      store: { ok: true, subscriptions: 2, services: { apple: 1, google: 1 } },
      vapid: { pairMatches: true },
      problems: [],
    });
    for (const secret of [apple.endpoint, google.endpoint, 'QWxhZGRpbg', apple.keys.auth, vapid.privateKey]) expect(text).not.toContain(secret);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reports a store that cannot be read as null, not as zero devices', async () => {
    const body = await (await setup({ store: brokenStore }).call('api/diagnose')).json();
    expect(body).toMatchObject({ ready: false, store: { ok: false, subscriptions: null }, problems: ['store_failed'] });
    expect(body.problems).not.toContain('no_subscriptions');
  });

  it('reports an empty store as no subscriptions, with ready still true', async () => {
    expect(await (await setup().call('api/diagnose')).json()).toMatchObject({
      ready: true,
      store: { ok: true, subscriptions: 0 },
      problems: ['no_subscriptions'],
    });
  });

  it('names the key problem to fix first', async () => {
    const problems = async (config: HandlerDeps['vapid']) => (await (await setup({ vapid: config }).call('api/diagnose')).json()).problems;
    expect(await problems({ publicKey: '', privateKey: '', subject: '' })).toEqual(['vapid_keys_missing', 'no_subscriptions']);
    expect(await problems({ ...vapid, privateKey: generateVapidPair().privateKey })).toEqual(['vapid_pair_mismatch', 'no_subscriptions']);
    expect(await problems({ ...vapid, publicKey: 'abc' })).toEqual(['public_key_format', 'no_subscriptions']);
    expect(await problems({ ...vapid, subject: 'lab@example.test' })).toEqual(['subject_invalid', 'no_subscriptions']);
  });
});

describe('routing', () => {
  it('matches the end of the path, so the app works under any prefix', async () => {
    const { handler } = setup();
    for (const url of ['http://lab.test/api/public-key', 'http://lab.test/a/b/api/public-key']) {
      expect((await handler(new Request(url))).status).toBe(200);
    }
  });

  it('answers 404 for an unknown route and 405 with Allow for a wrong method', async () => {
    const { call } = setup();
    expect((await call('api/nope')).status).toBe(404);
    const wrong = await call('api/test');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
  });

  it('redirect-check is a bare 302: no body, no content-type', async () => {
    const response = await setup().call('api/redirect-check');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('../?redirected=1');
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('unsubscribe removes the device and reports a store failure', async () => {
    const { call, store } = setup();
    const device = fakeDevice('u');
    await call('api/subscribe', device);
    expect(await (await call('api/unsubscribe', { endpoint: device.endpoint })).json()).toEqual({ removed: true });
    expect(await store.list()).toEqual([]);
    expect((await setup({ store: brokenStore }).call('api/unsubscribe', { endpoint: device.endpoint })).status).toBe(503);
  });
});
