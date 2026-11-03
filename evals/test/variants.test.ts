import { describe, expect, it } from 'vitest';
import { createWriterTarget, LANGS } from '../example/business.ts';
import { ALL_CASES } from '../example/cases.ts';
import { VARIANTS } from '../example/variants.ts';
import type { SystemBlock } from '../src/model.ts';
import { applyEdits, countMatches, VariantError } from '../src/variants.ts';

const system = (): SystemBlock[] => [
  { type: 'text', text: 'Rule A.\nRule B costs $1,200.', cache_control: { type: 'ephemeral' } },
  { type: 'text', text: 'Between 35 and 60 words. Twice: twice.' },
];

describe('applyEdits', () => {
  it('replaces exact text once and leaves the input untouched', () => {
    const input = system();
    const before = JSON.stringify(input);
    const out = applyEdits(input, [{ block: 0, find: 'Rule A.', replace: 'Rule A, reworded.' }]);
    expect(out[0]!.text).toBe('Rule A, reworded.\nRule B costs $1,200.');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps cache_control and every other field of the block', () => {
    const out = applyEdits(system(), [{ block: 0, find: 'Rule A.', replace: 'X.' }]);
    expect(out[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(out[1]).toEqual(system()[1]);
  });

  it('fails when the target text is missing', () => {
    expect(() => applyEdits(system(), [{ block: 0, find: 'Rule C.', replace: 'x' }])).toThrow(/0 matches, expected exactly 1/);
  });

  it('fails when the target text is ambiguous', () => {
    expect(() => applyEdits(system(), [{ block: 1, find: 'wice', replace: 'x' }])).toThrow(/2 matches/);
  });

  it('fails on a block that does not exist', () => {
    expect(() => applyEdits(system(), [{ block: 5, find: 'a', replace: 'b' }])).toThrow(VariantError);
  });

  it('skips an optional edit that finds nothing, but not one that finds two', () => {
    expect(applyEdits(system(), [{ block: 0, find: 'absent', replace: 'x', optional: true }])).toEqual(system());
    expect(() => applyEdits(system(), [{ block: 1, find: 'wice', replace: 'x', optional: true }])).toThrow(/2 matches/);
  });

  it('inserts a string replacement literally, so "$&" and "$1" in new prompt text survive', () => {
    const out = applyEdits(system(), [{ block: 0, find: 'Rule A.', replace: 'Quote "$&" and $1 as written.' }]);
    expect(out[0]!.text.startsWith('Quote "$&" and $1 as written.')).toBe(true);
  });

  it('substitutes capture groups for a RegExp find', () => {
    const out = applyEdits(system(), [{ block: 1, find: /Between (\d+) and (\d+) words\./, replace: 'Up to $2 words.' }]);
    expect(out[1]!.text).toBe('Up to 60 words. Twice: twice.');
  });

  it('counts a global RegExp without being thrown off by its lastIndex', () => {
    const re = /wice/g;
    expect(countMatches('twice twice', re)).toBe(2);
    expect(countMatches('twice twice', re)).toBe(2);
    expect(() => countMatches('x', '')).toThrow(VariantError);
  });

  it('applies edits in order, so a later edit can target what an earlier one wrote', () => {
    const out = applyEdits(system(), [
      { block: 0, find: 'Rule A.', replace: 'Rule A2.' },
      { block: 0, find: 'Rule A2.', replace: 'Rule A3.' },
    ]);
    expect(out[0]!.text.startsWith('Rule A3.')).toBe(true);
  });
});

describe('the sample variants against the fictional target', () => {
  const target = createWriterTarget();
  const now = new Date('2026-03-04T12:00:00Z');

  it('every variant applies cleanly to every case and language', () => {
    for (const v of VARIANTS)
      for (const c of ALL_CASES)
        for (const lang of LANGS) expect(() => applyEdits(target.system(c, lang, now), v.edits(lang))).not.toThrow();
  });

  it('V0 is the production prompt, byte for byte', () => {
    const c = ALL_CASES[0]!;
    const v0 = VARIANTS.find((v) => v.id === 'V0')!;
    expect(applyEdits(target.system(c, 'en', now), v0.edits('en'))).toEqual(target.system(c, 'en', now));
  });

  it('V4 contains each of its parts and V3 does not contain the last one', () => {
    const c = ALL_CASES[0]!;
    const text = (id: string) => applyEdits(target.system(c, 'en', now), VARIANTS.find((v) => v.id === id)!.edits('en')).map((b) => b.text).join('\n');
    expect(text('V4')).toContain('the business still talks as itself');
    expect(text('V4')).toContain('A procedure is a fact too');
    expect(text('V4')).not.toMatch(/Between \d+ and \d+ words/);
    expect(text('V3')).not.toContain('the business still talks as itself');
  });
});
