// The corpus tab: every phrase of the parser's spec, what it should give, and what the parser
// gives now, in this browser. The data is fetched only when the tab is opened.

import { parseAmount, type AmbiguityReason, type ParsedAmount } from '../../../amount-parser/src/index.ts';
import { fold } from './categories.ts';
import { money } from './format.ts';

export interface CorpusCase {
  phrase: string;
  family: string;
  kind: 'expense' | 'income';
  total: number | null;
  ambiguous: boolean;
  note: string;
  known_conflict?: string;
}

/** Validates the fetched JSON. A case without the fields this tab reads is dropped. */
export function readCorpus(data: unknown): CorpusCase[] {
  if (!Array.isArray(data)) return [];
  return data.filter((c): c is CorpusCase => {
    if (typeof c !== 'object' || c === null) return false;
    const r = c as Record<string, unknown>;
    return (
      typeof r['phrase'] === 'string' &&
      typeof r['family'] === 'string' &&
      (r['kind'] === 'income' || r['kind'] === 'expense') &&
      (r['total'] === null || typeof r['total'] === 'number') &&
      typeof r['ambiguous'] === 'boolean' &&
      typeof r['note'] === 'string'
    );
  });
}

export interface CorpusLine {
  case: CorpusCase;
  parsed: ParsedAmount | null;
  /** "$36.000", "pregunta (precio por unidad o total)", "sin monto". */
  expected: string;
  got: string;
  /** Same answer as the corpus asks for: the same value, or a question when it expects one. */
  agrees: boolean;
}

/** The parser's reasons, in the words the phrases tab shows. A new reason fails the type check here. */
export const REASON_LABEL: Readonly<Record<AmbiguityReason, string>> = {
  unit_or_total: 'precio por unidad o total',
  open_remainder: 'monto con "y pico"',
  range: 'rango',
  discount_unclear: 'descuento antes o después',
  tax_unclear: 'IVA incluido o aparte',
  mixed_directions: 'entra y sale plata',
  net_or_gross: 'neto o bruto',
  instalments: 'cuota o total',
  several_quantities: 'varias cantidades',
  foreign_currency: 'otra moneda',
};

function describe(p: ParsedAmount | null): string {
  if (!p) return 'sin monto';
  if (p.ambiguous) return p.reason ? `pregunta (${REASON_LABEL[p.reason]})` : 'pregunta';
  if (p.value === null) return 'sin monto';
  return `${money(p.value)}${p.approximate ? ' (aprox.)' : ''}`;
}

/**
 * The parser's own acceptance rule (amount-parser/test/corpus.test.ts): a case with a total must
 * give exactly that number, unflagged; a case marked ambiguous with no total must ask; any other
 * case must give no amount. Some cases are marked ambiguous about direction (bought or sold?) and
 * still name a total. That doubt belongs to the income or expense guess, not to the parser.
 */
export function corpusLines(cases: readonly CorpusCase[]): CorpusLine[] {
  return cases.map((c) => {
    const parsed = parseAmount(c.phrase);
    const expected = c.total !== null ? money(c.total) : c.ambiguous ? 'pregunta' : 'sin monto';
    const agrees =
      c.total !== null
        ? parsed?.ambiguous === false && parsed.value === c.total
        : c.ambiguous
          ? parsed?.ambiguous === true
          : parsed === null || parsed.value === null;
    return { case: c, parsed, expected, got: describe(parsed), agrees };
  });
}

export interface CorpusFilter {
  text: string;
  /** Empty string for every family. */
  family: string;
  /** Only the phrases where the parser asks. */
  asksOnly: boolean;
}

/** Matches the folded query against the phrase and the note, so accents and case do not matter. */
export function filterLines(lines: readonly CorpusLine[], f: CorpusFilter): CorpusLine[] {
  const q = fold(f.text);
  return lines.filter(
    (l) =>
      (f.family === '' || l.case.family === f.family) &&
      (!f.asksOnly || l.parsed?.ambiguous === true) &&
      (q === '' || fold(`${l.case.phrase} ${l.case.note}`).includes(q)),
  );
}

export function families(cases: readonly CorpusCase[]): string[] {
  return [...new Set(cases.map((c) => c.family))];
}
