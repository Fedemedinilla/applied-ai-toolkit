import { describe, expect, it } from 'vitest';
import { classification, classificationReport } from '../src/classification.ts';
import { parseRun, RUN_FORMAT, scoreItems, summarize } from '../src/run.ts';

const LABELS = ['price', 'hours', 'repair', 'other'];
const rubric = classification({ labels: LABELS });

/** [expected, output] pairs: 3 price (2 right), 2 hours (2 right), 2 repair (1 right), 1 other (wrong, not a label). */
const PAIRS: [string, string][] = [
  ['price', 'price'],
  ['price', ' price\n'],
  ['price', 'repair'],
  ['hours', 'hours'],
  ['hours', 'hours'],
  ['repair', 'repair'],
  ['repair', 'price'],
  ['other', 'I think this is about prices'],
];
const items = PAIRS.map(([expected, output], i) => ({ case: `ticket-${i + 1}`, input: `message ${i + 1}`, output, expected }));

describe('the classification rubric', () => {
  it('is scored in code: it has no instructions, no call settings and no prompt', () => {
    expect(rubric.kind).toBe('code');
    expect(rubric.name).toBe('classification');
    for (const judgeOnly of ['instructions', 'call', 'prompt']) expect(rubric).not.toHaveProperty(judgeOnly);
  });

  it('matches one label exactly, after trimming and nothing else', () => {
    expect(rubric.score('price', 'price')).toEqual({ expected: ['price'], predicted: ['price'], outOfSet: [], match: true });
    expect(rubric.score('  price\n', 'price').match).toBe(true);
    expect(rubric.score('Price', 'price')).toMatchObject({ predicted: [], outOfSet: ['Price'], match: false });
    expect(rubric.score('price.', 'price').match).toBe(false);
    expect(rubric.score('price, hours', 'price')).toMatchObject({ predicted: [], outOfSet: ['price, hours'], match: false });
    expect(rubric.score('', 'price')).toEqual({ expected: ['price'], predicted: [], outOfSet: [], match: false });
    expect(rubric.reduce(rubric.score('hours', 'price'))).toEqual({ pass: false, metrics: { out_of_set: 0 } });
    expect(rubric.reduce(rubric.score('no idea', 'price'))).toEqual({ pass: false, metrics: { out_of_set: 1 } });
  });

  it('says what was expected and what came back', () => {
    expect(rubric.describe?.(rubric.score('price', 'price'))).toBe('');
    expect(rubric.describe?.(rubric.score('hours', 'price'))).toBe('expected price, got hours');
    expect(rubric.describe?.(rubric.score('maybe', 'price'))).toBe('expected price, got "maybe" (not a label)');
    expect(rubric.describe?.(rubric.score(' ', 'price'))).toBe('expected price, got (nothing)');
  });

  it('can normalize the output on request', () => {
    const loose = classification({ labels: LABELS, normalize: (s) => s.trim().toLowerCase().replace(/\.$/, '') });
    expect(loose.score('Price.', 'price').match).toBe(true);
  });

  it('compares several labels as a set, in any order and format', () => {
    const multi = classification({ labels: LABELS, multi: true });
    expect(multi.score('repair, price', ['price', 'repair']).match).toBe(true);
    expect(multi.score('["repair","price"]', ['price', 'repair']).match).toBe(true);
    expect(multi.score('price\nrepair\nprice', ['price', 'repair']).match).toBe(true);
    expect(multi.score('price', ['price', 'repair'])).toMatchObject({ predicted: ['price'], match: false });
    expect(multi.score('price, repair, hours', ['price', 'repair']).match).toBe(false);
    expect(multi.score('price, refund', ['price'])).toMatchObject({ predicted: ['price'], outOfSet: ['refund'], match: false });
    expect(multi.score('', []).match).toBe(true);
    expect(multi.score('[broken', ['price'])).toMatchObject({ outOfSet: ['[broken'], match: false });
  });

  it('puts the label set and the mode in the version, so different label sets are different rubrics', () => {
    expect(rubric.version).toBe('1 single [hours, other, price, repair]');
    expect(classification({ labels: [...LABELS].reverse() }).version).toBe(rubric.version);
    expect(classification({ labels: [...LABELS, 'refund'] }).version).not.toBe(rubric.version);
    expect(classification({ labels: LABELS, multi: true }).version).toBe('1 set [hours, other, price, repair]');
  });

  it('refuses a label set of one, and a reserved label', () => {
    expect(() => classification({ labels: ['only', 'only'] })).toThrow(/at least two/);
    expect(() => classification({ labels: ['a', '(out of set)'] })).toThrow(/reserved/);
  });
});

