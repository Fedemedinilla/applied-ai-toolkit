import { describe, expect, it } from 'vitest';
import { cacheFirst, cacheName, NETWORK_TIMEOUT_MS, networkFirst, staleCaches, strategyFor, type CacheLike, type Deps } from '../src/sw-core.ts';

const SCOPE = 'https://lab.example.test/apps/replay-lab/';

class FakeCache implements CacheLike {
  store = new Map<string, Response>();
  failPut = false;
  async match(request: Request | string, options?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    let url = typeof request === 'string' ? request : request.url;
    if (options?.ignoreSearch) url = url.split('?')[0] ?? url;
    return this.store.get(url)?.clone();
  }
  async put(request: Request | string, response: Response): Promise<void> {
    if (this.failPut) throw new Error('quota');
    this.store.set(typeof request === 'string' ? request : request.url, response);
  }
}

function deps(cache: FakeCache, fetchImpl: (r: Request) => Promise<Response>, sleep: (ms: number) => Promise<void> = () => new Promise(() => undefined)): Deps {
  return { fetch: fetchImpl, cache: async () => cache, sleep };
}

// Node's Request refuses mode 'navigate', so these requests carry the URL only; the navigation flag
// is passed to networkFirst as the worker passes it.
const req = (path: string): Request => new Request(new URL(path, SCOPE));

describe('strategyFor', () => {
  it.each([
    [{ url: `${SCOPE}assets/index-abc.js`, method: 'GET', mode: 'no-cors' }, 'cache-first'],
    [{ url: `${SCOPE}assets/batch-worker-abc.js`, method: 'GET', mode: 'same-origin' }, 'cache-first'],
    [{ url: `${SCOPE}index.html`, method: 'GET', mode: 'no-cors' }, 'network-first'],
    [{ url: `${SCOPE}?seed=x`, method: 'GET', mode: 'navigate' }, 'network-first'],
    [{ url: `${SCOPE}manifest.webmanifest`, method: 'GET', mode: 'no-cors' }, 'network-first'],
    [{ url: `${SCOPE}index.html`, method: 'POST', mode: 'no-cors' }, 'passthrough'],
    [{ url: 'https://other.example.test/apps/replay-lab/x.js', method: 'GET', mode: 'no-cors' }, 'passthrough'],
    [{ url: 'https://lab.example.test/apps/caja/index.html', method: 'GET', mode: 'no-cors' }, 'passthrough'],
  ] as const)('%j is %s', (request, strategy) => {
    expect(strategyFor(request, SCOPE)).toBe(strategy);
  });
});

describe('cacheFirst', () => {
  it('serves a cached copy without the network, and stores a fetched one', async () => {
    const cache = new FakeCache();
    let calls = 0;
    const d = deps(cache, async () => {
      calls += 1;
      return new Response('js');
    });
    expect(await (await cacheFirst(req('assets/a.js'), d)).text()).toBe('js');
    expect(await (await cacheFirst(req('assets/a.js'), d)).text()).toBe('js');
    expect(calls).toBe(1);
  });

  it('does not store an error response, and survives a full cache', async () => {
    const cache = new FakeCache();
    await cacheFirst(req('assets/missing.js'), deps(cache, async () => new Response('no', { status: 404 })));
    expect(cache.store.size).toBe(0);
    cache.failPut = true;
    const res = await cacheFirst(req('assets/b.js'), deps(cache, async () => new Response('b')));
    expect(await res.text()).toBe('b');
  });
});

describe('networkFirst', () => {
  const fallback = `${SCOPE}index.html`;

  it('uses the network when it answers, and refreshes the cache', async () => {
    const cache = new FakeCache();
    const res = await networkFirst(req('index.html'), deps(cache, async () => new Response('new')), { navigation: false, fallback });
    expect(await res.text()).toBe('new');
    expect(cache.store.has(fallback)).toBe(true);
  });

  it('offline, a navigation with a query gets the cached index.html', async () => {
    const cache = new FakeCache();
    cache.store.set(fallback, new Response('app'));
    const res = await networkFirst(req('?seed=x'), deps(cache, async () => Promise.reject(new TypeError('offline'))), { navigation: true, fallback });
    expect(await res.text()).toBe('app');
  });

  it('offline with nothing cached answers 503', async () => {
    const res = await networkFirst(req('icon.svg'), deps(new FakeCache(), async () => Promise.reject(new TypeError('offline'))), { navigation: false, fallback });
    expect(res.status).toBe(503);
  });

  it('a hanging network is given up after the timeout when a copy exists', async () => {
    const cache = new FakeCache();
    cache.store.set(fallback, new Response('cached'));
    let waited = 0;
    const res = await networkFirst(
      req('index.html'),
      deps(cache, () => new Promise(() => undefined), async (ms) => {
        waited = ms;
      }),
      { navigation: false, fallback },
    );
    expect(await res.text()).toBe('cached');
    expect(waited).toBe(NETWORK_TIMEOUT_MS);
  });

  it('a navigation answered with a host error page gets the cached app instead', async () => {
    const cache = new FakeCache();
    cache.store.set(fallback, new Response('app'));
    const res = await networkFirst(req(''), deps(cache, async () => new Response('bad gateway', { status: 502 })), { navigation: true, fallback });
    expect(await res.text()).toBe('app');
  });
});

describe('cache names', () => {
  it('deletes only older replay-lab caches', () => {
    const current = cacheName('v2');
    expect(staleCaches(['replay-lab-v1', current, 'caja-abc-v1', 'other'], current)).toEqual(['replay-lab-v1']);
  });
});
