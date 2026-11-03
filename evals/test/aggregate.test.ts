import { describe, expect, it } from 'vitest';
import { createWriterTarget, todayLine } from '../example/business.ts';
import { PROBES } from '../example/cases.ts';
import { fakeJudge, fakeWriter, recordingClient, reply } from '../example/fake-models.ts';
import { VARIANTS } from '../example/variants.ts';
import { aggregate, toMarkdown, wilson } from '../src/aggregate.ts';
import { blind, type BlindKey, type BlindPiece, type KeyEntry } from '../src/blind.ts';
import { judgePiece, type JudgedPiece } from '../src/judge.ts';
import { planJobs, runEval } from '../src/runner.ts';

const verdict = (id: string, invented: boolean, quality: number, judge = 1): JudgedPiece => ({
  id,
  judge,
  lines: [{ line: 1, support: invented ? 'invented' : 'no-claim', note: '' }],
  voice: 'on',
  robotic: false,
  quality,
  note: '',
});

const piece = (id: string, lang: string): BlindPiece => ({ id, case: 'c', lang, now: '2026-03-04T12:00:00.000Z', brief: 'b', text: 't' });
const entry = (variant: string, lang: string, sample: number, extra: Partial<KeyEntry> = {}): KeyEntry => ({
  variant,
  lang,
  case: 'c',
  sample,
  stop: 'end_turn',
  ...extra,
});

