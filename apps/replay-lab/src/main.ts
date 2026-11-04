// Browser entry: a real Worker for batches, Blob URLs for the run file, a random seed from
// crypto.getRandomValues, and the service worker for offline use.

import { mountApp, type BatchRunner } from './app.ts';
import type { BatchMessage } from './batch-protocol.ts';

declare const __REPLAY_LAB_DEV__: boolean;

const batch: BatchRunner = {
  start(request, onMessage) {
    // A fresh worker per batch: cancelling is terminate(), which stops the loop at once.
    const worker = new Worker(new URL('./batch-worker.ts', import.meta.url), { type: 'module' });
    let finished = false;
    const stop = (): void => {
      finished = true;
      worker.terminate();
    };
    worker.addEventListener('message', (event: MessageEvent<BatchMessage>) => {
      if (finished) return;
      if (event.data.type !== 'progress') stop();
      onMessage(event.data);
    });
    worker.addEventListener('error', (event) => {
      if (finished) return;
      stop();
      onMessage({ type: 'error', message: event.message || 'the worker stopped' });
    });
    worker.postMessage(request);
    return stop;
  },
};

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