describe('precision, recall and the confusion matrix', () => {
  const verdicts = PAIRS.map(([expected, output]) => rubric.score(output, expected));
  const report = classificationReport(verdicts, LABELS);

  it('counts per class, with null where a rate has no denominator', () => {
    expect(report.classes).toEqual([
      { label: 'hours', support: 2, predicted: 2, correct: 2, precision: 1, recall: 1 },
      { label: 'other', support: 1, predicted: 0, correct: 0, precision: null, recall: 0 },
      { label: 'price', support: 3, predicted: 3, correct: 2, precision: 2 / 3, recall: 2 / 3 },
      { label: 'repair', support: 2, predicted: 2, correct: 1, precision: 1 / 2, recall: 1 / 2 },
    ]);
    expect(report.outOfSet).toBe(1);
    const never = classificationReport([rubric.score('hours', 'hours')], LABELS).classes.find((c) => c.label === 'price');
    expect(never).toMatchObject({ support: 0, precision: null, recall: null });
  });

  it('builds the matrix with rows expected and columns predicted, and a column for outputs that are not a label', () => {
    expect(report.confusion).toEqual({
      labels: ['hours', 'other', 'price', 'repair'],
      columns: ['hours', 'other', 'price', 'repair', '(out of set)'],
      matrix: [
        [2, 0, 0, 0, 0],
        [0, 0, 0, 0, 1],
        [0, 0, 2, 1, 0],
        [0, 0, 1, 1, 0],
      ],
    });
    // Every item lands in exactly one cell, and the diagonal is the pass count.
    const cells = report.confusion!.matrix.flat();
    expect(cells.reduce((a, b) => a + b, 0)).toBe(PAIRS.length);
    expect(report.confusion!.matrix.map((row, i) => row[i]!).reduce((a, b) => a + b, 0)).toBe(verdicts.filter((v) => v.match).length);
  });

  it('gives no matrix when items have several expected labels', () => {
    const multi = classification({ labels: LABELS, multi: true });
    const r = classificationReport([multi.score('price, repair', ['price', 'repair']), multi.score('price', ['price', 'hours'])], LABELS);
    expect(r.confusion).toBeNull();
    expect(r.classes.find((c) => c.label === 'price')).toMatchObject({ support: 2, predicted: 2, correct: 2 });
    expect(r.classes.find((c) => c.label === 'hours')).toMatchObject({ support: 1, predicted: 0, correct: 0, recall: 0 });
    expect(multi.tables?.([multi.score('price', ['price', 'hours'])])).toHaveLength(1);
  });

  it('renders both tables into the run', () => {
    const [perClass, matrix] = rubric.tables!(verdicts);
    expect(perClass!.rows[2]).toEqual(['price', 3, 3, 2, '67% (2/3)', '67% (2/3)']);
    expect(perClass!.rows[1]).toEqual(['other', 1, 0, 0, '-', '0% (0/1)']);
    expect(matrix!.columns).toEqual(['expected \\ predicted', 'hours', 'other', 'price', 'repair', '(out of set)']);
    expect(matrix!.rows[1]).toEqual(['other', 0, 0, 0, 0, 1]);
  });
});

describe('scoreItems', () => {
  it('turns outputs and labels into a stored run, without a model', () => {
    const run = scoreItems(rubric, 'baseline', items);
    expect(run).toMatchObject({ format: RUN_FORMAT, rubric: { name: 'classification', version: rubric.version }, label: 'baseline' });
    expect(summarize(run)).toMatchObject({ total: 8, scored: 8, passes: 5, failed: 0, noOutput: 0, metrics: { out_of_set: 1 / 8 } });
    expect(run.results[0]).toEqual({ case: 'ticket-1', sample: 1, status: 'scored', pass: true, metrics: { out_of_set: 0 }, input: 'message 1', output: 'price' });
    expect(run.results[2]).toMatchObject({ pass: false, detail: 'expected price, got repair' });
    expect(run.tables.map((t) => t.title)).toEqual(['Per class', 'Confusion matrix']);
    expect(parseRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it('numbers repeated cases as samples, sorts the results and gives the same run for the same items in any order', () => {
    const twice = [...items, ...items];
    const run = scoreItems(rubric, 'x', twice);
    expect(run.results.slice(0, 3).map((r) => `${r.case}#${r.sample}`)).toEqual(['ticket-1#1', 'ticket-1#2', 'ticket-2#1']);
    const numbered = twice.map((it, i) => ({ ...it, sample: i < items.length ? 1 : 2 }));
    expect(scoreItems(rubric, 'x', [...numbered].reverse())).toEqual(scoreItems(rubric, 'x', numbered));
    expect(() => scoreItems(rubric, 'x', [{ ...items[0], sample: 1 }, { ...items[0], sample: 1 }])).toThrow(/item 2 \(case ticket-1\): sample 1 appears twice/);
  });

  it('keeps a failed call in the run instead of dropping it', () => {
    const run = scoreItems(rubric, 'x', [items[0], { case: 'ticket-2', expected: 'price', error: '529 overloaded' }]);
    expect(run.results[1]).toEqual({ case: 'ticket-2', sample: 1, status: 'failed', pass: null, metrics: {}, detail: '529 overloaded' });
    expect(summarize(run)).toMatchObject({ total: 2, scored: 1, failed: 1 });
  });

  it('refuses an item with no output, an unknown expected label, an unknown field and a bad run file', () => {
    expect(() => scoreItems(rubric, 'x', [{ case: 'a', expected: 'price' }])).toThrow(/item 1 \(case a\): needs "output"/);
    expect(() => scoreItems(rubric, 'x', [{ case: 'a', output: 'price', expected: 'refund' }])).toThrow(/item 1 \(case a\): expected: /);
    expect(() => scoreItems(rubric, 'x', [{ case: 'a', output: 'price' }])).toThrow(/expected: /);
    expect(() => scoreItems(rubric, 'x', [{ case: 'a', output: 'price', expected: 'price', variant: 'V1' }])).toThrow(/item 1: /);
    expect(() => parseRun({ format: 'evals-run/0' }, 'old.json')).toThrow(/old.json is not a stored run \(evals-run\/1\): format/);
    const run = scoreItems(rubric, 'x', items);
    expect(() => parseRun({ ...run, results: [{ ...run.results[0], pass: null }] })).toThrow(/pass must be set exactly when status is "scored"/);
  });
});