describe('wilson', () => {
  it('matches known values', () => {
    const [lo, hi] = wilson(0, 14);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.2153, 3);
    const [lo2, hi2] = wilson(5, 10);
    expect(lo2).toBeCloseTo(0.2366, 3);
    expect(hi2).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('zero of fourteen still allows a rate above 20%', () => {
    expect(wilson(0, 14)[1]).toBeGreaterThan(0.2);
    // The case study's figure: with a true rate of 25%, zero in fourteen
    // still comes up about once in fifty runs.
    expect(0.75 ** 14).toBeGreaterThan(1 / 60);
    expect(0.75 ** 14).toBeLessThan(1 / 50);
  });
});

describe('aggregate', () => {
  const pieces = [piece('a', 'en'), piece('b', 'en'), piece('c', 'es'), piece('d', 'en'), piece('e', 'en'), piece('f', 'es')];
  const key: BlindKey = {
    a: entry('V0', 'en', 1),
    b: entry('V0', 'en', 2, { stop: 'max_tokens' }),
    c: entry('V0', 'es', 1),
    d: entry('V4', 'en', 1),
    e: entry('V4', 'en', 2),
    f: entry('V4', 'es', 1),
  };
  const verdicts = [verdict('a', true, 2), verdict('b', false, 4), verdict('c', true, 1), verdict('d', false, 5), verdict('e', false, 5), verdict('f', false, 4)];

  it('groups by variant and language, with an "all" row per variant', () => {
    const rows = aggregate(pieces, key, verdicts);
    expect(rows.map((r) => `${r.variant}/${r.lang}`)).toEqual(['V0/en', 'V0/es', 'V0/all', 'V4/en', 'V4/es', 'V4/all']);
    const v0all = rows.find((r) => r.variant === 'V0' && r.lang === 'all')!;
    expect(v0all).toMatchObject({ pieces: 3, invented: 2, cut: 1, noPiece: 0, failed: 0 });
    expect(v0all.meanQuality).toBeCloseTo(7 / 3);
  });

  it('uses the majority of several judges and counts split calls', () => {
    const rows = aggregate([piece('a', 'en')], { a: key.a! }, [verdict('a', true, 2, 1), verdict('a', false, 4, 2), verdict('a', true, 2, 3)]);
    expect(rows[0]).toMatchObject({ invented: 1, split: 1, meanQuality: 2 });
  });

  it('refuses a verdict for an unknown piece and a piece with no verdict', () => {
    expect(() => aggregate(pieces, key, [...verdicts, verdict('zzz', true, 1)])).toThrow(/unknown piece/);
    expect(() => aggregate(pieces, key, verdicts.slice(0, 3))).toThrow(/3 piece\(s\) have no verdict/);
  });

  it('refuses a piece that lost one of its judges, and a judge counted twice', () => {
    const three = (id: string) => [1, 2, 3].map((j) => verdict(id, false, 4, j));
    const two = [piece('a', 'en'), piece('d', 'en')];
    const twoKey = { a: key.a!, d: key.d! };
    expect(() => aggregate(two, twoKey, [...three('a'), ...three('d').slice(0, 2)])).toThrow(/1 piece\(s\) do not have 3 judge/);
    expect(() => aggregate(two, twoKey, [...three('a'), ...three('d')], { judges: 4 })).toThrow(/do not have 4 judge/);
    expect(() => aggregate(two, twoKey, [...three('a'), ...three('d'), verdict('d', true, 1, 3)])).toThrow(/two verdicts from judge 3/);
  });

  it('checks stored verdicts again: shape and line coverage', () => {
    expect(() => aggregate([piece('a', 'en')], { a: key.a! }, [{ ...verdict('a', false, 4), quality: 9 }])).toThrow(/wrong shape/);
    expect(() => aggregate([piece('a', 'en')], { a: key.a! }, [{ ...verdict('a', false, 4), variant: 'V0' }])).toThrow(/wrong shape/);
    const twoLines = { ...verdict('a', false, 4), lines: [1, 2].map((line) => ({ line, support: 'no-claim', note: '' })) };
    expect(() => aggregate([piece('a', 'en')], { a: key.a! }, [twoLines])).toThrow(/expected 1..1/);
  });

  it('counts refusals and empty replies apart, outside the invention denominator', () => {
    const k: BlindKey = {
      ...key,
      r1: entry('V4', 'en', 3, { stop: 'refusal', withheld: 'refusal' }),
      r2: entry('V4', 'en', 4, { withheld: 'empty' }),
      p1: entry('V0', 'en', 3),
      p2: entry('V0', 'en', 4),
    };
    const rows = aggregate([...pieces, piece('p1', 'en'), piece('p2', 'en')], k, [...verdicts, verdict('p1', false, 4), verdict('p2', false, 4)]);
    const v4en = rows.find((r) => r.variant === 'V4' && r.lang === 'en')!;
    // Two judged, nothing invented; the two pieces with no text are not "clean" pieces.
    expect(v4en).toMatchObject({ pieces: 2, invented: 0, noPiece: 2 });
    expect(v4en.inventedCi[1]).toBeGreaterThan(0.6);
  });

  it('stops on a failed call or uneven variant totals unless allowMissing', () => {
    const failed: BlindKey = { ...key, x: entry('V4', 'en', 3, { stop: null, withheld: 'failed' }), y: entry('V0', 'en', 3, { stop: null, withheld: 'failed' }) };
    expect(() => aggregate(pieces, failed, verdicts)).toThrow(/2 call\(s\) failed/);
    const rows = aggregate(pieces, failed, verdicts, { allowMissing: true });
    expect(rows.find((r) => r.variant === 'V4' && r.lang === 'all')).toMatchObject({ pieces: 3, failed: 1 });

    const cut = { a: key.a!, b: key.b!, c: key.c!, d: key.d! };
    expect(() => aggregate(pieces.slice(0, 4), cut, verdicts.slice(0, 4))).toThrow(/different row counts \(V0 3, V4 1\)/);
  });

  it('refuses a key entry whose piece is missing from the pieces file', () => {
    expect(() => aggregate(pieces.slice(1), key, verdicts.slice(1))).toThrow(/1 key entr\(ies\) have no piece: a/);
  });

  it('renders a Markdown table with the interval, the missing columns and the legend', () => {
    const rows = aggregate([piece('d', 'en')], { d: key.d!, z: entry('V4', 'en', 2, { withheld: 'refusal' }) }, [verdict('d', false, 5)]);
    const md = toMarkdown(rows, { V4: 'the fix' });
    expect(md).toContain('| V4 | en | 1 | 0 (0%) | 0% to 79% | 0 | 0 | 5.0 | 0 | 0 | 1 | 0 |');
    expect(md).toContain('- V4: the fix');
    const none = aggregate([], { z: entry('V4', 'en', 1, { withheld: 'refusal' }) }, []);
    expect(toMarkdown(none)).toContain('| V4 | en | 0 | - | - | 0 | 0 | - | 0 | 0 | 1 | 0 |');
  });
});

describe('the whole pipeline with fake models', () => {
  const target = createWriterTarget();
  const now = new Date('2026-03-04T12:00:00Z');

  it('a fake invention added only without the procedure rule lands on the right variants after blinding', async () => {
    const jobs = planJobs(PROBES, VARIANTS.map((v) => v.id), ['en', 'es'], 1);
    const { rows } = await runEval({ client: fakeWriter(), target, variants: VARIANTS, jobs, now });
    const { pieces, key } = blind(rows, 3);
    const judge = fakeJudge();
    const verdicts: JudgedPiece[] = [];
    for (const p of pieces) verdicts.push(await judgePiece(judge, p, target.factSheet(PROBES.find((c) => c.id === p.case)!, p.lang as 'en', new Date(p.now))));
    const table = aggregate(pieces, key, verdicts).filter((r) => r.lang === 'all');
    expect(Object.fromEntries(table.map((r) => [r.variant, r.invented]))).toEqual({ V0: 10, V1: 10, V2: 0, V3: 0, V4: 0 });
    for (const req of judge.requests) {
      const body = req.messages[0]!.content;
      expect(body).not.toMatch(/\bV[0-4]\b/);
      expect(body).not.toMatch(/"?(variant|sample|stop|usage|output_tokens)"?\s*:/);
    }
  });

  it('the judge sees the same TODAY line the writer was given', async () => {
    const writer = fakeWriter();
    const jobs = planJobs(PROBES.slice(-1), ['V0'], ['en', 'es'], 1);
    const { rows } = await runEval({ client: writer, target, variants: VARIANTS, jobs, now });
    const { pieces } = blind(rows, 1);
    const judge = fakeJudge();
    for (const p of pieces) await judgePiece(judge, p, target.factSheet(PROBES.at(-1)!, p.lang as 'en' | 'es', new Date(p.now)));
    for (const lang of ['en', 'es'] as const) {
      const line = todayLine(now, lang);
      expect(writer.requests.some((r) => r.system.at(-1)!.text === line)).toBe(true);
      expect(judge.requests.some((r) => r.messages[0]!.content.includes(line))).toBe(true);
    }
  });

  it('a refused generation is counted as "no piece", not judged as a clean zero-line piece', async () => {
    let n = 0;
    const writer = recordingClient(() => (++n === 1 ? reply('', 'refusal') : reply('Open Tuesday to Saturday.')));
    const jobs = planJobs(PROBES.slice(0, 2), ['V0'], ['en'], 1);
    const { rows } = await runEval({ client: writer, target, variants: VARIANTS, jobs, now, concurrency: 1 });
    const { pieces, key } = blind(rows, 2);
    expect(pieces).toHaveLength(1);
    const judge = fakeJudge();
    const verdicts = [await judgePiece(judge, pieces[0]!, 'sheet')];
    expect(aggregate(pieces, key, verdicts).find((r) => r.lang === 'all')).toMatchObject({ pieces: 1, noPiece: 1 });
  });
});
