/**
 * Idempotency keys, made where the user acts. Browser-safe: Web Crypto and a Storage-like object.
 */

/** The format the SQL functions accept. A UUID matches it. */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** A new random key: `crypto.randomUUID()`, or 16 random bytes in hex where that is missing (older browsers, non-secure origins). */
export function newKey(crypto: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>> = globalThis.crypto): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // randomUUID throws outside a secure context in some browsers; fall through.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The part of `Storage` this module uses, so tests and non-browser callers can pass their own. */
export interface KeyStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export interface ActionKeyOptions {
  /** Storage name of this action's key, such as `checkout-key`. */
  readonly slot: string;
  /** Usually `localStorage`. Omitted or throwing, the key lives only in memory. */
  readonly storage?: KeyStorage;
  /** How long a stored key stays the same action. Default 24 hours. Not positive (or NaN) throws a RangeError. */
  readonly lifetimeMs?: number;
  readonly now?: () => number;
  readonly makeKey?: () => string;
}

interface Stored {
  readonly key: string;
  readonly createdAt: number;
}

/**
 * The key of one user action, such as "send this cart". Every send of the action, including a tap
 * after a reload, carries the same key until `clear()`: after a success, or when the user chooses
 * to send the cart as a separate order. A failure or an "unknown" answer keeps the key, so the
 * next tap is a resend, not a second order.
 *
 * The key is kept in memory and mirrored to storage, which survives a reload and is shared by the
 * tabs of the page. Once the mirror is written, storage decides: when another tab cleared the slot
 * or started a new action there, this tab follows it. Memory wins only while storage cannot be
 * read or written, so a retry from the same page keeps its key when storage is blocked or full.
 */
export class ActionKey {
  readonly #slot: string;
  readonly #storage: KeyStorage | undefined;
  readonly #lifetimeMs: number;
  readonly #now: () => number;
  readonly #makeKey: () => string;
  #current: Stored | null = null;
  /** Whether the last write of #current reached storage, so the slot can be read as the truth. */
  #mirrored = false;

  constructor(options: ActionKeyOptions) {
    this.#slot = options.slot;
    this.#storage = options.storage;
    const lifetimeMs = options.lifetimeMs ?? 24 * 60 * 60 * 1000;
    // NaN or 0 would make every key stale at once, so every current() would mint a new one.
    if (!(lifetimeMs > 0)) throw new RangeError('lifetimeMs is a positive number');
    this.#lifetimeMs = lifetimeMs;
    this.#now = options.now ?? Date.now;
    this.#makeKey = options.makeKey ?? (() => newKey());
  }

  /** The key for the next send of this action: the current one if still fresh, else a new one. */
  current(): string {
    const now = this.#now();
    // A clock moved back makes the age negative. That only makes a stored value suspect; the key
    // this page minted is still the same action, so its next send stays a resend.
    const stored = this.#read();
    const mine = this.#current;
    if (mine && now - mine.createdAt < this.#lifetimeMs) {
      // Another tab may have cleared the shared slot after a success, or started a new action in it.
      const slotAgrees = stored === 'blocked' || !this.#mirrored || stored?.key === mine.key;
      if (slotAgrees) return mine.key;
    }
    const adopt = stored !== 'blocked' && stored !== null && this.#fresh(stored, now) ? stored : null;
    this.#current = adopt ?? { key: this.#makeKey(), createdAt: now };
    this.#mirrored = this.#write(this.#current);
    return this.#current.key;
  }

  /** Forgets the key. The next `current()` starts a new action. */
  clear(): void {
    this.#current = null;
    try {
      this.#storage?.removeItem(this.#slot);
    } catch {
      // Blocked storage: the memory copy is already gone.
    }
  }

  #fresh(stored: Stored, now: number): boolean {
    const age = now - stored.createdAt;
    return age >= 0 && age < this.#lifetimeMs;
  }

  /** The stored value, null when the slot is empty or holds something else, 'blocked' when it cannot be read. */
  #read(): Stored | null | 'blocked' {
    if (!this.#storage) return 'blocked';
    let raw: string | null;
    try {
      raw = this.#storage.getItem(this.#slot);
    } catch {
      return 'blocked';
    }
    try {
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null) return null;
      const { key, createdAt } = value as Record<string, unknown>;
      if (typeof key !== 'string' || !KEY_PATTERN.test(key) || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
        return null;
      }
      return { key, createdAt };
    } catch {
      return null;
    }
  }

  #write(stored: Stored): boolean {
    if (!this.#storage) return false;
    try {
      this.#storage.setItem(this.#slot, JSON.stringify(stored));
      return true;
    } catch {
      // Blocked or full storage: the key still holds for this page.
      return false;
    }
  }
}
