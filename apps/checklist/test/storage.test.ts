// Storage: IndexedDB through a small in-memory fake of the parts the store uses, and the memory
// fallback for every way IndexedDB can be unavailable.

import { describe, expect, it } from 'vitest';
import { openStore } from '../src/storage.ts';
import { setState } from '../src/run.ts';
import { at, loadCatalogue, ok, runWith } from './helpers.ts';

const catalogue = loadCatalogue();

type Handler = (() => void) | null;
class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

/** Enough of IndexedDB for the store: one database, object stores as maps, async callbacks. */
class FakeIdb {
  readonly stores = new Map<string, Map<string, unknown>>();
  failWrites = false;
  failReads = false;
  /** Delay of each write in ms, popped per write, to test that writes stay in order. */
  writeDelays: number[] = [];

  db(): IDBDatabase {
    const self = this;
    const db = {
      objectStoreNames: { contains: (name: string) => self.stores.has(name) },
      createObjectStore: (name: string) => self.stores.set(name, new Map()),
      transaction(name: string) {
        const data = self.stores.get(name) ?? new Map<string, unknown>();
        const tx = { oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler, error: null as Error | null, objectStore: () => store };
        const store = {
          get(key: string) {
            const req = new FakeRequest<unknown>();
            setTimeout(() => {
              if (self.failReads) {
                req.error = new Error('UnknownError');
                req.onerror?.();
                return;
              }
              req.result = structuredClone(data.get(key));
              req.onsuccess?.();
              tx.oncomplete?.();
            }, 0);
            return req;
          },
          put(value: unknown, key: string) {
            const delay = self.writeDelays.shift() ?? 0;
            setTimeout(() => {
              if (self.failWrites) {
                tx.error = new Error('QuotaExceededError');
                tx.onabort?.();
                return;
              }
              data.set(key, structuredClone(value));
              tx.oncomplete?.();
            }, delay);
          },
        };
        return tx;
      },
    };
    return db as never;
  }

  factory(): IDBFactory {
    return {
      open: () => {
        const req = new FakeRequest<IDBDatabase>();
        setTimeout(() => {
          req.result = this.db();
          if (!this.stores.has('runs')) req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      },
    } as never;
  }
}

describe('the IndexedDB store', () => {
  it('saves a run and loads it back', async () => {
    const idb = new FakeIdb();
    const store = await openStore(idb.factory());
    expect(store.kind).toBe('indexeddb');
    expect(await store.load()).toEqual({ run: null, invalid: false, unreadable: false });
    const run = ok(setState(catalogue, runWith(catalogue, 'wordpress'), 'EXT-01', 'fail', at(1)));
    expect(await store.save(run)).toBe(true);
    expect(await (await openStore(idb.factory())).load()).toEqual({ run, invalid: false, unreadable: false });
  });

  it('keeps writes in order: a slow first write never lands after a fast second one', async () => {
    const idb = new FakeIdb();
    idb.writeDelays = [30, 0];
    const store = await openStore(idb.factory());
    const first = runWith(catalogue, 'wordpress');
    const second = ok(setState(catalogue, first, 'EXT-01', 'pass', at(1)));
    await Promise.all([store.save(first), store.save(second)]);
    expect((await store.load()).run).toEqual(second);
  });

  it('copies an invalid stored value aside and starts empty', async () => {
    const idb = new FakeIdb();
    idb.stores.set('runs', new Map<string, unknown>([['current', { format: 'something else' }]]));
    const result = await (await openStore(idb.factory())).load();
    expect(result).toEqual({ run: null, invalid: true, unreadable: false });
    const keys = [...(idb.stores.get('runs')?.keys() ?? [])];
    expect(keys.some((k) => k.startsWith('invalid-'))).toBe(true);
    expect(idb.stores.get('runs')?.get('current')).toEqual({ format: 'something else' });
  });

  it('says a failed read is unreadable, and writes nothing over the stored run until a read succeeds', async () => {
    const idb = new FakeIdb();
    const stored = ok(setState(catalogue, runWith(catalogue, 'wordpress'), 'EXT-01', 'fail', at(1)));
    await (await openStore(idb.factory())).save(stored);
    const store = await openStore(idb.factory());
    idb.failReads = true;
    expect(await store.load()).toEqual({ run: null, invalid: false, unreadable: true });
    expect(await store.save(runWith(catalogue, 'wordpress'))).toBe(false);
    expect(idb.stores.get('runs')?.get('current')).toEqual(stored);
    idb.failReads = false;
    expect(await store.load()).toEqual({ run: stored, invalid: false, unreadable: false });
    expect(await store.save(runWith(catalogue, 'static'))).toBe(true);
  });

  it('reports a failed write instead of throwing', async () => {
    const idb = new FakeIdb();
    const store = await openStore(idb.factory());
    idb.failWrites = true;
    expect(await store.save(runWith(catalogue, 'wordpress'))).toBe(false);
  });
});

describe('the memory fallback', () => {
  const failing = (how: 'throw' | 'error' | 'blocked'): IDBFactory =>
    ({
      open: () => {
        if (how === 'throw') throw new Error('SecurityError');
        const req = new FakeRequest<IDBDatabase>();
        setTimeout(() => (how === 'error' ? req.onerror?.() : req.onblocked?.()), 0);
        return req;
      },
    }) as never;

  it.each([
    ['missing', undefined],
    ['throwing on open', failing('throw')],
    ['failing to open', failing('error')],
    ['blocked by another tab', failing('blocked')],
  ])('is used when IndexedDB is %s', async (_name, factory) => {
    const store = await openStore(factory);
    expect(store.kind).toBe('memory');
    const run = runWith(catalogue, 'static');
    expect(await store.save(run)).toBe(true);
    expect(await store.load()).toEqual({ run, invalid: false, unreadable: false });
  });
});
