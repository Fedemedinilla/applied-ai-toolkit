import { describe, expect, it } from 'vitest';
import { extraction, extractionReport, jsonEqual, type ExtractionVerdict } from '../src/extraction.ts';
import { RubricError } from '../src/rubric.ts';
import { scoreItems, summarize } from '../src/run.ts';

const expected = { service: 'tune-up', bikes: 2, day: 'Friday', notes: null };
const out = (o: unknown) => JSON.stringify(o);
const statuses = (v: ExtractionVerdict) => Object.fromEntries(v.fields.map((f) => [f.field, f.status]));

describe('the extraction rubric', () => {
  it('is scored in code and calls each expected field correct, wrong or missing', () => {
    expect(extraction).toMatchObject({ kind: 'code', name: 'extraction', version: '1' });
    const v = extraction.score(out({ service: 'tune-up', bikes: 3, notes: null }), expected);
    expect(v.parsed).toBe(true);
    expect(statuses(v)).toEqual({ bikes: 'wrong', day: 'missing', notes: 'correct', service: 'correct' });
    expect(extraction.reduce(v)).toEqual({
      pass: false,
      metrics: { correct: 2, field_accuracy: 0.5, missing: 1, unexpected: 0, unparsed: 0, wrong: 1 },
    });
    expect(extraction.describe?.(v)).toBe('wrong: bikes; missing: day');
  });

  it('passes only when every field is correct and nothing was added', () => {
    expect(extraction.reduce(extraction.score(out(expected), expected))).toMatchObject({ pass: true, metrics: { correct: 4, field_accuracy: 1 } });
    const extra = extraction.score(out({ ...expected, phone: '11 0000-0142' }), expected);
    expect(statuses(extra)).toMatchObject({ phone: 'unexpected' });
    expect(extraction.reduce(extra)).toMatchObject({ pass: false, metrics: { correct: 4, unexpected: 1, field_accuracy: 1 } });
    expect(extraction.describe?.(extra)).toBe('unexpected: phone');
  });

  it('compares exactly: types, case, null and nested values', () => {
    const one = (value: unknown, want: unknown) => extraction.score(out({ f: value }), { f: want as null }).fields[0]!.status;
    expect(one('18000', 18000)).toBe('wrong');
    expect(one('friday', 'Friday')).toBe('wrong');
    expect(one(' Friday', 'Friday')).toBe('wrong');
    expect(one(null, null)).toBe('correct');
    expect(one(0, null)).toBe('wrong');
    expect(one('', null)).toBe('wrong');
    expect(extraction.score('{}', { f: null }).fields[0]!.status).toBe('missing');
    expect(one({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe('correct');
    expect(one({ a: 1, b: [2, 1] }, { b: [1, 2], a: 1 })).toBe('wrong');
    expect(one([1], { 0: 1 })).toBe('wrong');
    expect(jsonEqual(1.0, 1)).toBe(true);
  });

  it('treats an inherited property name as a field like any other', () => {
    const v = extraction.score('{"__proto__": 1, "constructor": 2}', { toString: 'x' });
    expect(v.fields.map((f) => `${f.field}=${f.status}`)).toEqual(['toString=missing', '__proto__=unexpected', 'constructor=unexpected']);
  });

  it('counts every field as missing when the output is not a JSON object, and says so', () => {
    for (const bad of ['Sure! Here it is: {"service": "tune-up"}', '```json\n{"service":"tune-up"}\n```', '["tune-up"]', '"tune-up"', 'null', '']) {
      const v = extraction.score(bad, expected);
      expect(v.parsed).toBe(false);
      expect(new Set(Object.values(statuses(v)))).toEqual(new Set(['missing']));
      expect(extraction.reduce(v)).toMatchObject({ pass: false, metrics: { missing: 4, wrong: 0, unparsed: 1 } });
    }
    expect(extraction.describe?.(extraction.score('nope', { a: 1 }))).toBe('output is not a JSON object; missing: a');
  });

  it('refuses a verdict that does not account for every expected field exactly once', () => {
    const check = (fields: ExtractionVerdict['fields']) => extraction.complete!({ parsed: true, fields }, { a: 1, b: 2 });
    expect(() => check([{ field: 'a', status: 'correct' }, { field: 'b', status: 'wrong' }])).not.toThrow();
    expect(() => check([{ field: 'a', status: 'correct' }])).toThrow('extraction verdict covers fields [a], expected [a, b] once each');
    expect(() => check([{ field: 'a', status: 'correct' }, { field: 'a', status: 'correct' }, { field: 'b', status: 'correct' }])).toThrow(RubricError);
    expect(() => check([{ field: 'a', status: 'correct' }, { field: 'b', status: 'correct' }, { field: 'c', status: 'correct' }])).toThrow(RubricError);
    expect(() => check([{ field: 'a', status: 'correct' }, { field: 'b', status: 'unexpected' }])).toThrow(RubricError);
    expect(() => check([{ field: 'a', status: 'correct' }, { field: 'b', status: 'correct' }, { field: 'x', status: 'unexpected' }, { field: 'x', status: 'unexpected' }])).toThrow(/unexpected field twice/);
  });
});

describe('per-field accuracy', () => {
  const items = [
    { case: 'booking-1', output: out({ service: 'tune-up', bikes: 2, day: 'Friday' }), expected: { service: 'tune-up', bikes: 2, day: 'Friday' } },
    { case: 'booking-2', output: out({ service: 'full service', bikes: 2 }), expected: { service: 'full service', bikes: 1, day: 'Tuesday' } },
    { case: 'booking-3', output: out({ service: 'brakes', bikes: 1, day: 'Monday', urgent: true }), expected: { service: 'flat tyre', bikes: 1, day: 'Saturday' } },
    { case: 'booking-4', output: 'I could not find a booking in this message.', expected: { service: 'tune-up', bikes: 1 } },
  ];
  const run = scoreItems(extraction, 'candidate', items);
  const verdicts = items.map((it) => extraction.score(it.output, it.expected));

  it('counts wrong and missing apart, field by field', () => {
    const report = extractionReport(verdicts);
    expect(report.fields.map(({ ci: _ci, ...rest }) => rest)).toEqual([
      { field: 'bikes', expected: 4, correct: 2, wrong: 1, missing: 1, accuracy: 0.5 },
      { field: 'day', expected: 3, correct: 1, wrong: 1, missing: 1, accuracy: 1 / 3 },
      { field: 'service', expected: 4, correct: 2, wrong: 1, missing: 1, accuracy: 0.5 },
    ]);
    expect(report.unexpected).toEqual([{ field: 'urgent', count: 1 }]);
    expect(report.unparsed).toBe(1);
    const day = report.fields[1]!;
    expect(day.ci[0]).toBeCloseTo(0.0615, 3);
    expect(day.ci[1]).toBeCloseTo(0.7923, 3);
    // Every expected field of every item is in exactly one of the three counts.
    for (const f of report.fields) expect(f.correct + f.wrong + f.missing).toBe(f.expected);
  });

  it('writes a stored run with the tables and the per-item reason', () => {
    expect(summarize(run)).toMatchObject({ scored: 4, passes: 1, metrics: { wrong: 3 / 4, missing: 3 / 4, unexpected: 1 / 4, unparsed: 1 / 4 } });
    expect(run.results.map((r) => r.detail)).toEqual([
      undefined,
      'wrong: bikes; missing: day',
      'wrong: day, service; unexpected: urgent',
      'output is not a JSON object; missing: bikes, service',
    ]);
    const [perField, extra] = run.tables;
    expect(perField!.columns).toEqual(['field', 'expected', 'correct', 'wrong', 'missing', 'accuracy', '95% CI']);
    expect(perField!.rows[1]).toEqual(['day', 3, 1, 1, 1, '33%', '6% to 79%']);
    expect(perField!.note).toContain('1 output(s) were not a JSON object');
    expect(extra).toMatchObject({ title: 'Unexpected fields', rows: [['urgent', 1]] });
  });

  it('refuses an expected value that is not a JSON object', () => {
    expect(() => scoreItems(extraction, 'x', [{ case: 'a', output: '{}', expected: ['service'] }])).toThrow(/item 1 \(case a\): expected: /);
    expect(() => scoreItems(extraction, 'x', [{ case: 'a', output: '{}', expected: 'tune-up' }])).toThrow(/expected: /);
  });
});
