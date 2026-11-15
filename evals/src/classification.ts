/**
 * The built-in `classification` rubric: labels compared in code, no judge.
 *
 * A classifier's output is either the expected label or it is not, and a
 * model asked to judge that would only add cost and noise. The output is
 * compared with the labelled expected value as an exact match (one label) or
 * as a set (several labels). Anything the output says that is not in the
 * label set is kept apart as "out of set" and fails the item: a model that
 * answers "probably price" has not classified, and trimming its answer until
 * it matches would hide that.
 *
 * The summary is per class (precision and recall with their counts) plus a
 * confusion matrix when every item has exactly one expected label.
 */
import { z } from 'zod';
import type { CodeRubric, Table } from './rubric.ts';
import { RubricError } from './rubric.ts';

export const ClassificationVerdict = z.strictObject({
  expected: z.array(z.string()),
  /** Labels of the label set found in the output. */
  predicted: z.array(z.string()),
  /** What the output said that is not a label, cut to 80 characters. */
  outOfSet: z.array(z.string()),
  match: z.boolean(),
});
export type ClassificationVerdict = z.infer<typeof ClassificationVerdict>;

export type ClassificationOptions = {
  /** Every label the classifier may answer with. */
  labels: readonly string[];
  /**
   * Several labels per item, compared as a set. The output is a JSON array of
   * strings, or labels separated by commas or line breaks. Off by default: the
   * whole output must then be one label.
   */
  multi?: boolean;
  /**
   * Applied to the output's labels before the comparison. Default: trim only,
   * case kept. It changes the scoring, so it changes the version: "custom",
   * or `normalizeId` when given.
   */
  normalize?: (label: string) => string;
  /**
   * A name for `normalize`, kept in the version. Change it whenever the
   * function changes, so the gate refuses runs scored under the old one.
   */
  normalizeId?: string;
};

const OUT_OF_SET = '(out of set)';
const uniqueSorted = (items: readonly string[]) => [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function outputLabels(output: string, multi: boolean): string[] {
  if (!multi) return [output];
  const text = output.trim();
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) return parsed;
    } catch {
      // Not JSON after all: fall through and read it as a separated list.
    }
  }
  return text.split(/[,\n]/);
}

/**
 * The rubric for one label set. The label set is part of the version, so the
 * gate refuses to compare a run scored against four labels with one scored
 * against five. A custom `normalize` is part of it too.
 */
export function classification(options: ClassificationOptions): CodeRubric<ClassificationVerdict, string | string[]> {
  const labels = uniqueSorted(options.labels);
  if (labels.length < 2) throw new RubricError('classification needs at least two distinct labels');
  if (labels.includes(OUT_OF_SET)) throw new RubricError(`"${OUT_OF_SET}" is reserved for outputs outside the label set`);
  const known = new Set(labels);
  const multi = options.multi ?? false;
  const normalize = options.normalize ?? ((s: string) => s.trim());
  if (options.normalizeId !== undefined && !options.normalize) throw new RubricError('normalizeId needs normalize');
  if (options.normalizeId === '') throw new RubricError('normalizeId must not be empty');
  const normalizeTag = options.normalize ? ` normalize:${options.normalizeId ?? 'custom'}` : '';
  const label = z.string().refine((l) => known.has(l), { message: `expected label is not one of ${labels.join(', ')}` });
  const expected = multi ? z.array(label) : z.union([label, z.array(label).length(1)]);

  return {
    kind: 'code',
    name: 'classification',
    version: `1 ${multi ? 'set' : 'single'} [${labels.join(', ')}]${normalizeTag}`,
    verdict: ClassificationVerdict,
    expected,
    score(output, want) {
      const wanted = uniqueSorted(typeof want === 'string' ? [want] : want);
      const said = uniqueSorted(outputLabels(output, multi).map(normalize).filter((l) => l !== ''));
      const predicted = said.filter((l) => known.has(l));
      const outOfSet = said.filter((l) => !known.has(l)).map((l) => l.slice(0, 80));
      return { expected: wanted, predicted, outOfSet, match: outOfSet.length === 0 && predicted.join('\0') === wanted.join('\0') };
    },
    reduce: (v) => ({ pass: v.match, metrics: { out_of_set: v.outOfSet.length > 0 ? 1 : 0 } }),
    describe(v) {
      if (v.match) return '';
      const got = [...v.predicted, ...v.outOfSet.map((l) => `${JSON.stringify(l)} (not a label)`)];
      return `expected ${v.expected.join(', ') || '(no label)'}, got ${got.join(', ') || '(nothing)'}`;
    },
    tables: (verdicts) => classificationTables(classificationReport(verdicts, labels)),
  };
}

