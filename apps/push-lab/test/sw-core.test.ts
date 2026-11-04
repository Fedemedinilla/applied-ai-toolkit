// The worker's decisions with fakes. The push ordering runs under fake timers: what matters is
// when handlePush resolves relative to showNotification and the badge, not that it resolves.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BADGE_WAIT_MS,
  cacheName,
  clickTarget,
  handleClick,
  handlePush,
  notificationFor,
  parsePush,
  resubscribe,
  routeFor,
  staleCaches,
  SUBSCRIBE_PATH,
  type PushDeps,
  type PushOutcome,
} from '../src/sw-core.ts';
import { API, type WorkerMessage } from '../src/wire.ts';

const SCOPE = 'https://lab.example.test/push-lab/';

/** A promise with its resolve and reject, to settle from the test. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = () => new Promise<void>(() => undefined);

interface Probe {
  deps: PushDeps;
  events: string[];
  pages: WorkerMessage[];
}

function probe(overrides: Partial<PushDeps> = {}): Probe {
  const events: string[] = [];
  const pages: WorkerMessage[] = [];
  const deps: PushDeps = {
    show: async (title) => {
      events.push(`show:${title}`);
    },
    badge: {
      set: async (n) => {
        events.push(`badge:${n}`);
      },
      clear: async () => {
        events.push('badge:clear');
      },
    },
    tellPages: async (message) => {
      pages.push(message);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
  return { deps, events, pages };
}

/** Starts handlePush and records when it settles. */
function start(message: Parameters<typeof handlePush>[0], deps: PushDeps) {
  let outcome: PushOutcome | null = null;
  const promise = handlePush(message, SCOPE, deps).then((o) => (outcome = o));
  return { promise, done: () => outcome };
}

const withBadge = (badge: number | null) => parsePush({ kind: 'test', title: 'T', body: 'B', tag: 'test-1', badge });

describe('handlePush: the notification first, the badge after, capped', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a badge call that never settles holds the event at most BADGE_WAIT_MS after the notification', async () => {
    const shown = deferred();
    const { deps } = probe({ show: () => shown.promise, badge: { set: never, clear: never } });
    const run = start(withBadge(3), deps);

    await vi.advanceTimersByTimeAsync(5000);
    expect(run.done()).toBeNull(); // still waiting for the notification, however long it takes

    shown.resolve();
    await vi.advanceTimersByTimeAsync(BADGE_WAIT_MS - 1);
    expect(run.done()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.done()).toEqual({ shown: true, badge: 'timed_out' });
  });

  it('a badge call that rejects at once cannot settle the event before the notification is shown', async () => {
    const shown = deferred();
    const { deps } = probe({
      show: () => shown.promise,
      badge: { set: () => Promise.reject(new Error('no badge')), clear: never },
    });
    const run = start(withBadge(3), deps);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run.done()).toBeNull();
    shown.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done()).toEqual({ shown: true, badge: 'failed' });
  });

  it('the badge is not even requested until showNotification has settled', async () => {
    const shown = deferred();
    const { deps, events } = probe({ show: () => shown.promise });
    const run = start(withBadge(2), deps);
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([]);
    shown.resolve();
    await run.promise;
    expect(events).toEqual(['badge:2']);
  });

  it('a fast badge finishes the event as soon as it settles, without waiting for the cap', async () => {
    const { deps, events, pages } = probe();
    const run = start(withBadge(4), deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done()).toEqual({ shown: true, badge: 'set' });
    expect(events).toEqual(['show:T', 'badge:4']);
    expect(pages).toEqual([{ type: 'push', kind: 'test', sentAt: null, badge: 4 }]);
  });

  it('zero clears the badge; a missing count leaves it alone and still tells the pages', async () => {
    const zero = probe();
    const a = start(withBadge(0), zero.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.done()?.badge).toBe('cleared');
    expect(zero.events).toContain('badge:clear');

    const none = probe();
    const b = start(withBadge(null), none.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.done()?.badge).toBe('skipped');
    expect(none.events).toEqual(['show:T']);
    expect(none.pages).toEqual([{ type: 'push', kind: 'test', sentAt: null, badge: null }]);
  });

  it('a worker without setAppBadge still tells the pages, which may have it', async () => {
    const { deps, pages } = probe({ badge: null });
    const run = start(withBadge(5), deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done()?.badge).toBe('unsupported');
    expect(pages[0]).toMatchObject({ badge: 5 });
  });

  it('a page message that hangs is capped like the badge', async () => {
    const { deps } = probe({ tellPages: never });
    const run = start(withBadge(1), deps);
    await vi.advanceTimersByTimeAsync(BADGE_WAIT_MS - 1);
    expect(run.done()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.done()?.badge).toBe('timed_out');
  });

  it('a badge API that throws synchronously is a failure, not an exception', async () => {
    const { deps } = probe({
      badge: {
        set: () => {
          throw new TypeError('boom');
        },
        clear: never,
      },
    });
    const run = start(withBadge(1), deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done()).toEqual({ shown: true, badge: 'failed' });
  });

  it('a failed showNotification is reported and never rejects the event', async () => {
    const { deps, events } = probe({ show: () => Promise.reject(new TypeError('bad options')) });
    const run = start(withBadge(2), deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done()).toEqual({ shown: false, badge: 'set' });
    expect(events).toEqual(['badge:2']);
  });
});

