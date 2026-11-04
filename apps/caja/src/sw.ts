// The service worker. The build (vite.config.ts) replaces the two placeholders below with the
// list of every file it wrote and a hash of their contents, so each build gets its own cache.
//
// The project's TypeScript lib is DOM, not WebWorker (one program cannot have both), so the few
// worker types used here are declared locally.

import { cacheFirst, cacheName, networkFirst, staleCaches, strategyFor, type Deps } from './sw-core.ts';

declare const __CAJA_PRECACHE__: string[];
declare const __CAJA_VERSION__: string;

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  registration: { scope: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const worker = self as unknown as WorkerScope;
const scope = worker.registration.scope;
const CACHE = cacheName(scope, __CAJA_VERSION__);
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
      // cache: 'reload' skips the HTTP cache, so the precache cannot be filled with a stale copy
      // of a file whose name did not change (index.html, corpus.json).
      await cache.addAll(__CAJA_PRECACHE__.map((path) => new Request(new URL(path, scope), { cache: 'reload' })));
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
  event.respondWith(
    strategy === 'cache-first'
      ? cacheFirst(request, deps)
      : networkFirst(request, deps, { navigation: request.mode === 'navigate', fallback }),
  );
});
