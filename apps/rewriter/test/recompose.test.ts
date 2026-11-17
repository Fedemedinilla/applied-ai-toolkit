// The page rebuilds the text from the original and the changes the user keeps. A change the user
// reverts gives back the original's own words, and a change the checks reverted can never come in.

import { describe, expect, it } from 'vitest';
import { recompose, type Piece } from '../src/recompose.ts';
import type { ResultChange } from '../src/result.ts';

const change = (id: string, original: string, before: string, after: string, from = 0, status: ResultChange['status'] = 'applied'): ResultChange => {
  const start = original.indexOf(before, from);
  if (start < 0) throw new Error(`"${before}" is not in the original`);
  return { id, span: { start, end: start + before.length }, before, after, reason: 'test', stage: 'edit', status };
};

const ORIGINAL = 'Hola Marta, espero que estés bien. Me apasiona potenciar sinergias. El sitio carga en 1,6 s. Saludos.';
const C1 = change('e1', ORIGINAL, 'espero que estés bien. ', '');
const C2 = change('e2', ORIGINAL, 'Me apasiona potenciar sinergias.', 'Te escribo por el sitio.');
const C3 = change('e3', ORIGINAL, 'carga', 'ya carga');
const ALL = [C1, C2, C3];
const ids = (...list: string[]) => new Set(list);

const text = (r: ReturnType<typeof recompose>) => {
  if (!r.ok) throw new Error(r.reason);
  return r.text;
};
const pieces = (r: ReturnType<typeof recompose>): readonly Piece[] => {
  if (!r.ok) throw new Error(r.reason);
  return r.pieces;
};

