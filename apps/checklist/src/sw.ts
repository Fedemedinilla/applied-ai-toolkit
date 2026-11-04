// The service worker. The build (vite.config.ts) replaces the two placeholders with the list of
// every file it wrote and a hash of their contents, so each build gets its own cache.
//
// The project's TypeScript lib is DOM, not WebWorker, so the few worker types used here are
// declared locally and the global scope is checked at run time instead of cast.

import { cacheFirst, networkFirst, staleCaches, scopePrefix, strategyFor, type Deps } from './sw-core.ts';

declare const __CHECKLIST_PRECACHE__: string[];
declare const __CHECKLIST_VERSION__: string;

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly registration: { readonly scope: string };
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

function isWorkerScope(scope: unknown): scope is WorkerScope {
  return typeof scope === 'object' && scope !== null && 'registration' in scope && 'skipWaiting' in scope;
}

function start(worker: WorkerScope): void {
  const scope = worker.registration.scope;
  const CACHE = `${scopePrefix(scope)}${__CHECKLIST_VERSION__}`;
  const fallback = new URL('index.html', scope).href;
  const deps: Deps = {
    fetch: (request) => fetch(request),
    cache: () => caches.open(CACHE),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  worker.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE);
        // cache: 'reload' skips the HTTP cache, so an old index.html cannot fill the new precache.
        await cache.addAll(__CHECKLIST_PRECACHE__.map((path) => new Request(new URL(path, scope), { cache: 'reload' })));
        await worker.skipWaiting();
      })(),
    );
  });

  worker.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        await Promise.all(staleCaches(await caches.keys(), CACHE, scope).map((name) => caches.delete(name)));
        await worker.clients.claim();
      })(),
    );
  });

  worker.addEventListener('fetch', (event) => {
    const { request } = event;
    const strategy = strategyFor(request, scope);
    if (strategy === 'passthrough') return;
    event.respondWith(strategy === 'cache-first' ? cacheFirst(request, deps) : networkFirst(request, deps, { navigation: request.mode === 'navigate', fallback }));
  });
}

const globalScope: unknown = globalThis;
if (isWorkerScope(globalScope)) start(globalScope);
