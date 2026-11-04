// Where the run lives between visits: IndexedDB when the browser allows it, memory when it does not.
//
// IndexedDB is missing or refuses in some private modes, in embedded webviews and when the quota is
// full. Every call is wrapped, and any failure while opening gives a memory store instead. The app
// then says that nothing is kept and that the run JSON is the copy. Writes go through one queue, so a
// slow earlier write can never land after a later one and put back an older run.

import { isRun, type Run } from './run.ts';

const DB_NAME = 'site-checklist';
const STORE = 'runs';
const KEY = 'current';

export interface LoadResult {
  readonly run: Run | null;
  /** A stored value existed but was not a valid run. It was copied aside and not used. */
  readonly invalid: boolean;
  /**
   * Reading failed, so whether a run is stored is unknown. Until a later load succeeds, save()
   * writes nothing and resolves false: an empty run must not replace one that could not be read.
   */
  readonly unreadable: boolean;
}

export interface Store {
  readonly kind: 'indexeddb' | 'memory';
  load(): Promise<LoadResult>;
  /** Resolves false when the write failed; the run in memory is unchanged either way. */
  save(run: Run): Promise<boolean>;
}

export function memoryStore(): Store {
  let current: Run | null = null;
  return {
    kind: 'memory',
    load: () => Promise.resolve({ run: current, invalid: false, unreadable: false }),
    save: (run) => {
      current = run;
      return Promise.resolve(true);
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    // Another tab holds an older version open: waiting would hang the app on start.
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function idbStore(db: IDBDatabase): Store {
  let queue: Promise<boolean> = Promise.resolve(true);
  let readFailed = false;
  return {
    kind: 'indexeddb',
    async load() {
      let value: unknown;
      try {
        const tx = db.transaction(STORE, 'readonly');
        value = await request(tx.objectStore(STORE).get(KEY));
      } catch {
        readFailed = true;
        return { run: null, invalid: false, unreadable: true };
      }
      readFailed = false;
      if (value === undefined) return { run: null, invalid: false, unreadable: false };
      if (isRun(value)) return { run: value, invalid: false, unreadable: false };
      // Kept under another key, so a bad write or an older format is never silently lost.
      try {
        const copy = db.transaction(STORE, 'readwrite');
        copy.objectStore(STORE).put(value, `invalid-${Date.now()}`);
        await done(copy);
      } catch {
        // The copy failing leaves the value where it was; the app still starts empty.
      }
      return { run: null, invalid: true, unreadable: false };
    },
    save(run) {
      queue = queue.then(async () => {
        if (readFailed) return false;
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(run, KEY);
          await done(tx);
          return true;
        } catch {
          return false;
        }
      });
      return queue;
    },
  };
}

/** An IndexedDB store, or a memory store when IndexedDB is missing or fails to open. */
export async function openStore(factory: IDBFactory | undefined): Promise<Store> {
  if (!factory) return memoryStore();
  try {
    return idbStore(await open(factory));
  } catch {
    return memoryStore();
  }
}
