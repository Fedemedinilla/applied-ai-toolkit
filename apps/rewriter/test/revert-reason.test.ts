// The checks' reasons for taking a change back, as prose-rewriter writes them, in plain English.

import { describe, expect, it } from 'vitest';
import { explainRevert } from '../src/revert-reason.ts';

describe('explainRevert', () => {
  it('says what a lost fact means', () => {
    expect(explainRevert('facts: loses Nodo, Sur, Software without drop')).toBe('It would have removed something your text states: Nodo, Sur, Software.');
  });

  it('says what an invented fact means', () => {
    expect(explainRevert('facts: adds Pedidos, found in neither the text nor the CV')).toBe('It would have added Pedidos, which neither your text nor your CV states.');
  });

  it('says a voice change is one', () => {
    expect(explainRevert('voice: The original addresses no one directly; the rewrite adds voseo.')).toBe(
      'It changed your voice: The original addresses no one directly; the rewrite adds voseo.',
    );
  });

  it('says a new level 1 pattern is one', () => {
    expect(explainRevert('relint: adds the level 1 finding LEX-01, STR-02')).toBe('It would have added a level 1 pattern (LEX-01, STR-02).');
  });

  it('says a malformed edit was not placed', () => {
    expect(explainRevert('schema: before is empty')).toBe('The model\'s edit was malformed, so it was not placed.');
  });

  it('passes any other reason on as it is', () => {
    expect(explainRevert('"texto que no existe" is not in sentence 2')).toBe('"texto que no existe" is not in sentence 2');
  });
});
