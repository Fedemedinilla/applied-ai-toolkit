/**
 * Signing and verification of the fake's access tokens, through WebCrypto only. ES256 is what a
 * project with asymmetric signing keys issues (the public key is served in the JWKS, so getClaims
 * can verify locally). HS256 is what a project on the legacy shared JWT secret issues (no kid,
 * nothing public to verify with, so getClaims has to ask Auth through /user).
 */

export type JwtAlgorithm = 'ES256' | 'HS256';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly role: 'authenticated';
  readonly aud: 'authenticated';
  readonly iat: number;
  readonly exp: number;
  readonly session_id: string;
  readonly aal: 'aal1';
  readonly amr: ReadonlyArray<{ readonly method: string; readonly timestamp: number }>;
}

export interface SigningKeys {
  /** Unique per fake: auth-js caches the JWKS per storage key, across clients, for 10 minutes. */
  readonly kid: string;
  /** The public JWK as `/.well-known/jwks.json` serves it. */
  readonly publicJwk: JsonWebKey & { readonly kid: string; readonly alg: 'ES256'; readonly use: 'sig' };
  readonly ecdsa: CryptoKeyPair;
  readonly hmac: CryptoKey;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: 'malformed' | 'signature' | 'expired' };

const ECDSA = { name: 'ECDSA', hash: 'SHA-256' } as const;
const encoder = new TextEncoder();

export function base64url(value: string | Uint8Array | ArrayBuffer): string {
  return Buffer.from(typeof value === 'string' ? value : new Uint8Array(value)).toString('base64url');
}

export async function createSigningKeys(): Promise<SigningKeys> {
  const kid = crypto.randomUUID();
  const ecdsa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', ecdsa.publicKey);
  const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { kid, publicJwk: { ...exported, kid, alg: 'ES256', use: 'sig' }, ecdsa, hmac };
}

function header(keys: SigningKeys, alg: JwtAlgorithm): Record<string, string> {
  return alg === 'HS256' ? { alg, typ: 'JWT' } : { alg, typ: 'JWT', kid: keys.kid };
}

function sign(keys: SigningKeys, alg: JwtAlgorithm, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  return alg === 'HS256' ? crypto.subtle.sign('HMAC', keys.hmac, data) : crypto.subtle.sign(ECDSA, keys.ecdsa.privateKey, data);
}

/**
 * Signs the claims. With `tamperedSub`, the payload that ships carries that sub while the signature
 * stays the one computed over the original payload: a token someone edited to pass as another user.
 */
export async function signAccessToken(
  keys: SigningKeys,
  alg: JwtAlgorithm,
  claims: AccessTokenClaims,
  tamperedSub?: string,
): Promise<string> {
  const head = base64url(JSON.stringify(header(keys, alg)));
  const body = base64url(JSON.stringify(claims));
  const signature = await sign(keys, alg, encoder.encode(`${head}.${body}`));
  const shipped = tamperedSub === undefined ? body : base64url(JSON.stringify({ ...claims, sub: tamperedSub }));
  return `${head}.${shipped}.${base64url(signature)}`;
}

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function isClaims(value: unknown): value is AccessTokenClaims {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['sub'] === 'string' && typeof v['exp'] === 'number' && typeof v['session_id'] === 'string';
}

/**
 * What Auth checks before it trusts a bearer token on /user and /logout: the signature under the
 * algorithm its header names, then the expiry.
 */
export async function verifyAccessToken(keys: SigningKeys, token: string, nowSeconds: number): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [head = '', body = '', signature = ''] = parts;
  let parsedHeader: unknown;
  let claims: unknown;
  try {
    parsedHeader = decodePart(head);
    claims = decodePart(body);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isClaims(claims) || typeof parsedHeader !== 'object' || parsedHeader === null) return { ok: false, reason: 'malformed' };
  const alg = (parsedHeader as Record<string, unknown>)['alg'];
  const data = encoder.encode(`${head}.${body}`);
  const sig = new Uint8Array(Buffer.from(signature, 'base64url'));
  let valid: boolean;
  if (alg === 'HS256') valid = await crypto.subtle.verify('HMAC', keys.hmac, sig, data);
  else if (alg === 'ES256') valid = await crypto.subtle.verify(ECDSA, keys.ecdsa.publicKey, sig, data);
  else return { ok: false, reason: 'malformed' };
  if (!valid) return { ok: false, reason: 'signature' };
  if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** base64url(SHA-256(verifier)), the S256 code challenge of RFC 7636. */
export async function s256Challenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
}
