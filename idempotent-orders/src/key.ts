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
  /** How long a stored key stays the same action. Default 24 hours. */
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
 * The key is kept in memory and mirrored to storage. Memory wins, so a retry from the same page
 * keeps its key when storage is blocked; storage is what survives a reload.
 */
export class ActionKey {
  readonly #slot: string;
  readonly #storage: KeyStorage | undefined;
  readonly #lifetimeMs: number;
  readonly #now: () => number;
  readonly #makeKey: () => string;
  #current: Stored | null = null;

  constructor(options: ActionKeyOptions) {
    this.#slot = options.slot;
    this.#storage = options.storage;
    this.#lifetimeMs = options.lifetimeMs ?? 24 * 60 * 60 * 1000;
    this.#now = options.now ?? Date.now;
    this.#makeKey = options.makeKey ?? (() => newKey());
  }

  /** The key for the next send of this action: the current one if still fresh, else a new one. */
  current(): string {
    const now = this.#now();
    if (this.#current && this.#fresh(this.#current, now)) return this.#current.key;
    const stored = this.#read();
    this.#current = stored && this.#fresh(stored, now) ? stored : { key: this.#makeKey(), createdAt: now };
    this.#write(this.#current);
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

  #read(): Stored | null {
    try {
      const raw = this.#storage?.getItem(this.#slot);
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

  #write(stored: Stored): void {
    try {
      this.#storage?.setItem(this.#slot, JSON.stringify(stored));
    } catch {
      // Blocked or full storage: the key still holds for this page.
    }
  }
}
