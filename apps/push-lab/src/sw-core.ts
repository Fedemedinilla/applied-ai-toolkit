// The service worker's decisions, without the worker. sw.ts wires these to the real events; the
// tests drive them with fakes and fake timers.
//
// Two WebKit behaviours shape this file.
//
// 1. Navigations are never intercepted. When a navigation goes through a service worker's
//    respondWith(fetch(request)) and the server answers with a redirect (a 302 with no
//    Content-Type, the usual "session expired, go to login"), Safari on iPhone did not follow it.
//    It offered to download the page instead, and the user was locked out with no explanation.
//    The source app hit this on its login redirect. A worker that never calls respondWith for a
//    navigation cannot cause it, so routeFor returns 'passthrough' for every navigation.
//
// 2. A push is shown first and the badge is set after, with a hard cap. On iPhone,
//    navigator.setAppBadge in the worker may never resolve. Two orderings were tried in the source
//    app and both failed:
//    - Promise.all([show, badge]).catch(): a rejected badge settled waitUntil before the
//      notification finished. A push that shows nothing breaks the userVisibleOnly promise, and the
//      browser may stop delivering pushes to the site.
//    - Promise.allSettled([show, badge]): a badge call that never settles keeps waitUntil open
//      until the system kills the worker. The banner was drawn, but the notification was not kept
//      in Notification Center and did not wake the screen.
//    handlePush awaits showNotification to the end, and only then gives the badge at most
//    BADGE_WAIT_MS. The badge is cosmetic; it cannot delay or undo the notification.

import type { WorkerMessage } from './wire.ts';

export const BADGE_WAIT_MS = 1000;
export const CACHE_PREFIX = 'push-lab-';
/** The same as API.subscribe in wire.ts (a test checks), kept here so the worker imports nothing from the page's modules. */
export const SUBSCRIBE_PATH = 'api/subscribe';

export interface PushMessage {
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tag: string | null;
  /** null: leave the badge as it is. A count that did not arrive is not a zero. */
  readonly badge: number | null;
  readonly sentAt: number | null;
}

const DEFAULT: PushMessage = {
  kind: 'unknown',
  title: 'Push Lab',
  body: 'Llegó un aviso.',
  url: './',
  tag: null,
  badge: null,
  sentAt: null,
};

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : null;

/**
 * Reads a push payload (already JSON-parsed, or null). Never throws: a push must always end in a
 * visible notification, so a malformed payload gets the defaults instead of an exception.
 */
export function parsePush(data: unknown): PushMessage {
  if (typeof data !== 'object' || data === null) return DEFAULT;
  const d = data as Record<string, unknown>;
  const badge = d['badge'];
  const sentAt = d['sentAt'];
  return {
    kind: text(d['kind'], 40) ?? DEFAULT.kind,
    title: text(d['title'], 120) ?? DEFAULT.title,
    body: text(d['body'], 400) ?? DEFAULT.body,
    url: text(d['url'], 400) ?? DEFAULT.url,
    tag: text(d['tag'], 80),
    badge: typeof badge === 'number' && Number.isInteger(badge) && badge >= 0 ? Math.min(badge, 999) : null,
    sentAt: typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : null,
  };
}

export interface NotificationSpec {
  readonly body: string;
  readonly icon: string;
  readonly lang: string;
  readonly tag?: string;
  readonly renotify?: boolean;
  readonly data: { readonly url: string };
}

/**
 * The showNotification arguments. `renotify` goes only with a tag: renotify without a tag throws
 * a TypeError, and a throw here would leave the push with nothing visible.
 */
export function notificationFor(message: PushMessage, scope: string): { title: string; options: NotificationSpec } {
  const options: NotificationSpec = {
    body: message.body,
    icon: new URL('icon-192.png', scope).href,
    lang: 'es',
    data: { url: clickTarget(message.url, scope) },
    ...(message.tag === null ? {} : { tag: `push-lab-${message.tag}`, renotify: true }),
  };
  return { title: message.title, options };
}

/** Where a click goes: the payload's URL resolved against the scope, and kept inside it. */
export function clickTarget(url: string, scope: string): string {
  try {
    const target = new URL(url, scope);
    return target.href.startsWith(scope) ? target.href : scope;
  } catch {
    return scope;
  }
}

export type BadgeOutcome = 'skipped' | 'set' | 'cleared' | 'unsupported' | 'failed' | 'timed_out';

