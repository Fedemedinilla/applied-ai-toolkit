import { describe, expect, it } from 'vitest';
import { cacheFirst, cacheName, networkFirst, staleCaches, strategyFor, type CacheLike, type Deps } from '../src/sw-core.ts';

const SCOPE = 'https://app.example/apps/caja/';
const url = (path: string): string => new URL(path, SCOPE).href;

class FakeCache implements CacheLike {
  store = new Map<string, Response>();
  failPut = false;
  async match(request: Request | string, options?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const u = new URL(typeof request === 'string' ? request : request.url);
    if (options?.ignoreSearch) u.search = '';
    return this.store.get(u.href)?.clone();
  }
  async put(request: Request | string, response: Response): Promise<void> {
    if (this.failPut) throw new Error('QuotaExceededError');
    this.store.set(typeof request === 'string' ? request : request.url, response);
  }
}

function deps(cache: FakeCache, fetcher: (r: Request) => Promise<Response>, sleep: (ms: number) => Promise<void> = () => new Promise(() => {})): Deps {
  return { fetch: fetcher, cache: async () => cache, sleep };
}

const offline = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

describe('strategyFor', () => {
  it.each([
    [{ url: url('assets/index-abc123.js'), method: 'GET', mode: 'cors' }, 'cache-first'],
    [{ url: url(''), method: 'GET', mode: 'navigate' }, 'network-first'],
    [{ url: url('index.html'), method: 'GET', mode: 'same-origin' }, 'network-first'],
    [{ url: url('corpus.json'), method: 'GET', mode: 'cors' }, 'network-first'],
    [{ url: url('assets/x.js'), method: 'POST', mode: 'cors' }, 'passthrough'],
    [{ url: 'https://other.example/apps/caja/assets/x.js', method: 'GET', mode: 'cors' }, 'passthrough'],
    [{ url: 'https://app.example/other-app/index.html', method: 'GET', mode: 'navigate' }, 'passthrough'],
  ] as const)('%j -> %s', (req, strategy) => {
    expect(strategyFor(req, SCOPE)).toBe(strategy);
  });
});

describe('cacheFirst', () => {
  it('serves the cached copy without touching the network', async () => {
    const cache = new FakeCache();
    cache.store.set(url('assets/a.js'), new Response('cached'));
    const res = await cacheFirst(new Request(url('assets/a.js')), deps(cache, offline));
    expect(await res.text()).toBe('cached');
  });

  it('fetches and stores on a miss, but never stores an error response', async () => {
    const cache = new FakeCache();
    await cacheFirst(new Request(url('assets/a.js')), deps(cache, async () => new Response('fresh')));
    expect(cache.store.has(url('assets/a.js'))).toBe(true);
    await cacheFirst(new Request(url('assets/b.js')), deps(cache, async () => new Response('nope', { status: 404 })));
    expect(cache.store.has(url('assets/b.js'))).toBe(false);
  });

  it('a full cache does not turn a good response into an error', async () => {
    const cache = new FakeCache();
    cache.failPut = true;
    const res = await cacheFirst(new Request(url('assets/a.js')), deps(cache, async () => new Response('fresh')));
    expect(await res.text()).toBe('fresh');
  });
});

describe('networkFirst', () => {
  const nav = { navigation: true, fallback: url('index.html') };

  it('online: serves the network response and refreshes the cache', async () => {
    const cache = new FakeCache();
    cache.store.set(url('index.html'), new Response('old'));
    const res = await networkFirst(new Request(url('index.html')), deps(cache, async () => new Response('new')), { navigation: false, fallback: url('index.html') });
    expect(await res.text()).toBe('new');
    expect(await (await cache.match(url('index.html')))?.text()).toBe('new');
  });

  it('offline: a navigation with a query string falls back to the precached index.html', async () => {
    const cache = new FakeCache();
    cache.store.set(url('index.html'), new Response('shell'));
    const res = await networkFirst(new Request(url('?from=home')), deps(cache, offline), nav);
    expect(await res.text()).toBe('shell');
  });

  it('a navigation answered with a host error page gets the cached app instead', async () => {
    const cache = new FakeCache();
    cache.store.set(url('index.html'), new Response('shell'));
    const res = await networkFirst(new Request(url('index.html')), deps(cache, async () => new Response('Service Unavailable', { status: 503 })), nav);
    expect(await res.text()).toBe('shell');
    // The error page is never stored over the good copy.
    expect(await (await cache.match(url('index.html')))?.text()).toBe('shell');
  });

  it('a host error page with no cached copy is passed through, and a non-navigation error is not replaced', async () => {
    const empty = await networkFirst(new Request(url('index.html')), deps(new FakeCache(), async () => new Response('gone', { status: 404 })), nav);
    expect(empty.status).toBe(404);
    const cache = new FakeCache();
    cache.store.set(url('corpus.json'), new Response('[]'));
    const res = await networkFirst(new Request(url('corpus.json')), deps(cache, async () => new Response('gone', { status: 404 })), { navigation: false, fallback: url('index.html') });
    expect(res.status).toBe(404);
  });

  it('offline with nothing cached: a 503 that says so', async () => {
    const res = await networkFirst(new Request(url('corpus.json')), deps(new FakeCache(), offline), { navigation: false, fallback: url('index.html') });
    expect(res.status).toBe(503);
  });

  it('a network that hangs: the cached copy is served once the timeout fires', async () => {
    const cache = new FakeCache();
    cache.store.set(url('index.html'), new Response('shell'));
    let waited = 0;
    const res = await networkFirst(
      new Request(url('index.html')),
      deps(cache, () => new Promise(() => {}), async (ms) => {
        waited = ms;
      }),
      nav,
    );
    expect(waited).toBe(3000);
    expect(await res.text()).toBe('shell');
  });

  it('a slow network with no cached copy: keeps waiting for the network', async () => {
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>((r) => {
      release = r;
    });
    const pending = networkFirst(new Request(url('corpus.json')), deps(new FakeCache(), () => slow, async () => {}), { navigation: false, fallback: url('index.html') });
    release(new Response('late'));
    expect(await (await pending).text()).toBe('late');
  });
});

describe('staleCaches', () => {
  it('deletes older builds of this copy and leaves other apps alone', () => {
    const old = cacheName(SCOPE, 'aaa');
    const current = cacheName(SCOPE, 'bbb');
    expect(staleCaches([old, current, 'other-app-v1'], current, SCOPE)).toEqual([old]);
  });

  it('two copies of Caja on one origin keep each other\'s caches', () => {
    const preview = 'https://app.example/preview/apps/caja/';
    expect(cacheName(SCOPE, 'v1')).not.toBe(cacheName(preview, 'v1'));
    const names = [cacheName(SCOPE, 'v1'), cacheName(preview, 'v1'), cacheName(preview, 'v2')];
    expect(staleCaches(names, cacheName(SCOPE, 'v2'), SCOPE)).toEqual([cacheName(SCOPE, 'v1')]);
    expect(staleCaches(names, cacheName(preview, 'v2'), preview)).toEqual([cacheName(preview, 'v1')]);
  });
});
