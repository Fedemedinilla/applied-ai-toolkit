/**
 * The built-in `extraction` rubric: structured output compared field by
 * field with the expected JSON, in code.
 *
 * Each top-level field of the expected object gets one of three calls, and a
 * field the output adds gets a fourth:
 *
 * - "correct": present and deeply equal to the expected value.
 * - "wrong": present with another value. The model answered, and the answer
 *   is false.
 * - "missing": absent. The model did not answer.
 * - "unexpected": in the output and not in the expected object.
 *
 * Wrong and missing are counted apart because they are different failures
 * with different fixes. A missing field is a gap a form can show as empty; a
 * wrong field is a value somebody will act on.
 *
 * The comparison is exact: 18000 is not "18000", "Friday" is not "friday",
 * and an expected null is matched only by a present null. An output that is
 * not a JSON object extracts nothing, so all its fields count as missing, and
 * the run reports how many outputs that was.
 */
import { z } from 'zod';
import { wilson } from './aggregate.ts';
import type { CodeRubric, Table } from './rubric.ts';
import { RubricError } from './rubric.ts';

export const FieldStatus = z.enum(['correct', 'wrong', 'missing', 'unexpected']);
export type FieldStatus = z.infer<typeof FieldStatus>;

export const ExtractionVerdict = z.strictObject({
  /** False when the output was not a JSON object. */
  parsed: z.boolean(),
  fields: z.array(z.strictObject({ field: z.string(), status: FieldStatus })),
});
export type ExtractionVerdict = z.infer<typeof ExtractionVerdict>;

type Json = z.infer<ReturnType<typeof z.json>>;
export type ExpectedRecord = Record<string, Json>;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Deep equality of two JSON values. Object keys in any order; arrays in order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ka = Object.keys(a).sort(byCodeUnit);
  const kb = Object.keys(b).sort(byCodeUnit);
  return (
    ka.length === kb.length &&
    ka.every((k, i) => k === kb[i] && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

function parseObject(output: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(output);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const count = (v: ExtractionVerdict, status: FieldStatus) => v.fields.filter((f) => f.status === status).length;

export const extraction: CodeRubric<ExtractionVerdict, ExpectedRecord> = {
  kind: 'code',
  name: 'extraction',
  version: '1',
  verdict: ExtractionVerdict,
  expected: z.record(z.string(), z.json()),
  score(output, expected) {
    const got = parseObject(output);
    const wanted = Object.keys(expected).sort(byCodeUnit);
    const fields = wanted.map((field) => {
      const status: FieldStatus = !got || !Object.hasOwn(got, field) ? 'missing' : jsonEqual(got[field], expected[field]) ? 'correct' : 'wrong';
      return { field, status };
    });
    const extra = Object.keys(got ?? {})
      .filter((field) => !Object.hasOwn(expected, field))
      .sort(byCodeUnit)
      .map((field) => ({ field, status: 'unexpected' as const }));
    return { parsed: got !== null, fields: [...fields, ...extra] };
  },
  /** Every expected field exactly once, and nothing else passed off as expected. */
  complete(verdict, expected) {
    const covered = verdict.fields.filter((f) => f.status !== 'unexpected').map((f) => f.field).sort(byCodeUnit);
    const wanted = Object.keys(expected).sort(byCodeUnit);
    if (covered.join('\0') !== wanted.join('\0')) {
      throw new RubricError(`extraction verdict covers fields [${covered.join(', ')}], expected [${wanted.join(', ')}] once each`);
    }
    const extra = verdict.fields.filter((f) => f.status === 'unexpected').map((f) => f.field);
    if (new Set(extra).size !== extra.length || extra.some((f) => Object.hasOwn(expected, f))) {
      throw new RubricError(`extraction verdict lists an unexpected field twice, or one that is expected: [${extra.join(', ')}]`);
    }
  },
  reduce(v) {
    const correct = count(v, 'correct');
    const wrong = count(v, 'wrong');
    const missing = count(v, 'missing');
    const unexpected = count(v, 'unexpected');
    const expected = correct + wrong + missing;
    return {
      pass: v.parsed && wrong === 0 && missing === 0 && unexpected === 0,
      metrics: { correct, field_accuracy: expected ? correct / expected : 1, missing, unexpected, unparsed: v.parsed ? 0 : 1, wrong },
    };
  },
  describe(v) {
    const parts = (['wrong', 'missing', 'unexpected'] as const)
      .map((status) => ({ status, fields: v.fields.filter((f) => f.status === status).map((f) => f.field) }))
      .filter((p) => p.fields.length > 0)
      .map((p) => `${p.status}: ${p.fields.join(', ')}`);
    return [...(v.parsed ? [] : ['output is not a JSON object']), ...parts].join('; ');
  },
  tables: (verdicts) => extractionTables(extractionReport(verdicts)),
};

export type FieldStats = {
  field: string;
  /** Items whose expected object has this field. */
  expected: number;
  correct: number;
  wrong: number;
  missing: number;
  /** correct / expected. */
  accuracy: number;
  /** 95% Wilson interval of the accuracy. */
  ci: [number, number];
};

export type ExtractionReport = {
  fields: FieldStats[];
  /** Fields the outputs added, with how many outputs added each. */
  unexpected: { field: string; count: number }[];
  /** Outputs that were not a JSON object. */
  unparsed: number;
};

export function extractionReport(verdicts: readonly ExtractionVerdict[]): ExtractionReport {
  const stats = new Map<string, { correct: number; wrong: number; missing: number }>();
  const extra = new Map<string, number>();
  for (const v of verdicts) {
    for (const f of v.fields) {
      if (f.status === 'unexpected') {
        extra.set(f.field, (extra.get(f.field) ?? 0) + 1);
        continue;
      }
      const s = stats.get(f.field) ?? { correct: 0, wrong: 0, missing: 0 };
      s[f.status] += 1;
      stats.set(f.field, s);
    }
  }
  return {
    fields: [...stats]
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([field, s]) => {
        const expected = s.correct + s.wrong + s.missing;
        return { field, expected, ...s, accuracy: s.correct / expected, ci: wilson(s.correct, expected) };
      }),
    unexpected: [...extra].sort(([a], [b]) => byCodeUnit(a, b)).map(([field, n]) => ({ field, count: n })),
    unparsed: verdicts.filter((v) => !v.parsed).length,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function extractionTables(report: ExtractionReport): Table[] {
  const perField: Table = {
    title: 'Per field',
    columns: ['field', 'expected', 'correct', 'wrong', 'missing', 'accuracy', '95% CI'],
    rows: report.fields.map((f) => [f.field, f.expected, f.correct, f.wrong, f.missing, pct(f.accuracy), `${pct(f.ci[0])} to ${pct(f.ci[1])}`]),
    note: `Wrong is a present field with another value; missing is an absent field. ${report.unparsed} output(s) were not a JSON object, and their fields count as missing.`,
  };
  if (report.unexpected.length === 0) return [perField];
  return [
    perField,
    {
      title: 'Unexpected fields',
      columns: ['field', 'outputs'],
      rows: report.unexpected.map((u) => [u.field, u.count]),
      note: 'Fields the outputs added that no expected object has. An item with one fails.',
    },
  ];
}