describe('recompose', () => {
  it('with every change kept gives the full rewrite', () => {
    expect(text(recompose(ORIGINAL, ALL, ids('e1', 'e2', 'e3')))).toBe('Hola Marta, Te escribo por el sitio. El sitio ya carga en 1,6 s. Saludos.');
  });

  it('with none kept gives the original back, byte for byte', () => {
    expect(text(recompose(ORIGINAL, ALL, ids()))).toBe(ORIGINAL);
  });

  it('reverting one change brings back only its own words', () => {
    expect(text(recompose(ORIGINAL, ALL, ids('e1', 'e3')))).toBe('Hola Marta, Me apasiona potenciar sinergias. El sitio ya carga en 1,6 s. Saludos.');
  });

  it('does not depend on the order of the changes', () => {
    const r = recompose(ORIGINAL, [C3, C1, C2], ids('e1', 'e2', 'e3'));
    expect(text(r)).toBe(text(recompose(ORIGINAL, ALL, ids('e1', 'e2', 'e3'))));
  });

  it('never lets in a change the checks reverted, even when asked to', () => {
    const invented = change('e4', ORIGINAL, 'Saludos.', 'Tengo diez años de experiencia. Saludos.', 0, 'reverted');
    expect(text(recompose(ORIGINAL, [...ALL, invented], ids('e1', 'e2', 'e3', 'e4')))).not.toContain('diez años');
    expect(text(recompose(ORIGINAL, [invented], ids('e4')))).toBe(ORIGINAL);
  });

  it('ignores an id that names no change', () => {
    expect(text(recompose(ORIGINAL, ALL, ids('e9')))).toBe(ORIGINAL);
  });

  it('marks kept changes, user-reverted changes and untouched text apart', () => {
    expect(pieces(recompose(ORIGINAL, [C2], ids('e2')))).toEqual([
      { kind: 'same', text: 'Hola Marta, espero que estés bien. ' },
      { kind: 'changed', id: 'e2', text: 'Te escribo por el sitio.', before: 'Me apasiona potenciar sinergias.' },
      { kind: 'same', text: ' El sitio carga en 1,6 s. Saludos.' },
    ]);
    expect(pieces(recompose(ORIGINAL, [C2], ids()))).toEqual([
      { kind: 'same', text: 'Hola Marta, espero que estés bien. ' },
      { kind: 'restored', id: 'e2', text: 'Me apasiona potenciar sinergias.' },
      { kind: 'same', text: ' El sitio carga en 1,6 s. Saludos.' },
    ]);
  });

  it('keeps a deletion as a piece with empty text, so the page can still show it', () => {
    expect(pieces(recompose(ORIGINAL, [C1], ids('e1')))[1]).toEqual({ kind: 'changed', id: 'e1', text: '', before: 'espero que estés bien. ' });
  });

  it('handles adjacent hunks, each one reverted alone', () => {
    const o = 'uno dos tres';
    const a = change('a', o, 'uno ', 'UNO ');
    const b = change('b', o, 'dos', 'DOS');
    expect(text(recompose(o, [a, b], ids('a', 'b')))).toBe('UNO DOS tres');
    expect(text(recompose(o, [a, b], ids('a')))).toBe('UNO dos tres');
    expect(text(recompose(o, [a, b], ids('b')))).toBe('uno DOS tres');
    expect(pieces(recompose(o, [a, b], ids('a', 'b'))).map((p) => p.kind)).toEqual(['changed', 'changed', 'same']);
  });

  it('handles changes at the very start and the very end', () => {
    const o = 'abc';
    const s = change('s', o, 'a', 'A');
    const e = change('e', o, 'c', 'C!');
    expect(text(recompose(o, [s, e], ids('s', 'e')))).toBe('AbC!');
  });

  it('counts offsets in UTF-16 units, as the rewriter does, so emoji before a change do not shift it', () => {
    const o = 'Ha, cheers Tomasz 😂 honestly it could be a game-changer. I owe you a pint';
    const c = change('e1', o, 'honestly ', '');
    const d = change('e2', o, 'be a game-changer', 'help a lot');
    expect(text(recompose(o, [c, d], ids('e1', 'e2')))).toBe('Ha, cheers Tomasz 😂 it could help a lot. I owe you a pint');
  });

  it('allows an insertion (an empty span) next to a change', () => {
    const o = 'uno dos';
    const ins: ResultChange = { id: 'i', span: { start: 3, end: 3 }, before: '', after: ',', reason: 'r', stage: 'edit', status: 'applied' };
    const b = change('b', o, ' dos', ' y dos');
    expect(text(recompose(o, [ins, b], ids('i', 'b')))).toBe('uno, y dos');
    expect(text(recompose(o, [ins, b], ids('b')))).toBe('uno y dos');
  });

  describe('refuses a result it cannot rebuild, rather than guess', () => {
    it('two applied changes that overlap', () => {
      const o = 'uno dos tres';
      const a = change('a', o, 'uno dos', 'X');
      const b = change('b', o, 'dos tres', 'Y');
      expect(recompose(o, [a, b], ids('a'))).toEqual({ ok: false, reason: 'overlap' });
    });

    it('a span past the end of the text', () => {
      const bad: ResultChange = { ...C3, span: { start: ORIGINAL.length - 1, end: ORIGINAL.length + 4 } };
      expect(recompose(ORIGINAL, [bad], ids())).toEqual({ ok: false, reason: 'out-of-range' });
    });

    it('a span whose text is not the change\'s "before"', () => {
      const bad: ResultChange = { ...C3, before: 'corre' };
      expect(recompose(ORIGINAL, [bad], ids('e3'))).toEqual({ ok: false, reason: 'before-mismatch' });
    });

    it('a span that ends before it starts', () => {
      const bad: ResultChange = { ...C3, span: { start: 10, end: 5 } };
      expect(recompose(ORIGINAL, [bad], ids())).toEqual({ ok: false, reason: 'out-of-range' });
    });

    it('two applied changes with one id', () => {
      expect(recompose(ORIGINAL, [C1, { ...C3, id: 'e1' }], ids())).toEqual({ ok: false, reason: 'duplicate-id' });
    });
  });

  it('takes a reverted change whose quote is not in the original, as prose-rewriter writes a misquote', () => {
    // An edit the code could not place (not-found, ambiguous, schema) comes back reverted, spanning
    // the sentence it named and carrying the model's quote: the span never holds that quote.
    const sentence = 'Me apasiona potenciar sinergias.';
    const misquote: ResultChange = { ...change('r', ORIGINAL, sentence, 'X', 0, 'reverted'), before: 'texto que no existe' };
    const nowhere: ResultChange = { ...misquote, id: 'r2', span: { start: 0, end: 0 } };
    expect(text(recompose(ORIGINAL, [C1, misquote, nowhere, C3], ids('e1', 'e3')))).toBe(text(recompose(ORIGINAL, [C1, C3], ids('e1', 'e3'))));
  });

  it('lets a reverted change overlap an applied one: only the applied one is placed', () => {
    const rev = change('r', ORIGINAL, 'Me apasiona', 'Me gusta', 0, 'reverted');
    expect(text(recompose(ORIGINAL, [C2, rev], ids('e2')))).toBe(ORIGINAL.replace('Me apasiona potenciar sinergias.', 'Te escribo por el sitio.'));
  });
});
