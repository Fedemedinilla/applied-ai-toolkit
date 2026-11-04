import { describe, expect, it } from 'vitest';
import { explainError, readTestAnswer, testMessage } from '../src/messages.ts';
import { detectPlatform } from '../src/platform.ts';
import { base64UrlToBytes, subscriptionBody } from '../src/wire.ts';
import { serviceOf } from '../server/push.ts';
import { memoryStore, StoreFullError } from '../server/store.ts';
import { fakeDevice } from './helpers/fake-push-service.ts';

describe('memoryStore', () => {
  it('reports created, unchanged and updated, and keeps the first createdAt', async () => {
    let t = 0;
    const store = memoryStore({ now: () => new Date(Date.UTC(2026, 10, 4, 0, 0, t++)) });
    const device = fakeDevice('a');
    expect(await store.put(device)).toBe('created');
    expect(await store.put(device)).toBe('unchanged');
    expect(await store.put({ ...device, keys: fakeDevice('b').keys })).toBe('updated');
    expect((await store.get(device.endpoint))?.createdAt).toBe('2026-11-04T00:00:00.000Z');
  });

  it('when full, evicts the device that registered least recently', async () => {
    const store = memoryStore({ capacity: 2 });
    const [a, b, c] = [fakeDevice('a'), fakeDevice('b'), fakeDevice('c')];
    await store.put(a);
    await store.put(b);
    // a registers again on a page load, so b is now the oldest
    expect(await store.put(a)).toBe('unchanged');
    expect(await store.put(c)).toBe('created');
    expect((await store.list()).map((row) => row.endpoint)).toEqual([a.endpoint, c.endpoint]);
    // an evicted device comes back like any new one
    expect(await store.put(b)).toBe('created');
    expect(await store.get(a.endpoint)).toBeUndefined();
  });

  it('with whenFull refuse, refuses a new endpoint when full, but still updates a stored one', async () => {
    const store = memoryStore({ capacity: 1, whenFull: 'refuse' });
    const device = fakeDevice('a');
    await store.put(device);
    await expect(store.put(fakeDevice('b'))).rejects.toBeInstanceOf(StoreFullError);
    expect(await store.put({ ...device, keys: fakeDevice('c').keys })).toBe('updated');
  });

  it('remove says whether there was a row', async () => {
    const store = memoryStore();
    const device = fakeDevice('a');
    await store.put(device);
    expect(await store.remove(device.endpoint)).toBe(true);
    expect(await store.remove(device.endpoint)).toBe(false);
  });
});

describe('serviceOf', () => {
  it.each([
    ['https://web.push.apple.com/abc', 'apple'],
    ['https://fcm.googleapis.com/fcm/send/abc', 'google'],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', 'mozilla'],
    ['https://wns2-par02p.notify.windows.com/w/?token=abc', 'windows'],
    ['https://android.googleapis.com/gcm/send/abc', 'google'],
    ['https://push.example.test/x', 'other'],
    ['https://evil-push.apple.com.example.test/x', 'other'],
    ['https://storage.googleapis.com/bucket/x', 'other'],
    ['https://www.mozilla.com/x', 'other'],
    ['https://web.push.apple.com:8443/abc', 'other'],
    ['https://user:pw@web.push.apple.com/abc', 'other'],
    ['http://web.push.apple.com/abc', 'other'],
    ['https://10.0.0.1/', 'other'],
    ['not a url', 'other'],
  ])('%s is %s', (endpoint, service) => {
    expect(serviceOf(endpoint)).toBe(service);
  });
});

describe('detectPlatform', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const android = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

  it('an iPhone in a Safari tab needs the install step before push exists', () => {
    expect(detectPlatform({ userAgent: iphone, maxTouchPoints: 5, displayStandalone: false, navigatorStandalone: false })).toEqual({
      os: 'ios',
      installed: false,
      pushNeedsInstall: true,
    });
  });

  it('an iPhone opened from the home screen is installed, by either signal', () => {
    expect(detectPlatform({ userAgent: iphone, maxTouchPoints: 5, displayStandalone: false, navigatorStandalone: true }).pushNeedsInstall).toBe(false);
    expect(detectPlatform({ userAgent: iphone, maxTouchPoints: 5, displayStandalone: true, navigatorStandalone: undefined }).installed).toBe(true);
  });

  it('an iPad that reports a Mac is recognised by its touch screen; a Mac is not', () => {
    expect(detectPlatform({ userAgent: ipad, maxTouchPoints: 5, displayStandalone: false, navigatorStandalone: false }).os).toBe('ios');
    expect(detectPlatform({ userAgent: ipad, maxTouchPoints: 0, displayStandalone: false, navigatorStandalone: undefined }).os).toBe('other');
  });

  it('Android never needs the install step for push', () => {
    expect(detectPlatform({ userAgent: android, maxTouchPoints: 5, displayStandalone: false, navigatorStandalone: undefined })).toEqual({
      os: 'android',
      installed: false,
      pushNeedsInstall: false,
    });
  });
});

describe('wire helpers', () => {
  it('turns a base64url key into the bytes subscribe() wants', () => {
    const bytes = Buffer.from([4, 250, 251, 252, 0, 63, 62]);
    expect([...base64UrlToBytes(bytes.toString('base64url'))]).toEqual([...bytes]);
  });

  it('builds the subscribe body from toJSON(), or null when a field is missing', () => {
    expect(subscriptionBody({ endpoint: 'https://push.example.test/a', keys: { p256dh: 'p', auth: 'a' } })).toEqual({
      endpoint: 'https://push.example.test/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(subscriptionBody({ endpoint: 'https://push.example.test/a', keys: { p256dh: 'p' } })).toBeNull();
    expect(subscriptionBody({})).toBeNull();
  });
});

describe('messages', () => {
  it('maps each server answer, and never advises disabling on a store failure', () => {
    expect(readTestAnswer(200, { status: 'delivered', ttl: 3600 })).toEqual({ kind: 'delivered', ttl: 3600 });
    expect(testMessage({ kind: 'delivered', ttl: 3600 })).toContain('1 hora');
    expect(testMessage({ kind: 'delivered', ttl: 86400 })).toContain('24 horas');
    const storeFailed = testMessage(readTestAnswer(503, { error: 'store_failed' }));
    expect(storeFailed).toContain('No desactives');
    expect(readTestAnswer(404, { error: 'not_subscribed' })).toEqual({ kind: 'not_subscribed' });
    expect(readTestAnswer(429, { error: 'too_soon', retryAfterSeconds: 2 })).toEqual({ kind: 'too_soon', seconds: 2 });
    expect(readTestAnswer(502, { error: 'push_failed', statusCode: 403 })).toEqual({ kind: 'push_failed', statusCode: 403 });
    expect(readTestAnswer(500, 'oops')).toEqual({ kind: 'other', status: 500 });
  });

  it('explains browser errors by name, and keeps the raw reason otherwise', () => {
    expect(explainError({ name: 'NotAllowedError', message: '' })).toContain('bloqueó');
    expect(explainError(new Error('weird'))).toContain('weird');
  });
});
