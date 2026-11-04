// The service worker's decisions, without the worker, so the tests can drive them with a fake cache
// and a fake fetch. Hashed files under assets/ never change under one name and are served from the
// cache first. Everything else (index.html, the manifest, the icons) keeps its name across builds and
// goes to the network first, with the cache as the fallback: a cache-first index.html would keep a
// phone on the first build forever.

export const CACHE_PREFIX = 'replay-lab-';
export const NETWORK_TIMEOUT_MS = 3000;

export type Strategy = 'cache-first' | 'network-first' | 'passthrough';

export interface RequestLike {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
}

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

export function strategyFor(req: RequestLike, scope: string): Strategy {
  if (req.method !== 'GET') return 'passthrough';
  const url = new URL(req.url);
  const base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return 'passthrough';
  if (req.mode === 'navigate') return 'network-first';
  return url.pathname.slice(base.pathname.length).startsWith('assets/') ? 'cache-first' : 'network-first';
}

export interface CacheLike {
  match(request: Request | string, options?: { ignoreSearch?: boolean }): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

export interface Deps {
  fetch(request: Request): Promise<Response>;
  cache(): Promise<CacheLike>;
  sleep(ms: number): Promise<void>;
}

async function store(cache: CacheLike, request: Request, res: Response): Promise<void> {
  if (!res.ok || res.type === 'opaque') return;
  try {
    await cache.put(request, res.clone());
  } catch {
    // A full quota must not turn a good response into an error.
  }
}

export async function cacheFirst(request: Request, deps: Deps): Promise<Response> {
  const cache = await deps.cache();
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await deps.fetch(request);
  await store(cache, request, res);
  return res;
}

const offline = (): Response =>
  new Response('Offline, and this file was never cached.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** Network first; after NETWORK_TIMEOUT_MS or on failure, the cached copy (for a navigation, index.html). */
export async function networkFirst(request: Request, deps: Deps, options: { navigation: boolean; fallback: string }): Promise<Response> {
  const cache = await deps.cache();
  const cached = async (): Promise<Response | undefined> =>
    (await cache.match(request, { ignoreSearch: options.navigation })) ?? (options.navigation ? await cache.match(options.fallback) : undefined);
  const network = deps.fetch(request).then(async (res) => {
    await store(cache, request, res);
    return res;
  });
  const timedOut = Symbol('timeout');
  try {
    const first = await Promise.race([network, deps.sleep(NETWORK_TIMEOUT_MS).then(() => timedOut)]);
    if (first !== timedOut) {
      const res = first as Response;
      // A host error page for a navigation: the cached app is better, when there is one.
      return options.navigation && !res.ok ? ((await cached()) ?? res) : res;
    }
    const copy = await cached();
    if (copy) {
      network.catch(() => undefined);
      return copy;
    }
    return await network;
  } catch {
    return (await cached()) ?? offline();
  }
}

export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current);
}