export type ClassStats = {
  label: string;
  /** Items whose expected labels include this one. */
  support: number;
  /** Items whose output includes this one. */
  predicted: number;
  /** Items where both hold. */
  correct: number;
  /** correct / predicted. Null when the label was never predicted: there is no rate to report. */
  precision: number | null;
  /** correct / support. Null when no item expected the label. */
  recall: number | null;
};

export type ClassificationReport = {
  classes: ClassStats[];
  /** Items whose output held something outside the label set. */
  outOfSet: number;
  /**
   * matrix[i][j]: items expecting labels[i] whose output was columns[j]. The
   * last column collects outputs that were not exactly one known label. Null
   * when some item has several expected labels, where a matrix has no meaning.
   */
  confusion: { labels: string[]; columns: string[]; matrix: number[][] } | null;
};

export function classificationReport(verdicts: readonly ClassificationVerdict[], labels: readonly string[]): ClassificationReport {
  const order = uniqueSorted(labels);
  const classes = order.map((label) => {
    const support = verdicts.filter((v) => v.expected.includes(label)).length;
    const predicted = verdicts.filter((v) => v.predicted.includes(label)).length;
    const correct = verdicts.filter((v) => v.expected.includes(label) && v.predicted.includes(label)).length;
    return { label, support, predicted, correct, precision: predicted ? correct / predicted : null, recall: support ? correct / support : null };
  });
  const single = verdicts.every((v) => v.expected.length === 1);
  let confusion: ClassificationReport['confusion'] = null;
  if (single) {
    const columns = [...order, OUT_OF_SET];
    const matrix = order.map(() => columns.map(() => 0));
    for (const v of verdicts) {
      const row = order.indexOf(v.expected[0]!);
      if (row < 0) throw new RubricError(`classification verdict expects "${v.expected[0]}", which is not in the label set`);
      const clean = v.outOfSet.length === 0 && v.predicted.length === 1;
      const column = clean ? order.indexOf(v.predicted[0]!) : columns.length - 1;
      matrix[row]![column]! += 1;
    }
    confusion = { labels: order, columns, matrix };
  }
  return { classes, outOfSet: verdicts.filter((v) => v.outOfSet.length > 0).length, confusion };
}

const share = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}% (${k}/${n})` : '-');

export function classificationTables(report: ClassificationReport): Table[] {
  const perClass: Table = {
    title: 'Per class',
    columns: ['class', 'expected', 'predicted', 'correct', 'precision', 'recall'],
    rows: report.classes.map((c) => [c.label, c.support, c.predicted, c.correct, share(c.correct, c.predicted), share(c.correct, c.support)]),
    note: `Precision is correct over predicted, recall is correct over expected; "-" means the denominator is zero. ${report.outOfSet} output(s) held something outside the label set.`,
  };
  if (!report.confusion) return [perClass];
  const { labels, columns, matrix } = report.confusion;
  return [
    perClass,
    {
      title: 'Confusion matrix',
      columns: ['expected \\ predicted', ...columns],
      rows: labels.map((label, i) => [label, ...matrix[i]!]),
      note: `Rows are the expected label, columns the output. "${OUT_OF_SET}" counts outputs that were not exactly one known label.`,
    },
  ];
}
