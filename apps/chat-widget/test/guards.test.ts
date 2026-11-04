import { describe, expect, it } from 'vitest';
import { claimedHost, createRateLimiter, hostAllowed, ipKey, parseIPv6, readLimited, withTimeout } from '../server/guards.ts';
import { resolveStatic } from '../server/node-http.ts';

describe('ipKey', () => {
  it('keeps IPv4, maps IPv4-mapped IPv6 back, and keys IPv6 by its /64', () => {
    expect(ipKey('192.0.2.7')).toBe('192.0.2.7');
    expect(ipKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:DB8:1:2::99')).toBe('2001:db8:1:2::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(parseIPv6('2001:db8::1::2')).toBeNull();
    expect(ipKey('not an address')).toBe('not an address');
  });
});

describe('createRateLimiter', () => {
  it('allows `limit` uses per window, records nothing when refusing, and stays bounded', () => {
    let t = 0;
    const limiter = createRateLimiter(2, 1000, () => t, 3);
    expect([limiter.allow('a'), limiter.allow('a'), limiter.allow('a')]).toEqual([true, true, false]);
    t = 999;
    expect(limiter.atLimit('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    t = 1000;
    expect(limiter.atLimit('a')).toBe(false);
    expect(limiter.allow('a')).toBe(true);
    for (const key of ['b', 'c', 'd', 'e']) limiter.allow(key);
    expect(limiter.size).toBe(3);
  });
});

describe('origin', () => {
  const req = (headers: Record<string, string>): Request => new Request('https://widget.example/widget/chat', { method: 'POST', headers });
  it('reads Origin, then Referer, and matches whole labels only', () => {
    expect(claimedHost(req({ origin: 'https://Shop.Example:8443' }))).toBe('shop.example');
    expect(claimedHost(req({ origin: 'null', referer: 'https://shop.example/a?b' }))).toBe('shop.example');
    expect(claimedHost(req({ referer: 'not a url' }))).toBeNull();
    expect(hostAllowed('www.shop.example', ['shop.example'])).toBe(true);
    expect(hostAllowed('evilshop.example', ['shop.example'])).toBe(false);
    expect(hostAllowed(null, ['shop.example'])).toBe(false);
    expect(hostAllowed('shop.example', [])).toBe(false);
  });
});

describe('readLimited', () => {
  it('stops reading a chunked body at the limit instead of buffering it', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: endless, duplex: 'half' };
    expect(await readLimited(new Request('https://widget.example/x', init), 10 * 1024)).toBeNull();
    expect(pulled).toBeLessThan(20);
    expect(await readLimited(new Request('https://widget.example/x', { method: 'POST', body: 'hola' }), 10)).toBe('hola');
    expect(await readLimited(new Request('https://widget.example/x', { method: 'POST', body: 'x'.repeat(11) }), 10)).toBeNull();
  });
});

describe('withTimeout', () => {
  it('rejects a call that does not settle in time', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toThrow(/10 ms/u);
    await expect(withTimeout(Promise.resolve(3), 10)).resolves.toBe(3);
  });
});

describe('resolveStatic', () => {
  it('serves files inside the build folder only', () => {
    expect(resolveStatic('/srv/app', '/panel/')).toBe('/srv/app/panel/index.html');
    expect(resolveStatic('/srv/app', '/embed/../embed/chat.js')).toBe('/srv/app/embed/chat.js');
    expect(resolveStatic('/srv/app', '/../etc/passwd')).toBeNull();
    expect(resolveStatic('/srv/app', '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStatic('/srv/app', '/a%00b')).toBeNull();
    expect(resolveStatic('/srv/app', '/%E0%A4%A')).toBeNull();
  });
});