describe('parsePush and notificationFor', () => {
  it('fills defaults for a missing or malformed payload, so a push always shows something', () => {
    for (const data of [null, 'text', 42, [], { title: 7, body: '' }]) {
      const message = parsePush(data);
      expect(message.title).toBe('Push Lab');
      expect(message.body).not.toBe('');
      expect(message.badge).toBeNull();
    }
  });

  it('accepts only a non-negative integer badge, capped at 999', () => {
    expect(parsePush({ badge: 3 }).badge).toBe(3);
    expect(parsePush({ badge: 5000 }).badge).toBe(999);
    for (const badge of [-1, 1.5, '3', null, Number.NaN]) expect(parsePush({ badge }).badge).toBeNull();
  });

  it('sets renotify only together with a tag: renotify without a tag throws a TypeError', () => {
    const tagged = notificationFor(parsePush({ tag: 'test-1' }), SCOPE).options;
    expect(tagged).toMatchObject({ tag: 'push-lab-test-1', renotify: true });
    const untagged = notificationFor(parsePush({}), SCOPE).options;
    expect(untagged).not.toHaveProperty('tag');
    expect(untagged).not.toHaveProperty('renotify');
  });

  it('resolves the icon and the click URL against the scope', () => {
    const { options } = notificationFor(parsePush({ url: './?from=notification' }), SCOPE);
    expect(options.icon).toBe(`${SCOPE}icon-192.png`);
    expect(options.data.url).toBe(`${SCOPE}?from=notification`);
  });
});

describe('notification clicks', () => {
  it('keeps the target inside the scope', () => {
    expect(clickTarget('https://elsewhere.example.test/', SCOPE)).toBe(SCOPE);
    expect(clickTarget('../other/', SCOPE)).toBe(SCOPE);
    expect(clickTarget('./?a=1', SCOPE)).toBe(`${SCOPE}?a=1`);
  });

  it('focuses an open window of the app instead of opening a second one', async () => {
    const focused: string[] = [];
    const opened: string[] = [];
    const windows = async () => [
      { url: 'https://lab.example.test/other/', focus: async () => focused.push('other') },
      { url: `${SCOPE}?x=1`, focus: async () => focused.push('app') },
    ];
    expect(await handleClick('./', SCOPE, { windows, open: async (u) => opened.push(u) })).toBe('focused');
    expect(focused).toEqual(['app']);
    expect(await handleClick('./?from=notification', SCOPE, { windows: async () => [], open: async (u) => opened.push(u) })).toBe('opened');
    expect(opened).toEqual([`${SCOPE}?from=notification`]);
  });

  it('takes an open window to the target after focusing it, so the arrival note shows', async () => {
    const calls: string[] = [];
    const windows = async () => [
      { url: SCOPE, focus: async () => calls.push('focus'), navigate: async (u: string) => calls.push(`navigate ${u}`) },
    ];
    const result = await handleClick('./?from=notification', SCOPE, { windows, open: async () => calls.push('open') });
    expect(result).toBe('navigated');
    expect(calls).toEqual(['focus', `navigate ${SCOPE}?from=notification`]);
  });

  it('only focuses when the window is already at the target, has no navigate, or navigate rejects', async () => {
    const at = { url: `${SCOPE}?from=notification`, focus: async () => 0, navigate: () => Promise.reject(new Error('not called')) };
    expect(await handleClick('./?from=notification', SCOPE, { windows: async () => [at], open: async () => 0 })).toBe('focused');
    const old = { url: SCOPE, focus: async () => 0 };
    expect(await handleClick('./?from=notification', SCOPE, { windows: async () => [old], open: async () => 0 })).toBe('focused');
    const refusing = { url: SCOPE, focus: async () => 0, navigate: () => Promise.reject(new TypeError('not controlled')) };
    expect(await handleClick('./?from=notification', SCOPE, { windows: async () => [refusing], open: async () => 0 })).toBe('focused');
  });
});

