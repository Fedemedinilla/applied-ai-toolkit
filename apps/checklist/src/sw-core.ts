// The service worker's decisions, without the worker, so the tests can drive them with a fake
// cache and a fake fetch. sw.ts wires them to the worker events.
//
// Hashed files under assets/ never change under one name: cache first. Everything else
// (index.html, catalogue.json, the manifest, the icons) keeps its name across builds: network
// first with a timeout, then the cache. A cache-first index.html would pin a visitor to the first
// build forever, because it is the file that names the new hashed assets.

export const CACHE_PREFIX = 'site-checklist-';
export const NETWORK_TIMEOUT_MS = 3000;

export type Strategy = 'cache-first' | 'network-first' | 'passthrough';

export function strategyFor(req: { url: string; method: string; mode: string }, scope: string): Strategy {
  if (req.method !== 'GET') return 'passthrough';
  const url = new URL(req.url);
  const base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return 'passthrough';
  if (req.mode === 'navigate') return 'network-first';
  return url.pathname.slice(base.pathname.length).startsWith('assets/') ? 'cache-first' : 'network-first';
}

export interface CacheLike {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

export interface Deps {
  fetch(request: Request): Promise<Response>;
  cache(): Promise<CacheLike>;
  sleep(ms: number): Promise<void>;
}

const offline = (): Response => new Response('Offline, and this file was never cached.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export async function cacheFirst(request: Request, deps: Deps): Promise<Response> {
  const cache = await deps.cache();
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await deps.fetch(request);
    if (res.ok) await cache.put(request, res.clone()).catch(() => undefined);
    return res;
  } catch {
    return offline();
  }
}

/**
 * Network first. A navigation that gets an error status from the host is treated like no network,
 * so a host's error page does not replace the app; `fallback` is the cached index.html.
 */
export async function networkFirst(request: Request, deps: Deps, opts: { navigation: boolean; fallback: string }): Promise<Response> {
  const cache = await deps.cache();
  const fromCache = async (): Promise<Response | undefined> => (await cache.match(request)) ?? (opts.navigation ? cache.match(opts.fallback) : undefined);
  const network = deps.fetch(request).then(
    async (res) => {
      if (res.ok) {
        await cache.put(request, res.clone()).catch(() => undefined);
        return res;
      }
      return opts.navigation ? ((await fromCache()) ?? res) : res;
    },
    async () => (await fromCache()) ?? offline(),
  );
  const timeout = deps.sleep(NETWORK_TIMEOUT_MS).then(async () => (await fromCache()) ?? network);
  return Promise.race([network, timeout]);
}

/**
 * The cache prefix of one installed copy. Two copies on one origin (a static host serves every
 * path of a user's site under one host) must not share it, or each would delete the other's cache.
 */
export function scopePrefix(scope: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < scope.length; i++) h = Math.imul(h ^ scope.charCodeAt(i), 0x01000193);
  return `${CACHE_PREFIX}${(h >>> 0).toString(16).padStart(8, '0')}-`;
}

/** Caches of this copy of the app other than the current one. */
export const staleCaches = (names: readonly string[], current: string, scope: string): string[] =>
  names.filter((n) => n.startsWith(scopePrefix(scope)) && n !== current);
