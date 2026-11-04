import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sha256, sha256Hex, utf8 } from '../src/index.ts';

const node = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Any UTF-16 code unit sequence, lone surrogates included. */
const anyString = fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)), maxLength: 200 });

describe('sha256', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches node:crypto at every padding boundary (0 to 200 bytes)', () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(hex(sha256(bytes))).toBe(node(bytes));
    }
  });

  it('matches node:crypto on random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => hex(sha256(bytes)) === node(bytes)),
      { numRuns: 300 },
    );
  });

  it('encodes UTF-8 exactly as TextEncoder does, lone surrogates included', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(anyString, (text) => {
        expect([...utf8(text)]).toEqual([...encoder.encode(text)]);
      }),
      { numRuns: 500 },
    );
    expect([...utf8('\u{1f3b2}')]).toEqual([0xf0, 0x9f, 0x8e, 0xb2]);
  });
});
