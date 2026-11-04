// Browser entry: fetch the catalogue, open storage, start the page, register the service worker.

import { startApp } from './app.ts';
import { isCatalogue, type Catalogue } from './catalogue.ts';
import { openStore } from './storage.ts';

declare const __CHECKLIST_DEV__: boolean;

async function loadCatalogue(): Promise<Catalogue> {
  const res = await fetch('./catalogue.json');
  if (!res.ok) throw new Error(`catalogue.json answered ${res.status}`);
  const data: unknown = await res.json();
  if (!isCatalogue(data)) throw new Error('catalogue.json does not have the expected shape');
  return data;
}

function indexedDbOrNothing(): IDBFactory | undefined {
  // Reading the property itself throws in some sandboxed frames.
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  try {
    const [catalogue, store] = await Promise.all([loadCatalogue(), openStore(indexedDbOrNothing())]);
    await startApp({ doc: document, catalogue, store });
  } catch (error) {
    const status = document.getElementById('status');
    if (status) status.textContent = `The checklist could not start: ${error instanceof Error ? error.message : String(error)}. Reload the page to try again.`;
    return;
  }
  if (!__CHECKLIST_DEV__ && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Without a worker the app still runs; it just does not open offline.
    });
  }
}

void main();
