// Browser entry: real storage, clock, speech, download and service worker wired into mountApp.

import { mountApp } from './app.ts';
import { findRecognition } from './speech.ts';
import { browserStorage } from './storage.ts';

// Replaced by Vite's `define` (vite.config.ts): true under `vite dev`, where no worker is wanted.
declare const __CAJA_DEV__: boolean;

function newId(): string {
  // randomUUID exists only in secure contexts; a till served over plain http on a LAN still works.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

mountApp(document, {
  storage: browserStorage(),
  now: () => new Date(),
  newId,
  loadCorpus: async () => {
    const res = await fetch('./corpus.json');
    if (!res.ok) throw new Error(`corpus.json: ${res.status}`);
    return res.json();
  },
  recognition: findRecognition(),
  download,
  // Model mode: the page asks ./api/health and shows the switch only on {"ok": true}.
  api: (input, init) => fetch(input, init),
});

if (!__CAJA_DEV__ && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Without a worker the app still runs; it just does not open offline.
    });
  });
}
