// @vitest-environment jsdom
//
// The page in a DOM, against the real index.html markup and the real server handler. Only the
// browser's push machinery (permission, the registration, the subscription) is faked.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountApp, type AppDeps, type InstallPrompt, type PushEnv, type SubscriptionLike } from '../src/app.ts';
import { detectPlatform, type Platform } from '../src/platform.ts';
import { base64UrlToBytes, type WorkerMessage } from '../src/wire.ts';
import { createHandler } from '../server/handler.ts';
import type { Sender } from '../server/push.ts';
import { memoryStore, type SubscriptionStore } from '../server/store.ts';
import { generateVapidPair } from '../server/vapid.ts';
import { fakeDevice } from './helpers/fake-push-service.ts';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');
const vapid = { ...generateVapidPair(), subject: 'mailto:lab@example.test' };

const DESKTOP: Platform = { os: 'other', installed: false, pushNeedsInstall: false };
const IPHONE_TAB = detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5, displayStandalone: false, navigatorStandalone: false });
const IPHONE_APP = detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5, displayStandalone: true, navigatorStandalone: true });

class FakeSubscription implements SubscriptionLike {
  readonly device = fakeDevice(String(Math.random()).slice(2));
  readonly endpoint = this.device.endpoint;
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  active = true;
  constructor(key: BufferSource | null) {
    const bytes = key === null ? null : ArrayBuffer.isView(key) ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key.slice(0);
    this.options = { applicationServerKey: bytes instanceof ArrayBuffer ? bytes : null };
  }
  toJSON(): PushSubscriptionJSON {
    return { endpoint: this.endpoint, expirationTime: null, keys: { ...this.device.keys } };
  }
  async unsubscribe(): Promise<boolean> {
    this.active = false;
    return true;
  }
}

interface Options {
  platform?: Platform;
  push?: boolean;
  permission?: NotificationPermission;
  grant?: NotificationPermission;
  existing?: boolean;
  /** The key the existing subscription was made with: the server's (default), another pair's, or none reported. */
  existingKey?: 'server' | 'other' | null;
  store?: SubscriptionStore;
  send?: Sender;
  badge?: boolean;
  search?: string;
  subscribeError?: { name: string; message: string } | null;
}

function mount(options: Options = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));

  const store = options.store ?? memoryStore();
  const sent: unknown[] = [];
  const send: Sender = options.send ?? (async (_sub, payload) => void sent.push(JSON.parse(payload)));
  const handler = createHandler({ store, send, vapid, minIntervalMs: 0, allowAnyEndpoint: true });
  const requests: string[] = [];

  let permission: NotificationPermission = options.permission ?? 'default';
  const existingKey =
    options.existingKey === null ? null : base64UrlToBytes(options.existingKey === 'other' ? generateVapidPair().publicKey : vapid.publicKey);
  let current: FakeSubscription | null = options.existing ? new FakeSubscription(existingKey) : null;
  const subscribeCalls: BufferSource[] = [];
  let subscribeError = options.subscribeError ?? null;
  const workerListeners: Array<(m: WorkerMessage) => void> = [];
  const push: PushEnv = {
    permission: () => permission,
    requestPermission: async () => (permission = options.grant ?? 'granted'),
    ready: async () => ({
      pushManager: {
        getSubscription: async () => (current?.active ? current : null),
        subscribe: async ({ applicationServerKey }) => {
          subscribeCalls.push(applicationServerKey);
          if (subscribeError) {
            const error = Object.assign(new Error(subscribeError.message), { name: subscribeError.name });
            subscribeError = null;
            throw error;
          }
          current = new FakeSubscription(applicationServerKey);
          return current;
        },
      },
    }),
    onWorkerMessage: (listener) => void workerListeners.push(listener),
    askWorker: async () => ({ badgeApi: false }),
  };

  const badgeCalls: string[] = [];
  let installListener: ((p: InstallPrompt) => void) | null = null;
  const deps: AppDeps = {
    platform: options.platform ?? DESKTOP,
    fetch: async (path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      return handler(new Request(`http://lab.test/${path}`, init));
    },
    push: options.push === false ? null : push,
    badge:
      options.badge === false
        ? null
        : { set: async (n) => void badgeCalls.push(`set:${n}`), clear: async () => void badgeCalls.push('clear') },
    onInstallPrompt: (listener) => {
      installListener = listener;
    },
    onInstalled: () => undefined,
    search: options.search ?? '',
    now: () => new Date(2026, 10, 4, 9, 30, 0),
  };
  mountApp(document, deps);

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    $,
    store,
    sent,
    requests,
    badgeCalls,
    subscribeCalls,
    current: () => current,
    worker: (m: WorkerMessage) => workerListeners.forEach((l) => l(m)),
    install: (p: InstallPrompt) => installListener?.(p),
    text: (id: string) => $(id).textContent ?? '',
  };
}

