// Browser entry: the real navigator, service worker and fetch wired into mountApp.

import { mountApp, type InstallPrompt, type PushEnv, type RegistrationLike } from './app.ts';
import { detectPlatform } from './platform.ts';
import { isWorkerMessage, type PageMessage } from './wire.ts';

const READY_TIMEOUT_MS = 10_000;

const platform = detectPlatform({
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints,
  displayStandalone: window.matchMedia('(display-mode: standalone)').matches,
  navigatorStandalone: 'standalone' in navigator ? navigator.standalone === true : undefined,
});

const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

if (hasPush) {
  // Scope './': the worker covers this folder only, so the app can live under any path.
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
    // refresh() reports it: ready() below times out.
  });
}

const ready = (): Promise<RegistrationLike> =>
  Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('el service worker no se activó (¿HTTPS o localhost?)')), READY_TIMEOUT_MS),
    ),
  ]);

const push: PushEnv | null = hasPush
  ? {
      permission: () => Notification.permission,
      requestPermission: () => Notification.requestPermission(),
      ready,
      onWorkerMessage: (listener) => {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (isWorkerMessage(event.data)) listener(event.data);
        });
      },
      askWorker: async () => {
        const registration = await navigator.serviceWorker.ready;
        const worker = registration.active;
        if (!worker) return null;
        const channel = new MessageChannel();
        const answer = new Promise<{ badgeApi: boolean } | null>((resolve) => {
          channel.port1.onmessage = (event) => resolve(isWorkerMessage(event.data) && event.data.type === 'worker-info' ? { badgeApi: event.data.badgeApi } : null);
          setTimeout(() => resolve(null), 2000);
        });
        const question: PageMessage = { type: 'worker-info?' };
        worker.postMessage(question, [channel.port2]);
        return answer;
      },
    }
  : null;

// The page's own badge API. Feature-tested: the DOM types declare it on every Navigator.
const badge =
  typeof navigator.setAppBadge === 'function' && typeof navigator.clearAppBadge === 'function'
    ? { set: (n: number) => navigator.setAppBadge(n), clear: () => navigator.clearAppBadge() }
    : null;

mountApp(document, {
  platform,
  fetch: (path, init) => fetch(new URL(path, document.baseURI), init),
  push,
  badge,
  onInstallPrompt: (listener) => {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault(); // offer it from our own button, when the person has read why
      listener(event as Event & InstallPrompt);
    });
  },
  onInstalled: (listener) => window.addEventListener('appinstalled', listener),
  search: location.search,
  now: () => new Date(),
});
