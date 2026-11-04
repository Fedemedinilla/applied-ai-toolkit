// The service worker's decisions, without the worker. sw.ts wires these to the real events; the
// tests drive them with a fake cache and a fake fetch.
//
// Two strategies:
// - Hashed files under assets/ never change under the same name, so they are served from the
//   cache first. A new build ships new names, and the old ones are deleted on activate.
// - Everything else (index.html, the manifest, the icons, corpus.json) keeps its name across
//   builds, so the network goes first and the cache is the fallback. A cache-first index.html
//   would pin the owner to the first version forever, because it is the file that names the new
//   hashed assets. The network gets NETWORK_TIMEOUT_MS before the cached copy is served: a phone
//   that shows full signal and passes no packets would otherwise leave the till on a blank screen.
//   A navigation that gets an error page (a 404 or 503 from the host or a proxy) is treated like no
//   network at all, so a misbehaving host does not replace the app with its error page.

export const CACHE_PREFIX = 'caja-';
export const NETWORK_TIMEOUT_MS = 3000;

/** FNV-1a, 32 bits, as 8 hex digits. Enough to tell two scopes apart in a cache name. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The cache prefix for one installed copy of the app. Two copies on one origin (GitHub Pages serves
 * every path of a user's site under one host) must not share it, or each would delete the other's
 * precache on activate.
 */
export function scopePrefix(scope: string): string {
  return `${CACHE_PREFIX}${shortHash(scope)}-`;
}

export function cacheName(scope: string, version: string): string {
  return `${scopePrefix(scope)}${version}`;
}

export type Strategy = 'cache-first' | 'network-first' | 'passthrough';

export interface RequestInfo {
  url: string;
  method: string;
  mode: string;
}

/** Which strategy serves a request. Anything outside the app's own scope is left to the browser. */
export function strategyFor(req: RequestInfo, scope: string): Strategy {
  if (req.method !== 'GET') return 'passthrough';
  const url = new URL(req.url);
  const base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return 'passthrough';
  if (req.mode === 'navigate') return 'network-first';
  const path = url.pathname.slice(base.pathname.length);
  return path.startsWith('assets/') ? 'cache-first' : 'network-first';
}

/** The slice of the Cache API the worker uses. */
export interface CacheLike {
  match(request: Request | string, options?: { ignoreSearch?: boolean }): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

export interface Deps {
  fetch(request: Request): Promise<Response>;
  cache(): Promise<CacheLike>;
  /** Resolves after `ms`; injected so the tests do not wait three real seconds. */
  sleep(ms: number): Promise<void>;
}

/** Only complete, same-origin responses are stored. A 404 or an opaque response is not a copy of the app. */
const storable = (res: Response): boolean => res.ok && res.type !== 'opaque';

/** A failed write (a full quota) must not turn a good response into an error. */
async function store(cache: CacheLike, request: Request, res: Response): Promise<void> {
  if (!storable(res)) return;
  try {
    await cache.put(request, res.clone());
  } catch {
    // The response is still served; the next request tries to store it again.
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

const OFFLINE = (): Response =>
  new Response('Sin conexión y sin copia guardada de este archivo.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

/**
 * Network first, cache as fallback. `fallback` is the precached index.html, served for any
 * navigation the cache has no copy of, so a link with a query string still opens offline.
 */
export async function networkFirst(
  request: Request,
  deps: Deps,
  options: { navigation: boolean; fallback: string },
): Promise<Response> {
  const cache = await deps.cache();
  const cached = async (): Promise<Response | undefined> =>
    (await cache.match(request, { ignoreSearch: options.navigation })) ??
    (options.navigation ? await cache.match(options.fallback) : undefined);

  const network = deps.fetch(request).then(async (res) => {
    await store(cache, request, res);
    return res;
  });
  /** A navigation answered with an error page: the cached app is better, when there is one. */
  const orCopy = async (res: Response): Promise<Response> => (options.navigation && !res.ok ? ((await cached()) ?? res) : res);

  const timedOut = Symbol('timeout');
  try {
    const first = await Promise.race([network, deps.sleep(NETWORK_TIMEOUT_MS).then(() => timedOut)]);
    if (first !== timedOut) return await orCopy(first as Response);
    // Slow network: serve the copy if there is one, and let the fetch finish to refresh it.
    const copy = await cached();
    if (copy) {
      network.catch(() => undefined);
      return copy;
    }
    return await orCopy(await network);
  } catch {
    return (await cached()) ?? OFFLINE();
  }
}

/**
 * Cache names to delete on activate: older builds of this copy of the app. Other apps' caches, and
 * the caches of another copy of Caja under a different scope on the same origin, are left alone.
 */
export function staleCaches(names: readonly string[], current: string, scope: string): string[] {
  const prefix = scopePrefix(scope);
  return names.filter((n) => n.startsWith(prefix) && n !== current);
}