export interface PushDeps {
  show(title: string, options: NotificationSpec): Promise<void>;
  /** The worker's own badge API, or null when `setAppBadge` is not on the worker's navigator. */
  readonly badge: { set(count: number): Promise<void>; clear(): Promise<void> } | null;
  /** Posts to every open window of the app. A page can set the badge when the worker cannot. */
  tellPages(message: WorkerMessage): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface PushOutcome {
  readonly shown: boolean;
  readonly badge: BadgeOutcome;
}

/** What the push event's waitUntil awaits. Resolves at most BADGE_WAIT_MS after the notification settles. Never rejects. */
export async function handlePush(message: PushMessage, scope: string, deps: PushDeps): Promise<PushOutcome> {
  const { title, options } = notificationFor(message, scope);
  let shown = true;
  try {
    await deps.show(title, options);
  } catch {
    shown = false; // nothing else to try; the badge below still runs
  }

  const count = message.badge;
  const viaWorker = (async (): Promise<BadgeOutcome> => {
    if (count === null) return 'skipped';
    if (!deps.badge) return 'unsupported';
    try {
      // Inside the try: a synchronous throw from the API counts as a failure, not an exception.
      if (count > 0) await deps.badge.set(count);
      else await deps.badge.clear();
      return count > 0 ? 'set' : 'cleared';
    } catch {
      return 'failed';
    }
  })();
  const viaPages = (async () => {
    try {
      await deps.tellPages({ type: 'push', kind: message.kind, sentAt: message.sentAt, badge: count });
    } catch {
      // no window open, or it went away
    }
  })();

  const settled = Promise.all([viaWorker, viaPages]).then(([badge]) => badge);
  const capped = deps.sleep(BADGE_WAIT_MS).then((): BadgeOutcome => 'timed_out');
  return { shown, badge: await Promise.race([settled, capped]) };
}

export interface WindowLike {
  readonly url: string;
  focus(): Promise<unknown>;
  /** WindowClient.navigate. Missing in some browsers, and it rejects for a window the worker does not control. */
  navigate?(url: string): Promise<unknown>;
}

/**
 * On click: bring an open window of the app forward and take it to the target, or open the target
 * when no window is open. Focus comes first, while the click still counts as a user gesture.
 * Without the navigate step, a notification that points at a deeper URL (or at ?from=notification)
 * would only surface the window as it was, in the common case where the app is already open.
 */
export async function handleClick(
  target: string,
  scope: string,
  deps: { windows(): Promise<readonly WindowLike[]>; open(url: string): Promise<unknown> },
): Promise<'focused' | 'navigated' | 'opened'> {
  const url = clickTarget(target, scope);
  const open = (await deps.windows()).find((w) => w.url.startsWith(scope));
  if (!open) {
    await deps.open(url);
    return 'opened';
  }
  await open.focus();
  if (open.url === url || !open.navigate) return 'focused';
  try {
    await open.navigate(url);
    return 'navigated';
  } catch {
    return 'focused'; // the window is in front, at its old URL; still better than nothing
  }
}

export interface SubscriptionLike {
  toJSON(): PushSubscriptionJSON;
}

/**
 * pushsubscriptionchange: the browser rotated the subscription on its own. The server still holds
 * the old endpoint, which now answers 410, gets deleted, and the page goes on saying "enabled".
 * This registers the new one. Safari may never fire the event, so the page also registers its
 * subscription on every load; this is the second path, not the only one.
 */
export async function resubscribe(deps: {
  readonly newSubscription: SubscriptionLike | null;
  readonly oldKey: BufferSource | null;
  subscribe(key: BufferSource): Promise<SubscriptionLike>;
  register(json: PushSubscriptionJSON): Promise<boolean>;
}): Promise<'registered' | 'no_key' | 'failed'> {
  try {
    let subscription = deps.newSubscription;
    if (!subscription) {
      if (!deps.oldKey) return 'no_key';
      subscription = await deps.subscribe(deps.oldKey);
    }
    return (await deps.register(subscription.toJSON())) ? 'registered' : 'failed';
  } catch {
    return 'failed';
  }
}

export type Route = 'passthrough' | 'cache-first';

/**
 * Which requests the worker answers. Only GETs for hashed build files under assets/, which never
 * change under one name. Everything else, and every navigation whatever its URL, goes straight to
 * the network with no respondWith at all.
 */
export function routeFor(request: { readonly method: string; readonly mode: string; readonly url: string }, scope: string): Route {
  if (request.mode === 'navigate') return 'passthrough';
  if (request.method !== 'GET') return 'passthrough';
  if (!request.url.startsWith(new URL('assets/', scope).href)) return 'passthrough';
  return 'cache-first';
}

/** FNV-1a, 32 bits, as hex: two copies of the app on one origin get different cache names. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function cacheName(scope: string, version: string): string {
  return `${CACHE_PREFIX}${shortHash(scope)}-${version}`;
}

/** Caches of this scope from earlier builds. Other scopes' caches are left alone. */
export function staleCaches(names: readonly string[], current: string, scope: string): string[] {
  const prefix = `${CACHE_PREFIX}${shortHash(scope)}-`;
  return names.filter((name) => name.startsWith(prefix) && name !== current);
}
