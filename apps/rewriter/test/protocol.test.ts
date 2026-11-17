// The page carries its own copies of the rewriter's option lists and result types, so it does not
// bundle zod. These tests hold the copies to prose-rewriter's schemas.

import { describe, expect, it } from 'vitest';
import { Genre, Lang, Mode, Register, Variety, type RewriteResult } from '../../../prose-rewriter/src/index.ts';
import { GENRE_LABEL, GENRES, LANG_LABEL, LANGS, MODE_LABEL, MODES, REGISTER_LABEL, REGISTERS, VARIETIES, VARIETY_LABEL } from '../src/protocol.ts';
import { asReply, asResult, FLAG_KINDS, type Result } from '../src/result.ts';

describe('the option lists', () => {
  it('are the rewriter\'s own, in its order, each with a label', () => {
    expect(GENRES).toEqual(Genre.options);
    expect(LANGS).toEqual(Lang.options);
    expect(VARIETIES).toEqual(Variety.options);
    expect(REGISTERS).toEqual(Register.options);
    expect(MODES).toEqual(Mode.options);
    expect(Object.keys(GENRE_LABEL)).toEqual([...GENRES]);
    expect(Object.keys(LANG_LABEL)).toEqual([...LANGS]);
    expect(Object.keys(VARIETY_LABEL)).toEqual([...VARIETIES]);
    expect(Object.keys(REGISTER_LABEL)).toEqual([...REGISTERS]);
    expect(Object.keys(MODE_LABEL)).toEqual([...MODES]);
  });
});

describe('the result types', () => {
  it('accept every RewriteResult (checked by tsc) and name every flag kind', () => {
    const fits = (r: RewriteResult): Result => r;
    expect(typeof fits).toBe('function');
    const kinds: ReadonlyArray<RewriteResult['flags'][number]['kind']> = FLAG_KINDS;
    expect(kinds).toHaveLength(5);
  });
});

const RESULT = {
  rewritten: 'Hola.',
  diff: [],
  changes: [{ id: 'e1', span: { start: 0, end: 4 }, before: 'Hola', after: 'Hola', reason: 'r', stage: 'edit', status: 'applied' }],
  facts: { kept: [], dropped: [], added: [], fromCv: [], notInCv: [], placeholders: [] },
  lint: {
    before: { findings: [{ ruleId: 'LEX-01', level: 1, severity: 'high', start: 0, end: 4, line: 1, column: 1, match: 'Hola', message: 'm', suggestion: 's' }], passesTier1: false, score: { points: 12, max: 15 } },
    after: { findings: [], passesTier1: true, score: { points: 15, max: 15 } },
  },
  flags: [{ kind: 'injection', span: { start: 0, end: 1 }, message: 'm' }],
  status: 'ok',
  usage: { calls: 2, costUsd: null },
};

describe('asResult', () => {
  it('accepts a result, with a null cost', () => {
    expect(asResult(RESULT)).not.toBeNull();
    expect(asReply({ original: 'Hola.', result: RESULT })).not.toBeNull();
  });

  it.each([
    ['an unknown status', { ...RESULT, status: 'fine' }],
    ['a change with an unknown status', { ...RESULT, changes: [{ ...RESULT.changes[0], status: 'maybe' }] }],
    ['a backwards span', { ...RESULT, changes: [{ ...RESULT.changes[0], span: { start: 4, end: 0 } }] }],
    ['a negative cost', { ...RESULT, usage: { calls: 1, costUsd: -1 } }],
    ['a fractional call count', { ...RESULT, usage: { calls: 1.5, costUsd: 0 } }],
    ['a finding with level 4', { ...RESULT, lint: { ...RESULT.lint, before: { ...RESULT.lint.before, findings: [{ ...RESULT.lint.before.findings[0], level: 4 }] } } }],
    ['an unknown flag kind', { ...RESULT, flags: [{ kind: 'secret', message: 'm' }] }],
    ['a missing fact list', { ...RESULT, facts: { kept: [] } }],
    ['no lint after', { ...RESULT, lint: { before: RESULT.lint.before } }],
  ])('refuses %s', (_, value) => {
    expect(asResult(value)).toBeNull();
  });

  it('refuses a reply without the original', () => {
    expect(asReply({ result: RESULT })).toBeNull();
    expect(asReply({ original: 'x', result: {} })).toBeNull();
  });
});
