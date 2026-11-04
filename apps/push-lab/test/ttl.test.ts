// The TTL header that actually leaves the machine, and the 404/410 cleanup, through the real
// web-push library. Nothing reaches the network: https.request is replaced by a fake push service.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { createHandler } from '../server/handler.ts';
import { deliver, MESSAGE_KINDS, payloadFor, webPushSender } from '../server/push.ts';
import { memoryStore } from '../server/store.ts';
import { generateVapidPair } from '../server/vapid.ts';
import { fakeDevice, installFakePushService, type FakePushService } from './helpers/fake-push-service.ts';

const vapid = { ...generateVapidPair(), subject: 'mailto:lab@example.test' };
let service: FakePushService;

beforeEach(() => {
  service = installFakePushService();
});
afterEach(() => {
  service.restore();
});

describe('the instrument sees what web-push sends', () => {
  const device = fakeDevice('control');

  it('an explicit TTL goes out as the TTL header, signed and encrypted', async () => {
    await webpush.sendNotification(device, '{"title":"x"}', { TTL: 1234, vapidDetails: vapid });
    expect(service.sent).toHaveLength(1);
    const [req] = service.sent;
    expect(req?.headers['TTL']).toBe('1234');
    expect(req?.host).toBe('push.example.test');
    expect(req?.path).toBe('/device-control');
    expect(req?.headers['Authorization']).toMatch(/^vapid t=.+, k=/u);
    expect(req?.headers['Content-Encoding']).toBe('aes128gcm');
    expect(req?.bytes).toBeGreaterThan(0);
  });

  it('without a TTL, web-push sends four weeks, so a forgotten option would show', async () => {
    await webpush.sendNotification(device, '{"title":"x"}', { vapidDetails: vapid });
    expect(service.sent[0]?.headers['TTL']).toBe('2419200');
  });

  it('a misspelled option is refused and nothing goes out, so that would show too', async () => {
    const options = { ttl: 1234, vapidDetails: vapid } as webpush.RequestOptions;
    await expect(webpush.sendNotification(device, '{"title":"x"}', options)).rejects.toThrow(/invalid option/iu);
    expect(service.sent).toHaveLength(0);
  });
});

describe('TTL per message kind', () => {
  it.each([
    ['test', '3600', 'high'],
    ['reminder', '86400', 'normal'],
  ] as const)('a %s push goes out with TTL %s and urgency %s', async (kind, ttl, urgency) => {
    const store = memoryStore();
    const device = fakeDevice(kind);
    await store.put(device);
    const handler = createHandler({ store, send: webPushSender(vapid), vapid, minIntervalMs: 0, allowAnyEndpoint: true });
    const response = await handler(
      new Request('http://lab.test/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: device.endpoint, kind }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'delivered', kind, ttl: Number(ttl) });
    expect(service.sent.map((r) => r.headers['TTL'])).toEqual([ttl]);
    expect(service.sent[0]?.headers['Urgency']).toBe(urgency);
  });

  it('a reminder after a test does not inherit the test TTL, and the reverse', async () => {
    const store = memoryStore();
    const device = fakeDevice('order');
    await store.put(device);
    const sub = (await store.get(device.endpoint))!;
    const send = webPushSender(vapid);
    await deliver(store, send, sub, payloadFor('test', 1, undefined));
    await deliver(store, send, sub, payloadFor('reminder', 2, undefined));
    await deliver(store, send, sub, payloadFor('test', 3, undefined));
    expect(service.sent.map((r) => Number(r.headers['TTL']))).toEqual([
      MESSAGE_KINDS.test.ttl,
      MESSAGE_KINDS.reminder.ttl,
      MESSAGE_KINDS.test.ttl,
    ]);
  });
});

describe('cleanup on the push service answer', () => {
  it.each([404, 410])('a %i deletes the subscription from the store', async (status) => {
    const store = memoryStore();
    const device = fakeDevice(`gone-${status}`);
    await store.put(device);
    service.statusFor.set(`/device-gone-${status}`, status);
    const sub = (await store.get(device.endpoint))!;
    const delivery = await deliver(store, webPushSender(vapid), sub, payloadFor('test', 1, undefined));
    expect(delivery).toEqual({ status: 'gone', statusCode: status, removed: true });
    expect(await store.get(device.endpoint)).toBeUndefined();
  });

  it.each([400, 403, 413, 429, 500, 503])('a %i keeps the subscription: it says nothing about the device', async (status) => {
    const store = memoryStore();
    const device = fakeDevice(`keep-${status}`);
    await store.put(device);
    service.statusFor.set(`/device-keep-${status}`, status);
    const sub = (await store.get(device.endpoint))!;
    const delivery = await deliver(store, webPushSender(vapid), sub, payloadFor('test', 1, undefined));
    expect(delivery).toMatchObject({ status: 'failed', statusCode: status });
    expect(await store.get(device.endpoint)).toBeDefined();
  });

  it('only the dead device is removed when two are stored', async () => {
    const store = memoryStore();
    const alive = fakeDevice('alive');
    const dead = fakeDevice('dead');
    await store.put(alive);
    await store.put(dead);
    service.statusFor.set('/device-dead', 410);
    const send = webPushSender(vapid);
    for (const sub of await store.list()) await deliver(store, send, sub, payloadFor('test', 1, undefined));
    expect((await store.list()).map((s) => s.endpoint)).toEqual([alive.endpoint]);
  });
});
