// Browser entry: a real Worker for batches, Blob URLs for the run file, a random seed from
// crypto.getRandomValues, and the service worker for offline use.

import { mountApp } from './app.ts';
import { workerRunner } from './worker-runner.ts';

declare const __REPLAY_LAB_DEV__: boolean;

// The literal `new Worker(new URL(...))` stays here: Vite finds the worker to bundle by that pattern.
const batch = workerRunner(() => new Worker(new URL('./batch-worker.ts', import.meta.url), { type: 'module' }));

function randomSeed(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return `seed-${[...words].map((w) => w.toString(36)).join('')}`;
}

mountApp(document, {
  batch,
  objectUrl: (text, type) => URL.createObjectURL(new Blob([text], { type })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  randomSeed,
  now: () => performance.now(),
});

if (!__REPLAY_LAB_DEV__ && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Without a worker the app still runs; it only does not open offline.
    });
  });
}
