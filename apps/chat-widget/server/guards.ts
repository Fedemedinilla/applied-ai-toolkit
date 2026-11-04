// Small pure guards for the public endpoints: where a request comes from (Origin or Referer),
// who sends it (an IP key), how often (an in-memory limiter), how much it sends (a body read with
// a byte limit), and a deadline for store calls.

import { isIP } from 'node:net';

/** The eight 16-bit groups of an IPv6 address, or null. Accepts `::` and a dotted IPv4 tail. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  // A dotted IPv4 tail (::ffff:192.0.2.1) becomes two hex groups, then the address parses as usual.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16)));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = 8 - head.length - rest.length;
  const groups = halves.length === 2 ? [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...rest] : head;
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The limiter key for an IP. One home or phone line usually holds a whole IPv6 /64 and can rotate
 * inside it, so IPv6 is keyed by its /64. An IPv4-mapped address (::ffff:192.0.2.1) is the IPv4.
 */
export function ipKey(ip: string): string {
  const s = ip.trim();
  if (isIP(s) === 4) return s;
  const g = parseIPv6(s);
  if (!g) return s.slice(0, 64);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi = 0, lo = 0] = g.slice(6);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * The first X-Forwarded-For hop. Only correct behind a proxy that overwrites the header with the
 * address it saw (Vercel's edge does); anywhere else a client can write it, so the host decides
 * which function to pass as `clientIp`.
 */
export function forwardedFor(request: Request): string | null {
  const first = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';
  return first === '' ? null : first;
}

export interface RateLimiter {
  /** Records one use of `key` and returns true, or returns false and records nothing when `key` is at its limit. */
  allow(key: string): boolean;
  /** True when `key` is at its limit. Records nothing. */
  atLimit(key: string): boolean;
  readonly size: number;
}

/**
 * A sliding-window limiter in memory, per process. On a serverless host each instance has its own
 * and a cold start begins empty: it stops one client hammering one instance, and the per-tenant
 * counts in the store are the limit across instances. The Map holds at most `maxKeys` keys, oldest
 * use evicted first, so a client rotating keys cannot grow it without bound.
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number, maxKeys = 5000): RateLimiter {
  const hits = new Map<string, number[]>();
  const recent = (key: string, t: number): number[] => (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  return {
    allow(key) {
      const t = now();
      const uses = recent(key, t);
      if (uses.length >= limit) return false;
      uses.push(t);
      // Re-inserted on every use, so the first key is always the one used least recently.
      hits.delete(key);
      hits.set(key, uses);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return true;
    },
    atLimit(key) {
      return recent(key, now()).length >= limit;
    },
    get size() {
      return hits.size;
    },
  };
}

/** The host the request claims to come from: Origin, else the host of Referer. Null if neither parses. */
export function claimedHost(request: Request): string | null {
  for (const header of ['origin', 'referer']) {
    const value = request.headers.get(header);
    if (!value || value === 'null') continue;
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host !== '') return host;
    } catch {
      // An unparsable header is no evidence: try the next one.
    }
  }
  return null;
}

/** The host is one of the allowed domains or a subdomain of one. An empty list allows nothing. */
export function hostAllowed(host: string | null, allowed: readonly string[]): boolean {
  if (host === null) return false;
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The body as text, or null past `max` bytes. Read chunk by chunk, so a body with no
 * Content-Length (chunked) is cut at the limit instead of buffered whole.
 */
export async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export class StoreTimeout extends Error {
  constructor(ms: number) {
    super(`store call took more than ${ms} ms`);
    this.name = 'StoreTimeout';
  }
}

/** Rejects with StoreTimeout after `ms`. The store call keeps running; its result is ignored. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreTimeout(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
