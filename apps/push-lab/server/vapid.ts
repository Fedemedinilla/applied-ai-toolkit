// VAPID keys: reading them from the environment, generating a pair, and checking that the two
// halves belong together.
//
// A public key from one run and a private key from another fail silently. Subscribing works,
// because the browser only sees the public key. Every push is then signed with a private key that
// does not match it, the push service refuses it, and the notification never arrives. Nothing
// before that point reports an error, so `checkVapid` derives the public key from the private key
// with ECDH and compares the two.

import { createECDH, timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';

export const ENV = {
  publicKey: 'PUSH_LAB_VAPID_PUBLIC_KEY',
  privateKey: 'PUSH_LAB_VAPID_PRIVATE_KEY',
  subject: 'PUSH_LAB_VAPID_SUBJECT',
} as const;

export interface VapidConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  /** A mailto: or https: URL the push service can use to reach the sender (RFC 8292). */
  readonly subject: string;
}

/** Reads the three variables, trimmed. A missing variable reads as an empty string. */
export function readVapidConfig(env: Readonly<Record<string, string | undefined>>): VapidConfig {
  return {
    publicKey: (env[ENV.publicKey] ?? '').trim(),
    privateKey: (env[ENV.privateKey] ?? '').trim(),
    subject: (env[ENV.subject] ?? '').trim(),
  };
}

export interface VapidCheck {
  readonly publicKeyPresent: boolean;
  /** Bytes after base64url decoding; 0 when absent or not base64url. */
  readonly publicKeyBytes: number;
  /** An uncompressed P-256 point: 65 bytes starting with 0x04. */
  readonly publicKeyFormatOk: boolean;
  readonly privateKeyPresent: boolean;
  /** A 32-byte P-256 scalar. */
  readonly privateKeyFormatOk: boolean;
  /** The public key derived from the private key equals the configured public key. */
  readonly pairMatches: boolean;
  readonly subjectOk: boolean;
  /** Everything above holds: pushes can be signed. */
  readonly ok: boolean;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/** Strict base64url: Buffer.from ignores characters outside the alphabet, so check first. */
function decode(text: string): Buffer | null {
  return BASE64URL.test(text) ? Buffer.from(text, 'base64url') : null;
}

/** The public key that belongs to `privateKey`, or null when it is not a valid P-256 scalar. */
export function derivePublicKey(privateKey: string): Buffer | null {
  const bytes = decode(privateKey);
  if (!bytes || bytes.length !== 32) return null;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(bytes);
    return ecdh.getPublicKey();
  } catch {
    return null; // zero, or not below the curve order
  }
}

function subjectOk(subject: string): boolean {
  try {
    const url = new URL(subject);
    if (url.protocol === 'mailto:') return /^[^@\s]+@[^@\s]+$/u.test(url.pathname);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Never returns or logs a key; only what is true about them. */
export function checkVapid(config: VapidConfig): VapidCheck {
  const pub = decode(config.publicKey);
  const publicKeyFormatOk = pub !== null && pub.length === 65 && pub[0] === 0x04;
  const priv = decode(config.privateKey);
  const privateKeyFormatOk = priv !== null && priv.length === 32;
  const derived = privateKeyFormatOk ? derivePublicKey(config.privateKey) : null;
  const pairMatches = publicKeyFormatOk && derived !== null && pub !== null && derived.length === pub.length && timingSafeEqual(derived, pub);
  const check = {
    publicKeyPresent: config.publicKey !== '',
    publicKeyBytes: pub?.length ?? 0,
    publicKeyFormatOk,
    privateKeyPresent: config.privateKey !== '',
    privateKeyFormatOk,
    pairMatches,
    subjectOk: subjectOk(config.subject),
  };
  return { ...check, ok: publicKeyFormatOk && privateKeyFormatOk && pairMatches && check.subjectOk };
}

/** A fresh pair, base64url, from web-push (an ECDH P-256 key pair). */
export function generateVapidPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}