describe('install instructions per platform', () => {
  it('an iPhone in a Safari tab gets the Add to Home Screen steps and no enable button', async () => {
    const app = mount({ platform: IPHONE_TAB, push: false });
    expect(app.text('install-body')).toContain('Agregar a inicio');
    expect(app.text('install-body')).toContain('16.4');
    await vi.waitFor(() => expect(app.text('enable-text')).toContain('Primero agrega la app'));
    expect(app.$<HTMLButtonElement>('enable-button').disabled).toBe(true);
    expect(app.text('facts')).toContain('iPhone o iPad');
  });

  it('the installed iPhone app says so and offers to enable', async () => {
    const app = mount({ platform: IPHONE_APP });
    expect(app.text('install-body')).toContain('app instalada');
    await vi.waitFor(() => expect(app.$<HTMLButtonElement>('enable-button').disabled).toBe(false));
  });

  it('Android offers the browser install prompt from its own button, once', async () => {
    const app = mount({ platform: { os: 'android', installed: false, pushNeedsInstall: false } });
    const prompt = vi.fn(async () => undefined);
    app.install({ prompt, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    const button = app.$<HTMLButtonElement>('install-button');
    expect(button.hidden).toBe(false);
    button.click();
    await vi.waitFor(() => expect(button.hidden).toBe(true));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(app.text('install-status')).toContain('más tarde');
  });
});

describe('enabling push', () => {
  it('asks permission on click, subscribes with the server key and registers the device', async () => {
    const app = mount();
    const button = app.$<HTMLButtonElement>('enable-button');
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(app.$<HTMLButtonElement>('test-button').disabled).toBe(true);
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe('Desactivar'));
    const key = app.subscribeCalls[0];
    expect(key && Buffer.from(key as Uint8Array).toString('base64url')).toBe(vapid.publicKey);
    expect(await app.store.get(app.current()?.endpoint ?? '')).toBeDefined();
    expect(app.$<HTMLButtonElement>('test-button').disabled).toBe(false);
    expect(app.text('log')).toContain('Suscripción creada');
  });

  it('re-registers an existing subscription on every load, so a server that lost it gets it back', async () => {
    const app = mount({ existing: true, permission: 'granted' });
    await vi.waitFor(async () => expect(await app.store.list()).toHaveLength(1));
    expect(app.text('enable-text')).toContain('Activados');
  });

  it('on load, drops a subscription made with a key the server no longer has, on both sides', async () => {
    const app = mount({ existing: true, existingKey: 'other', permission: 'granted' });
    const stale = app.current();
    // The button starts as "Activar" in the markup, so wait for the message, not the label.
    await vi.waitFor(() => expect(app.text('enable-status')).toContain('cambió sus claves VAPID'));
    expect(app.text('enable-button')).toBe('Activar');
    expect(stale?.active).toBe(false);
    expect(app.requests).toContain('POST api/unsubscribe');
    expect(app.requests).not.toContain('POST api/subscribe');
    expect(await app.store.list()).toEqual([]);
    expect(app.$<HTMLButtonElement>('test-button').disabled).toBe(true);

    // Activar then makes a new subscription with the server's current key.
    app.$('enable-button').click();
    await vi.waitFor(() => expect(app.text('enable-button')).toBe('Desactivar'));
    expect(app.current()?.options.applicationServerKey).toEqual(base64UrlToBytes(vapid.publicKey).buffer);
  });

  it('keeps a subscription whose browser does not report its key', async () => {
    const app = mount({ existing: true, existingKey: null, permission: 'granted' });
    await vi.waitFor(async () => expect(await app.store.list()).toHaveLength(1));
    expect(app.text('enable-text')).toContain('Activados');
  });

  it('drops an old subscription made with another key and subscribes again', async () => {
    const app = mount({ subscribeError: { name: 'InvalidStateError', message: 'other key' } });
    await vi.waitFor(() => expect(app.$<HTMLButtonElement>('enable-button').disabled).toBe(false));
    app.$('enable-button').click();
    await vi.waitFor(() => expect(app.text('enable-button')).toBe('Desactivar'));
    expect(app.subscribeCalls).toHaveLength(2);
  });

  it('shows the reason when the browser refuses, and a blocked permission disables the button', async () => {
    const app = mount({ subscribeError: { name: 'AbortError', message: 'Registration failed - push service error' } });
    await vi.waitFor(() => expect(app.$<HTMLButtonElement>('enable-button').disabled).toBe(false));
    app.$('enable-button').click();
    await vi.waitFor(() => expect(app.text('enable-status')).toContain('servicio de push'));

    const denied = mount({ permission: 'denied' });
    await vi.waitFor(() => expect(denied.text('enable-text')).toContain('bloqueados'));
    expect(denied.$<HTMLButtonElement>('enable-button').disabled).toBe(true);
  });

  it('unsubscribes the browser when the server cannot store the subscription', async () => {
    const broken: SubscriptionStore = { ...memoryStore(), put: () => Promise.reject(new Error('db down')) };
    const app = mount({ store: broken });
    await vi.waitFor(() => expect(app.$<HTMLButtonElement>('enable-button').disabled).toBe(false));
    app.$('enable-button').click();
    await vi.waitFor(() => expect(app.text('enable-status')).toContain('no pudo guardar'));
    expect(app.current()?.active).toBe(false);
    expect(app.text('enable-button')).toBe('Activar');
  });

  it('disabling removes the device from the server and the browser', async () => {
    const app = mount({ existing: true, permission: 'granted' });
    await vi.waitFor(() => expect(app.text('enable-button')).toBe('Desactivar'));
    app.$('enable-button').click();
    await vi.waitFor(() => expect(app.text('enable-button')).toBe('Activar'));
    expect(await app.store.list()).toEqual([]);
    expect(app.current()?.active).toBe(false);
  });
});

describe('sending a test', () => {
  async function ready(options: Options = {}) {
    const app = mount({ existing: true, permission: 'granted', ...options });
    await vi.waitFor(() => expect(app.$<HTMLButtonElement>('test-button').disabled).toBe(false));
    return app;
  }

  it('sends the chosen kind and, when asked, the badge number', async () => {
    const app = await ready();
    app.$('badge-plus').click();
    app.$('badge-plus').click();
    app.$<HTMLInputElement>('test-badge').checked = true;
    document.querySelector<HTMLInputElement>('input[value="reminder"]')!.checked = true;
    app.$('test-button').click();
    await vi.waitFor(() => expect(app.text('test-status')).toContain('24 horas'));
    expect(app.sent).toEqual([expect.objectContaining({ kind: 'reminder', badge: 2 })]);
  });

  it('a store failure says not to disable, and leaves the subscription alone', async () => {
    const store = memoryStore();
    const app = await ready({ store });
    store.get = () => Promise.reject(new Error('db down'));
    app.$('test-button').click();
    await vi.waitFor(() => expect(app.text('test-status')).toContain('No desactives'));
    expect(app.current()?.active).toBe(true);
    expect(app.text('enable-button')).toBe('Desactivar');
  });

  it('a server that lost the device registers it again', async () => {
    const app = await ready();
    await app.store.remove(app.current()?.endpoint ?? '');
    app.$('test-button').click();
    await vi.waitFor(() => expect(app.text('test-status')).toContain('Ya se volvió a registrar'));
    await vi.waitFor(async () => expect(await app.store.list()).toHaveLength(1));
  });

  it('a 410 from the push service drops the browser subscription and offers Activar again', async () => {
    const send: Sender = () => Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 }));
    const app = await ready({ send });
    app.$('test-button').click();
    await vi.waitFor(() => expect(app.text('enable-button')).toBe('Activar'));
    expect(app.text('test-status')).toContain('ya no existe');
    expect(app.current()?.active).toBe(false);
  });
});

