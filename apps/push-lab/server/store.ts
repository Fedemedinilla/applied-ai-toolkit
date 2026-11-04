// Where the server keeps the devices it may push to. The handler sees only this interface, so a
// database can replace the in-memory store without touching it.
//
// Every method reports failure by throwing. Nothing here returns an empty list or `undefined` to
// mean "I could not read": the handler must tell "the store failed" from "nobody is subscribed",
// because the two need opposite advice. Telling someone to disable and re-enable notifications
// after a passing read error destroys a subscription that was working.

export interface SubscriptionKeys {
  /** The browser's P-256 public key, base64url, 65 bytes uncompressed. */
  readonly p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  readonly auth: string;
}

export interface NewSubscription {
  readonly endpoint: string;
  readonly keys: SubscriptionKeys;
}

export interface StoredSubscription extends NewSubscription {
  /** When this endpoint was first stored, ISO 8601. Kept when the keys rotate. */
  readonly createdAt: string;
}

/** `unchanged` when the same endpoint was already stored with the same keys. */
export type PutResult = 'created' | 'updated' | 'unchanged';

export interface SubscriptionStore {
  put(subscription: NewSubscription): Promise<PutResult>;
  get(endpoint: string): Promise<StoredSubscription | undefined>;
  /** True when a row was removed. */
  remove(endpoint: string): Promise<boolean>;
  list(): Promise<StoredSubscription[]>;
}

/** Thrown by `put` when the store holds its maximum, the endpoint is new and the store refuses rather than evicts. */
export class StoreFullError extends Error {
  constructor(capacity: number) {
    super(`the subscription store is full (${capacity})`);
    this.name = 'StoreFullError';
  }
}

export interface MemoryStoreOptions {
  /** A public demo must not grow without bound. */
  readonly capacity?: number;
  /**
   * What a new endpoint does to a full store. `evict` (the default) drops the device that
   * registered least recently; `refuse` throws StoreFullError. With `refuse`, anyone who posts
   * `capacity` made-up subscriptions locks every real device out until a restart. With `evict`,
   * the same flood pushes real devices out, and each comes back on its next page load, because the
   * page registers on every load and again when a test answers `not_subscribed`.
   */
  readonly whenFull?: 'evict' | 'refuse';
  readonly now?: () => Date;
}

/**
 * A store in this process's memory. It is lost on restart and not shared between instances, which
 * is enough for a lab run by one person. The page registers its subscription again on every load,
 * so a restart costs one page load.
 */
export function memoryStore({ capacity = 500, whenFull = 'evict', now = () => new Date() }: MemoryStoreOptions = {}): SubscriptionStore {
  // A Map iterates in insertion order. Every put moves its row to the end, so the first key is
  // always the device that registered least recently.
  const rows = new Map<string, StoredSubscription>();
  const touch = (row: StoredSubscription): void => {
    // Delete and set in the same synchronous step: no await in between, so no push can run at a
    // moment when the endpoint is missing.
    rows.delete(row.endpoint);
    rows.set(row.endpoint, row);
  };
  return {
    async put({ endpoint, keys }) {
      const existing = rows.get(endpoint);
      if (existing && existing.keys.p256dh === keys.p256dh && existing.keys.auth === keys.auth) {
        touch(existing);
        return 'unchanged';
      }
      if (!existing && rows.size >= capacity) {
        if (whenFull === 'refuse') throw new StoreFullError(capacity);
        const oldest = rows.keys().next();
        if (!oldest.done) rows.delete(oldest.value);
      }
      touch({
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        createdAt: existing?.createdAt ?? now().toISOString(),
      });
      return existing ? 'updated' : 'created';
    },
    async get(endpoint) {
      return rows.get(endpoint);
    },
    async remove(endpoint) {
      return rows.delete(endpoint);
    },
    async list() {
      return [...rows.values()];
    },
  };
}
