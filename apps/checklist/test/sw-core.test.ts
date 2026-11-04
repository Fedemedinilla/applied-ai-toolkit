// The service worker's decisions, with a fake cache and a fake network.

import { describe, expect, it } from 'vitest';
import { cacheFirst, networkFirst, NETWORK_TIMEOUT_MS, scopePrefix, staleCaches, strategyFor, type CacheLike, type Deps } from '../src/sw-core.ts';

const SCOPE = 'https://user.example.test/toolkit/apps/checklist/';

function fakeCache(entries: Record<string, string> = {}): CacheLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries));
  const key = (r: Request | string): string => (typeof r === 'string' ? r : r.url);
  return {
    data,
    match: async (r) => (data.has(key(r)) ? new Response(data.get(key(r))) : undefined),
    put: async (r, res) => {
      data.set(key(r), await res.text());
    },
  };
}

function deps(cache: CacheLike, network: (r: Request) => Promise<Response>, sleep: (ms: number) => Promise<void> = () => new Promise(() => undefined)): Deps {
  return { fetch: network, cache: async () => cache, sleep };
}

describe('strategyFor', () => {
  it('serves hashed assets cache first, everything else network first, and leaves the rest alone', () => {
    const r = (path: string, mode = 'cors', method = 'GET') => ({ url: new URL(path, SCOPE).href, mode, method });
    expect(strategyFor(r('assets/index-abc.js'), SCOPE)).toBe('cache-first');
    expect(strategyFor(r('catalogue.json'), SCOPE)).toBe('network-first');
    expect(strategyFor(r('./', 'navigate'), SCOPE)).toBe('network-first');
    expect(strategyFor(r('catalogue.json', 'cors', 'POST'), SCOPE)).toBe('passthrough');
    expect(strategyFor({ url: 'https://user.example.test/toolkit/apps/caja/', mode: 'navigate', method: 'GET' }, SCOPE)).toBe('passthrough');
    expect(strategyFor({ url: 'https://cdn.example.test/x.js', mode: 'cors', method: 'GET' }, SCOPE)).toBe('passthrough');
  });
});

describe('cacheFirst', () => {
  it('answers from the cache, fills it from the network, and says offline when it has neither', async () => {
    const url = new URL('assets/a.js', SCOPE).href;
    const cache = fakeCache({ [url]: 'cached' });
    expect(await (await cacheFirst(new Request(url), deps(cache, () => Promise.reject(new Error('offline'))))).text()).toBe('cached');
    const other = new URL('assets/b.js', SCOPE).href;
    await cacheFirst(new Request(other), deps(cache, async () => new Response('fresh')));
    expect(cache.data.get(other)).toBe('fresh');
    const miss = await cacheFirst(new Request(new URL('assets/c.js', SCOPE).href), deps(cache, () => Promise.reject(new Error('offline'))));
    expect(miss.status).toBe(503);
  });
});

describe('networkFirst', () => {
  const page = new URL('./', SCOPE).href;
  const index = new URL('index.html', SCOPE).href;

  it('prefers the network and updates the cache', async () => {
    const cache = fakeCache({ [page]: 'old' });
    const res = await networkFirst(new Request(page), deps(cache, async () => new Response('new')), { navigation: true, fallback: index });
    expect(await res.text()).toBe('new');
    expect(cache.data.get(page)).toBe('new');
  });

  it('falls back to the cached index.html offline, or when the host answers with an error page', async () => {
    const cache = fakeCache({ [index]: 'app shell' });
    const offline = await networkFirst(new Request(new URL('?tab=data', SCOPE).href), deps(cache, () => Promise.reject(new Error('offline'))), { navigation: true, fallback: index });
    expect(await offline.text()).toBe('app shell');
    const hostError = await networkFirst(new Request(page), deps(cache, async () => new Response('Service Unavailable', { status: 503 })), { navigation: true, fallback: index });
    expect(await hostError.text()).toBe('app shell');
  });

  it('serves the cache after the timeout when the network hangs', async () => {
    const cache = fakeCache({ [page]: 'cached' });
    let waited = 0;
    const res = await networkFirst(new Request(page), deps(cache, () => new Promise(() => undefined), async (ms) => void (waited = ms)), { navigation: true, fallback: index });
    expect(await res.text()).toBe('cached');
    expect(waited).toBe(NETWORK_TIMEOUT_MS);
  });
});

describe('cache names', () => {
  it('deletes only older caches of this copy of the app', () => {
    const mine = scopePrefix(SCOPE);
    const other = scopePrefix('https://user.example.test/toolkit-v2/apps/checklist/');
    expect(mine).not.toBe(other);
    expect(staleCaches([`${mine}old`, `${mine}new`, `${other}old`, 'caja-1234-x'], `${mine}new`, SCOPE)).toEqual([`${mine}old`]);
  });
});