describe('resubscribe on pushsubscriptionchange', () => {
  const json = { endpoint: 'https://push.example.test/new', keys: { p256dh: 'p', auth: 'a' } };
  const sub = { toJSON: () => json };

  it('registers the new subscription the event carries', async () => {
    const registered: unknown[] = [];
    const result = await resubscribe({
      newSubscription: sub,
      oldKey: null,
      subscribe: () => Promise.reject(new Error('not called')),
      register: async (j) => registered.push(j) > 0,
    });
    expect(result).toBe('registered');
    expect(registered).toEqual([json]);
  });

  it('subscribes again with the old key when the event carries none', async () => {
    const key = new Uint8Array([4, 1, 2]);
    const keys: unknown[] = [];
    const result = await resubscribe({
      newSubscription: null,
      oldKey: key,
      subscribe: async (k) => {
        keys.push(k);
        return sub;
      },
      register: async () => true,
    });
    expect(result).toBe('registered');
    expect(keys).toEqual([key]);
  });

  it('reports no_key and failed without throwing', async () => {
    const base = { subscribe: async () => sub, register: async () => true };
    expect(await resubscribe({ ...base, newSubscription: null, oldKey: null })).toBe('no_key');
    expect(await resubscribe({ ...base, newSubscription: sub, oldKey: null, register: async () => false })).toBe('failed');
    expect(await resubscribe({ ...base, newSubscription: null, oldKey: new Uint8Array(1), subscribe: () => Promise.reject(new Error('x')) })).toBe('failed');
  });

  it('posts to the same path as the page', () => {
    expect(SUBSCRIBE_PATH).toBe(API.subscribe);
  });
});

describe('routeFor: navigations are never intercepted', () => {
  const req = (url: string, mode = 'cors', method = 'GET') => ({ url, mode, method });

  it('passes every navigation through, even one under assets/', () => {
    for (const url of [SCOPE, `${SCOPE}?from=notification`, `${SCOPE}api/redirect-check`, `${SCOPE}assets/index-abc.js`]) {
      expect(routeFor(req(url, 'navigate'), SCOPE)).toBe('passthrough');
    }
  });

  it('caches only GETs of hashed files under this scope', () => {
    expect(routeFor(req(`${SCOPE}assets/index-abc.js`), SCOPE)).toBe('cache-first');
    expect(routeFor(req(`${SCOPE}assets/index-abc.js`, 'cors', 'POST'), SCOPE)).toBe('passthrough');
    expect(routeFor(req(`${SCOPE}api/diagnose`), SCOPE)).toBe('passthrough');
    expect(routeFor(req(`${SCOPE}manifest.webmanifest`), SCOPE)).toBe('passthrough');
    expect(routeFor(req('https://lab.example.test/other/assets/x.js'), SCOPE)).toBe('passthrough');
  });
});

describe('cache names', () => {
  it('deletes older builds of this scope only', () => {
    const current = cacheName(SCOPE, 'v2');
    const names = [cacheName(SCOPE, 'v1'), current, cacheName('https://lab.example.test/copy/', 'v1'), 'unrelated'];
    expect(staleCaches(names, current, SCOPE)).toEqual([cacheName(SCOPE, 'v1')]);
  });
});