describe('the badge', () => {
  it('sets and clears the page badge from the counter', async () => {
    const app = mount();
    app.$('badge-plus').click();
    app.$('badge-plus').click();
    app.$('badge-minus').click();
    app.$('badge-plus').click();
    expect(app.$<HTMLOutputElement>('badge-count').value).toBe('2');
    app.$('badge-apply').click();
    await vi.waitFor(() => expect(app.text('badge-status')).toContain('Globo puesto en 2'));
    app.$('badge-clear').click();
    await vi.waitFor(() => expect(app.badgeCalls).toEqual(['set:2', 'clear']));
    expect(app.$<HTMLOutputElement>('badge-count').value).toBe('0');
  });

  it('says so when the page has no badge API', async () => {
    const app = mount({ badge: false });
    app.$('badge-apply').click();
    await vi.waitFor(() => expect(app.text('badge-status')).toContain('no tiene la API'));
  });

  it('a push the worker reports sets the badge from the page too', async () => {
    const app = mount();
    app.worker({ type: 'push', kind: 'test', sentAt: 1, badge: 7 });
    await vi.waitFor(() => expect(app.badgeCalls).toEqual(['set:7']));
    expect(app.$<HTMLOutputElement>('badge-count').value).toBe('7');
    expect(app.text('log')).toContain('globo 7');
    app.worker({ type: 'push', kind: 'test', sentAt: 2, badge: null });
    expect(app.badgeCalls).toEqual(['set:7']);
  });
});

