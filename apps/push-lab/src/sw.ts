// The service worker. Built unhashed as sw.js at the root of the output (vite.config.ts), which
// also replaces __PUSH_LAB_VERSION__ with a hash of the build.
//
// The project's TypeScript lib is DOM, not WebWorker (one program cannot have both), so the
// worker types used here are declared locally.

// Only sw-core.ts, and types from wire.ts. A value import shared with the page would become a
// shared chunk, and an ES import in a classic worker script stops it from installing.
import {
  cacheName,
  handleClick,
  handlePush,
  parsePush,
  resubscribe,
  routeFor,
  staleCaches,
  SUBSCRIBE_PATH,
  type NotificationSpec,
} from './sw-core.ts';
import type { WorkerMessage } from './wire.ts';

declare const __PUSH_LAB_VERSION__: string;

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface PushEvent extends ExtendableEvent {
  readonly data: { json(): unknown } | null;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: { close(): void; readonly data: unknown };
}
interface SubscriptionChangeEvent extends ExtendableEvent {
  readonly newSubscription: PushSubscription | null;
  readonly oldSubscription: PushSubscription | null;
}
interface MessageEventLike extends ExtendableEvent {
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
}
interface WindowClientLike {
  readonly url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
  postMessage(message: WorkerMessage): void;
}
interface WorkerScope {
  readonly registration: {
    readonly scope: string;
    readonly pushManager: PushManager;
    showNotification(title: string, options: NotificationSpec): Promise<void>;
  };
  readonly navigator: { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
  addEventListener(type: 'pushsubscriptionchange', listener: (event: SubscriptionChangeEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

declare const self: WorkerScope;
const scope = self.registration.scope;
const CACHE = cacheName(scope, __PUSH_LAB_VERSION__);

const windows = () => self.clients.matchAll({ type: 'window', includeUncontrolled: true });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(staleCaches(await caches.keys(), CACHE, scope).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  // No respondWith for anything but hashed assets: navigations, the API and the rest go to the
  // browser as if there were no worker. See routeFor for why navigations matter on iPhone.
  if (routeFor(event.request, scope) !== 'cache-first') return;
  const { request } = event;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
      }
      return response;
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data: unknown = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null; // not JSON: show the default text rather than nothing
  }
  const nav = self.navigator;
  const set = nav.setAppBadge;
  const clear = nav.clearAppBadge;
  event.waitUntil(
    handlePush(parsePush(data), scope, {
      show: (title, options) => self.registration.showNotification(title, options),
      badge: set && clear ? { set: (n) => set.call(nav, n), clear: () => clear.call(nav) } : null,
      tellPages: async (message) => {
        for (const client of await windows()) client.postMessage(message);
      },
      sleep,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = typeof data === 'object' && data !== null && 'url' in data && typeof data.url === 'string' ? data.url : './';
  event.waitUntil(handleClick(url, scope, { windows, open: (target) => self.clients.openWindow(target) }));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    resubscribe({
      newSubscription: event.newSubscription,
      oldKey: event.oldSubscription?.options.applicationServerKey ?? null,
      subscribe: (key) => self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
      // toJSON() is { endpoint, expirationTime, keys }; the server validates it and keeps only
      // the endpoint and the keys.
      register: async (json) => {
        const response = await fetch(new URL(SUBSCRIBE_PATH, scope), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(json),
        });
        return response.ok;
      },
    }),
  );
});

// The page asks what the worker sees, so the lab can show on the device itself whether
// setAppBadge exists inside the worker, not only in the page.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'worker-info?') return;
  const reply: WorkerMessage = { type: 'worker-info', badgeApi: typeof self.navigator.setAppBadge === 'function' };
  event.ports[0]?.postMessage(reply);
});
