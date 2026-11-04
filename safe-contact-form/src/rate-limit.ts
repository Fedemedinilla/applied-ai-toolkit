/**
 * A per-key sliding window that counts only the attempts it let through.
 *
 * The source's first limiter stored refused attempts too. Every retry that its "try again in a
 * few minutes" page invited pushed the window forward, so a person who kept trying stayed blocked
 * for as long as they kept trying. Here a refusal leaves no trace.
 *
 * It lives in one process. On serverless each warm instance starts with an empty map, so it is a
 * ceiling for a script pushing one pipe, not a hard defence; the trap field and the clock come
 * first.
 */
export interface RateLimit {
  readonly max: number;
  readonly windowMs: number;
}

export type Limiter = (key: string) => boolean;

/** Returns `limited(key)`: true when `key` already had `max` accepted attempts in the window. */
export function createLimiter({ max, windowMs }: RateLimit, now: () => number, maxKeys = 10_000): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new Error('safe-contact-form: rateLimit.max must be a positive integer');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('safe-contact-form: rateLimit.windowMs must be positive');
  const hits = new Map<string, number[]>();
  return (key) => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    const refused = recent.length >= max;
    if (!refused) recent.push(t);
    // Re-inserted so the map stays ordered by last use; the oldest key goes first when full.
    hits.delete(key);
    hits.set(key, recent);
    if (refused) return true;
    if (hits.size > maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    return false;
  };
}