describe('server diagnosis and arrival notes', () => {
  it('shows the device count, and "could not count" when the store fails', async () => {
    const app = mount({ existing: true, permission: 'granted' });
    await vi.waitFor(async () => expect(await app.store.list()).toHaveLength(1));
    app.$('diagnose-button').click();
    await vi.waitFor(() => expect(app.text('diagnose-body')).toContain('Dispositivos suscritos: 1.'));

    const broken: SubscriptionStore = { ...memoryStore(), list: () => Promise.reject(new Error('db down')) };
    const failing = mount({ store: broken });
    failing.$('diagnose-button').click();
    await vi.waitFor(() => expect(failing.text('diagnose-body')).toContain('no se pudo contar'));
    expect(failing.text('diagnose-body')).toContain('no pudo leer');
  });

  it('notes an arrival from a notification or through the redirect check', () => {
    expect(mount({ search: '?from=notification' }).text('arrival')).toContain('desde un aviso');
    expect(mount({ search: '?redirected=1' }).text('arrival')).toContain('redirección 302');
  });

  it('every input has a label and every status region is announced', () => {
    mount();
    for (const input of document.querySelectorAll('input')) expect(input.closest('label')).not.toBeNull();
    for (const id of ['install-status', 'enable-status', 'test-status', 'badge-status', 'arrival']) {
      expect(document.getElementById(id)?.getAttribute('role')).toBe('status');
    }
    // The status paragraphs announce each result once; the log repeats them, so it stays quiet.
    expect(document.getElementById('log')?.getAttribute('aria-live')).toBe('off');
    // The badge number is announced as the number: its name comes from a label, not aria-label,
    // which would replace the content in the accessible name.
    const output = document.getElementById('badge-count');
    expect(output?.hasAttribute('aria-label')).toBe(false);
    expect(document.querySelector('label[for="badge-count"]')?.textContent).toBe('Número del globo');
  });

  it('no live region is hidden while empty, so its first message is announced', () => {
    mount();
    const style = document.createElement('style');
    style.textContent = readFileSync(join(here, '../src/styles.css'), 'utf8');
    document.head.append(style);
    try {
      const regions = [...document.querySelectorAll<HTMLElement>('[role="status"], output, [aria-live="polite"]')];
      expect(regions.length).toBeGreaterThanOrEqual(7);
      for (const region of regions) {
        expect(region.hidden).toBe(false);
        expect(getComputedStyle(region).display).not.toBe('none');
      }
    } finally {
      style.remove();
    }
  });
});
