import { describe, expect, it } from 'vitest';
import { createECDH } from 'node:crypto';
import webpush from 'web-push';
import { checkVapid, derivePublicKey, generateVapidPair, readVapidConfig } from '../server/vapid.ts';

const subject = 'mailto:lab@example.test';

describe('checkVapid: the ECDH pair check', () => {
  it('a generated pair matches', () => {
    const check = checkVapid({ ...generateVapidPair(), subject });
    expect(check).toMatchObject({ publicKeyFormatOk: true, privateKeyFormatOk: true, pairMatches: true, subjectOk: true, ok: true });
    expect(check.publicKeyBytes).toBe(65);
  });

  it('halves from two different runs do not match, though each one is well formed', () => {
    const a = generateVapidPair();
    const b = generateVapidPair();
    const check = checkVapid({ publicKey: a.publicKey, privateKey: b.privateKey, subject });
    expect(check).toMatchObject({ publicKeyFormatOk: true, privateKeyFormatOk: true, pairMatches: false, ok: false });
  });

  it('derives the same public key that web-push generated', () => {
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    expect(derivePublicKey(privateKey)?.toString('base64url')).toBe(publicKey);
  });

  it('derives from a key made with node:crypto directly', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    expect(derivePublicKey(ecdh.getPrivateKey().toString('base64url'))?.equals(ecdh.getPublicKey())).toBe(true);
  });

  it('refuses private keys that are not a P-256 scalar', () => {
    expect(derivePublicKey(Buffer.alloc(32).toString('base64url'))).toBeNull(); // zero
    expect(derivePublicKey(Buffer.alloc(32, 0xff).toString('base64url'))).toBeNull(); // above the order
    expect(derivePublicKey(Buffer.alloc(31, 1).toString('base64url'))).toBeNull();
    expect(derivePublicKey('not base64url!')).toBeNull();
  });

  it('reports the public key format: length, the 0x04 prefix, and the alphabet', () => {
    const { publicKey, privateKey } = generateVapidPair();
    const compressed = Buffer.from(publicKey, 'base64url');
    compressed[0] = 0x02;
    expect(checkVapid({ publicKey: compressed.toString('base64url'), privateKey, subject }).publicKeyFormatOk).toBe(false);
    expect(checkVapid({ publicKey: publicKey.slice(0, 40), privateKey, subject }).publicKeyFormatOk).toBe(false);
    // Standard base64 with padding is not base64url: Buffer would decode it silently.
    const standard = Buffer.from(publicKey, 'base64url').toString('base64');
    expect(checkVapid({ publicKey: standard, privateKey, subject })).toMatchObject({ publicKeyFormatOk: false, publicKeyBytes: 0 });
  });

  it('missing keys are reported as missing, not as a mismatch only', () => {
    expect(checkVapid({ publicKey: '', privateKey: '', subject })).toMatchObject({
      publicKeyPresent: false,
      privateKeyPresent: false,
      pairMatches: false,
      ok: false,
    });
  });

  it.each([
    ['mailto:lab@example.test', true],
    ['https://lab.example.test/contact', true],
    ['mailto:', false],
    ['http://lab.example.test', false],
    ['lab@example.test', false],
    ['', false],
  ])('subject %j is ok: %s', (value, ok) => {
    expect(checkVapid({ ...generateVapidPair(), subject: value }).subjectOk).toBe(ok);
  });

  it('never puts a key in its result', () => {
    const pair = generateVapidPair();
    const text = JSON.stringify(checkVapid({ ...pair, subject }));
    expect(text).not.toContain(pair.privateKey);
    expect(text).not.toContain(pair.publicKey);
  });
});

describe('readVapidConfig', () => {
  it('reads and trims the three variables, and reads a missing one as empty', () => {
    expect(
      readVapidConfig({ PUSH_LAB_VAPID_PUBLIC_KEY: ' abc \n', PUSH_LAB_VAPID_SUBJECT: 'mailto:a@example.test' }),
    ).toEqual({ publicKey: 'abc', privateKey: '', subject: 'mailto:a@example.test' });
  });
});
