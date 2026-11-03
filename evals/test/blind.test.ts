import { describe, expect, it } from 'vitest';
import { blind } from '../src/blind.ts';
import type { EvalFailure, EvalRow } from '../src/runner.ts';

const row = (variant: string, i: number): EvalRow => ({
  variant,
  lang: 'en',
  case: `case-${i % 3}`,
  sample: i,
  now: '2026-03-04T12:00:00.000Z',
  brief: `brief ${i % 3}`,
  text: `text ${variant}-${i}`.replace(variant, 'x'),
  words: 40 + i,
  stop: i === 4 ? 'max_tokens' : 'end_turn',
  ms: 1000 + i,
  usage: { input_tokens: 10, output_tokens: 99 + i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

const rows: EvalRow[] = ['VARIANT_ALPHA', 'VARIANT_BETA'].flatMap((v) => Array.from({ length: 12 }, (_, i) => row(v, i)));

describe('blind', () => {
  it('gives the judge only case, language, run date, brief and text', () => {
    const { pieces } = blind(rows, 1);
    for (const p of pieces) expect(Object.keys(p).sort()).toEqual(['brief', 'case', 'id', 'lang', 'now', 'text']);
    const serialized = JSON.stringify(pieces);
    expect(serialized).not.toContain('VARIANT_');
    expect(serialized).not.toContain('max_tokens');
    expect(serialized).not.toContain('output_tokens');
  });

  it('keeps the variant, sample and stop reason in the key, one entry per piece', () => {
    const { pieces, key } = blind(rows, 1);
    expect(Object.keys(key)).toHaveLength(rows.length);
    expect(new Set(pieces.map((p) => p.id)).size).toBe(rows.length);
    const cut = Object.values(key).filter((k) => k.stop === 'max_tokens');
    expect(cut.map((k) => k.variant).sort()).toEqual(['VARIANT_ALPHA', 'VARIANT_BETA']);
  });

  it('maps every piece back to the row it came from', () => {
    const { pieces, key } = blind(rows, 9);
    for (const p of pieces) {
      const k = key[p.id]!;
      const source = rows.find((r) => r.variant === k.variant && r.sample === k.sample)!;
      expect(p.text).toBe(source.text);
      expect(p.case).toBe(source.case);
    }
  });

  it('shuffles across variants and is reproducible from the seed', () => {
    const a = blind(rows, 42);
    const b = blind(rows, 42);
    const c = blind(rows, 43);
    expect(a).toEqual(b);
    expect(a.pieces.map((p) => p.id)).not.toEqual(c.pieces.map((p) => p.id));
    // Input order is all of ALPHA then all of BETA; the blind order must not be.
    const order = a.pieces.map((p) => a.key[p.id]!.variant);
    expect(order.slice(0, 12).every((v) => v === 'VARIANT_ALPHA')).toBe(false);
  });

  it('ids carry no position: the first row does not get a predictable id', () => {
    const ids = new Set([1, 2, 3, 4, 5].map((seed) => Object.keys(blind(rows.slice(0, 1), seed).key)[0]));
    expect(ids.size).toBe(5);
  });

  it('withholds failed calls, refusals and empty replies from the judge, and keeps them in the key', () => {
    const failure: EvalFailure = { variant: 'VARIANT_BETA', lang: 'en', case: 'case-0', sample: 99, error: '529 overloaded' };
    const refused: EvalRow = { ...row('VARIANT_ALPHA', 20), text: '', stop: 'refusal' };
    const empty: EvalRow = { ...row('VARIANT_ALPHA', 21), text: '  ' };
    const { pieces, key } = blind([...rows, failure, refused, empty], 5);
    expect(pieces).toHaveLength(rows.length);
    const withheld = Object.values(key).filter((k) => k.withheld);
    expect(withheld.map((k) => [k.variant, k.withheld]).sort()).toEqual([
      ['VARIANT_ALPHA', 'empty'],
      ['VARIANT_ALPHA', 'refusal'],
      ['VARIANT_BETA', 'failed'],
    ]);
    for (const p of pieces) expect(key[p.id]!.withheld).toBeUndefined();
  });
});
