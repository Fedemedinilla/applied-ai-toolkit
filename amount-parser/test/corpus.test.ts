// The corpus is the spec: every phrase in corpus/corpus.json runs here, grouped by family, with
// the same acceptance rule the source project used.
//
// - A case the corpus marks ambiguous AND gives no total must come back ambiguous (the third answer).
// - A case with a total must come back with exactly that number, not flagged.
// - A case with no total and not ambiguous must come back with no amount.
//
// The corpus also marks some cases ambiguous about DIRECTION (bought or sold?) while naming a total.
// That ambiguity belongs to whoever classifies the movement, not to this parser, so those cases are
// held to their total.

import { describe, expect, it } from 'vitest';
import { parseAmount, type ParsedAmount } from '../src/index.ts';
import { corpus, type CorpusCase } from './corpus-data.ts';

type Expected = { kind: 'ask' } | { kind: 'none' } | { kind: 'value'; value: number };

function expectedOf(c: CorpusCase): Expected {
  if (c.ambiguous && c.total === null) return { kind: 'ask' };
  if (c.total === null) return { kind: 'none' };
  return { kind: 'value', value: c.total };
}

function meets(r: ParsedAmount | null, e: Expected): boolean {
  if (e.kind === 'ask') return r !== null && r.ambiguous;
  if (e.kind === 'none') return r === null || r.value === null;
  return r !== null && r.value !== null && Math.abs(r.value - e.value) < 0.005 && !r.ambiguous;
}

const families = [...new Set(corpus.map((c) => c.family))].sort();

describe('corpus file', () => {
  it('has 165 unique phrases in 15 families, each with a note', () => {
    expect(corpus).toHaveLength(165);
    expect(new Set(corpus.map((c) => c.phrase)).size).toBe(corpus.length);
    expect(families).toHaveLength(15);
    for (const c of corpus) expect(c.note.length).toBeGreaterThan(10);
  });

  it('records what the earlier parser returned for every red-team case', () => {
    const redTeam = corpus.filter((c) => c.source === 'red-team');
    expect(redTeam).toHaveLength(39);
    for (const c of redTeam) expect(c.earlier_parser).toBeTypeOf('string');
  });

  it('has exactly one known conflict', () => {
    expect(corpus.filter((c) => c.known_conflict).map((c) => c.phrase)).toEqual(['compre 2 sillas de plastico 45 mil']);
  });
});

for (const family of families) {
  describe(`family ${family}`, () => {
    for (const c of corpus.filter((x) => x.family === family && !x.known_conflict)) {
      const e = expectedOf(c);
      const label = e.kind === 'value' ? String(e.value) : e.kind === 'ask' ? 'ask' : 'no amount';
      it(`${c.phrase} -> ${label}`, () => {
        const r = parseAmount(c.phrase);
        expect(meets(r, e), `${JSON.stringify(r)}\n${c.note}`).toBe(true);
        // When the parser multiplies, the factors it reports are the ones the corpus names.
        if (r && r.quantity !== null) {
          expect(r.quantity).toBe(c.quantity);
          expect(r.unitPrice).toBe(c.unit_price);
        }
      });
    }
  });
}

describe('known conflict', () => {
  // The corpus marks this ambiguous and "10 bolsas de cemento 145 mil" a total. Same shape, so no
  // rule can satisfy both; the parser takes the total reading. This test pins that choice so a
  // change to it is a decision, not an accident.
  it('compre 2 sillas de plastico 45 mil reads as a total of 45000', () => {
    const r = parseAmount('compre 2 sillas de plastico 45 mil');
    expect(r?.value).toBe(45_000);
    expect(r?.ambiguous).toBe(false);
    expect(meets(parseAmount('10 bolsas de cemento 145 mil'), { kind: 'value', value: 145_000 })).toBe(true);
  });
});

describe('per-family score', () => {
  it('passes every case of every family', () => {
    const rows = families.map((family) => {
      const cases = corpus.filter((c) => c.family === family && !c.known_conflict);
      const pass = cases.filter((c) => meets(parseAmount(c.phrase), expectedOf(c))).length;
      return { family, pass, total: cases.length };
    });
    console.log(rows.map((r) => `${String(r.pass).padStart(3)}/${String(r.total).padEnd(3)} ${r.family}`).join('\n'));
    expect(rows.filter((r) => r.pass !== r.total)).toEqual([]);
  });
});
