// Panel authentication with Node's crypto only: scrypt password hashes that carry their own
// parameters, HMAC-signed tokens with a purpose and an expiry, the session cookie, and a
// timing-safe HTTP Basic check for the operator.

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** OWASP's minimum for scrypt: N = 2^17, r = 8, p = 1. About 128 MiB and a few hundred ms per hash. */
export const SCRYPT_PARAMS: ScryptParams = { N: 1 << 17, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Stored hashes outside these bounds are refused, so a corrupt row cannot ask for gigabytes. */
const BOUNDS = { minLogN: 14, maxLogN: 20, maxR: 16, maxP: 4, maxMemBytes: 256 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolve, reject) => {
    // The async form runs on libuv's thread pool, so a login does not block every other request.
    scryptCallback(password.normalize('NFC'), salt, KEY_BYTES, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** `scrypt$N$r$p$salt$hash`, salt and hash in base64url. The parameters travel with the hash. */
export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

export function parseHash(stored: string): ParsedHash | null {
  const m = /^scrypt\$(\d{1,8})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/u.exec(stored);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const logN = Math.log2(N);
  if (!Number.isInteger(logN) || logN < BOUNDS.minLogN || logN > BOUNDS.maxLogN) return null;
  if (r < 1 || r > BOUNDS.maxR || p < 1 || p > BOUNDS.maxP) return null;
  // scrypt needs 128 * N * r bytes; past 256 MiB the row is refused rather than computed.
  if (128 * N * r > BOUNDS.maxMemBytes) return null;
  const salt = Buffer.from(m[4] ?? '', 'base64url');
  const key = Buffer.from(m[5] ?? '', 'base64url');
  if (salt.length < SALT_BYTES || key.length < KEY_BYTES) return null;
  return { params: { N, r, p }, salt, key };
}

export interface Verified {
  readonly ok: boolean;
  /** The hash is valid but weaker than the current parameters: hash again now that the password is known. */
  readonly needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string, current: ScryptParams = SCRYPT_PARAMS): Promise<Verified> {
  const parsed = parseHash(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const actual = await scrypt(password, parsed.salt, { ...parsed.params }).catch(() => null);
  if (!actual || actual.length !== parsed.key.length) return { ok: false, needsRehash: false };
  const ok = timingSafeEqual(actual, parsed.key);
  const { N, r, p } = parsed.params;
  return { ok, needsRehash: ok && (N < current.N || r < current.r || p < current.p) };
}

// ---------------------------------------------------------------------------
// Signed tokens
// ---------------------------------------------------------------------------

export type Purpose = 'session' | 'invite';

interface TokenPayload {
  /** What the token is for. A session token is never accepted as an invite, nor the reverse. */
  readonly p: Purpose;
  /** Tenant id. */
  readonly t: string;
  /** Expiry, ms since the epoch. */
  readonly exp: number;
  /** Invite: the nonce stored on the owner row. Session: a tag of the password hash it was issued for. */
  readonly n: string;
}

export const SESSION_COOKIE = '__Host-cw_session';
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7;
export const INVITE_MAX_AGE_S = 60 * 60 * 48;
const MIN_SECRET_BYTES = 32;
const TOKEN_CONTEXT = 'chat-widget.token.v1.';

export interface Auth {
  sign(purpose: Purpose, tenantId: string, n: string, maxAgeS: number): string;
  /** The payload of a valid, unexpired token for this purpose; otherwise null. */
  verify(token: string, purpose: Purpose): { readonly tenantId: string; readonly n: string } | null;
  /** A short tag of a password hash: a session issued before a password change stops working. */
  hashTag(passwordHash: string): string;
  /** Timing-safe comparison of two strings of any length. */
  same(a: string, b: string): boolean;
}

export function createAuth(secret: string, now: () => Date): Auth {
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) throw new Error(`The session secret needs at least ${MIN_SECRET_BYTES} bytes`);
  const mac = (data: string): Buffer => createHmac('sha256', secret).update(TOKEN_CONTEXT + data).digest();
  // Comparing HMACs under a per-process key gives equal lengths and leaks nothing about either input.
  const compareKey = randomBytes(32);
  const same = (a: string, b: string): boolean =>
    timingSafeEqual(createHmac('sha256', compareKey).update(a).digest(), createHmac('sha256', compareKey).update(b).digest());

  return {
    sign(purpose, tenantId, n, maxAgeS) {
      const payload: TokenPayload = { p: purpose, t: tenantId, exp: now().getTime() + maxAgeS * 1000, n };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${body}.${mac(body).toString('base64url')}`;
    },
    verify(token, purpose) {
      const dot = token.indexOf('.');
      if (dot <= 0 || token.length > 2048) return null;
      const body = token.slice(0, dot);
      const signature = Buffer.from(token.slice(dot + 1), 'base64url');
      const expected = mac(body);
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (typeof payload !== 'object' || payload === null) return null;
      const { p, t, exp, n } = payload as Record<string, unknown>;
      if (p !== purpose || typeof t !== 'string' || typeof n !== 'string' || typeof exp !== 'number') return null;
      if (!(now().getTime() < exp)) return null;
      return { tenantId: t, n };
    },
    hashTag: (passwordHash) => mac(`password:${passwordHash}`).toString('base64url').slice(0, 22),
    same,
  };
}

// ---------------------------------------------------------------------------
// Cookie and Basic
// ---------------------------------------------------------------------------

/**
 * `__Host-` makes the browser refuse the cookie unless it is Secure, has Path=/ and no Domain, so
 * a sibling subdomain cannot set or shadow it. SameSite=Strict keeps it off cross-site requests.
 * Browsers treat http://localhost as secure, so local runs work.
 */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** HTTP Basic with the password compared in constant time. The user name is ignored. */
export function basicAuthOk(request: Request, expected: string | null, auth: Pick<Auth, 'same'>): boolean {
  if (expected === null || expected === '') return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return auth.same(decoded.slice(colon + 1), expected);
}
