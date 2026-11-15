import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWriterTarget } from '../example/business.ts';
import { PROBES } from '../example/cases.ts';
import { FAKE_INVENTION, fakeJudge, fakeWriter, recordingClient, reply } from '../example/fake-models.ts';
import { plainLanguage } from '../example/plain-language-rubric.ts';
import { VARIANTS } from '../example/variants.ts';
import { aggregate } from '../src/aggregate.ts';
import { blind, type BlindKey, type BlindPiece } from '../src/blind.ts';
import { groundedness, judgePiece, JudgeError, type JudgedPiece } from '../src/judge.ts';
import { judgeWith, rubricRequest, RubricError, type JudgeRubric } from '../src/rubric.ts';
import { judgedRuns, summarize } from '../src/run.ts';
import { planJobs, runEval } from '../src/runner.ts';

const target = createWriterTarget();
const now = new Date('2026-03-04T12:00:00Z');

async function fakeRun(samples = 1) {
  const jobs = planJobs(PROBES, VARIANTS.map((v) => v.id), ['en', 'es'], samples);
  const { rows } = await runEval({ client: fakeWriter(), target, variants: VARIANTS, jobs, now });
  return blind(rows, 5);
}

/** Flags the fake invention's sentence as jargon and nothing else. */
const fakeJargonJudge = () =>
  recordingClient((req) => {
    const numbered = (req.messages[0]?.content ?? '')
      .split('\n')
      .map((l) => /^(\d+)\. (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);
    return reply(JSON.stringify({ sentences: numbered.map((m) => ({ sentence: Number(m[1]), jargon: m[2] === FAKE_INVENTION ? ['ready'] : [] })), note: '' }));
  });

describe('the groundedness rubric', () => {
  const verdict = (supports: string[], quality = 4) =>
    groundedness.verdict.parse({ lines: supports.map((support, i) => ({ line: i + 1, support, note: support === 'invented' ? 'not loaded' : '' })), voice: 'off', robotic: true, quality, note: '' });

  it('has a name and a version, and passes a piece exactly when no line is invented', () => {
    expect(groundedness).toMatchObject({ kind: 'judge', name: 'groundedness', version: '1' });
    expect(groundedness.reduce(verdict(['fact-sheet', 'brief', 'arithmetic', 'no-claim']))).toEqual({
      pass: true,
      metrics: { invented_lines: 0, off_voice: 1, quality: 4, robotic: 1 },
    });
    expect(groundedness.reduce(verdict(['fact-sheet', 'invented', 'invented'], 2))).toMatchObject({ pass: false, metrics: { invented_lines: 2, quality: 2 } });
    expect(groundedness.describe?.(verdict(['fact-sheet', 'invented']))).toBe('line 2 invented: not loaded');
  });

  it('counts the same pieces as the results table, variant by variant', async () => {
    const { pieces, key } = await fakeRun(2);
    const judge = fakeJudge();
    const verdicts: JudgedPiece[] = [];
    for (const p of pieces) verdicts.push(await judgePiece(judge, p, target.factSheet(PROBES.find((c) => c.id === p.case)!, p.lang as 'en', new Date(p.now))));
    const table = aggregate(pieces, key, verdicts).filter((r) => r.lang === 'all');
    const runs = judgedRuns(groundedness, pieces, key, verdicts);
    expect(runs.map((r) => r.label)).toEqual(['V0', 'V1', 'V2', 'V3', 'V4']);
    for (const run of runs) {
      const row = table.find((r) => r.variant === run.label)!;
      const s = summarize(run);
      expect(run.rubric).toEqual({ name: 'groundedness', version: '1' });
      expect({ scored: s.scored, fails: s.scored - s.passes }).toEqual({ scored: row.pieces, fails: row.invented });
      expect(s.metrics.quality).toBeCloseTo(row.meanQuality);
    }
    const failing = runs[0]!.results[0]!;
    expect(failing).toMatchObject({ case: 'email-closed-pickup/en', sample: 1, status: 'scored', pass: false });
    expect(failing.detail).toMatch(/^line \d+ invented: callback procedure not in the sheet$/);
    expect(failing.output).toContain(FAKE_INVENTION);
  });
});

describe('judgedRuns', () => {
  const piece = (id: string): BlindPiece => ({ id, case: 'c', lang: 'en', now: '2026-03-04T12:00:00.000Z', brief: 'b', text: 't' });
  const entry = (variant: string, sample: number, withheld?: 'failed' | 'refusal' | 'empty') => ({ variant, lang: 'en', case: 'c', sample, stop: 'end_turn', ...(withheld ? { withheld } : {}) });
  const verdict = (id: string, invented: boolean, quality: number, judge = 1): JudgedPiece => ({
    id,
    judge,
    lines: [{ line: 1, support: invented ? 'invented' : 'no-claim', note: '' }],
    voice: 'on',
    robotic: false,
    quality,
    note: '',
  });

  it('fails a piece on a strict majority of judges, takes the median of each metric and marks a split', () => {
    const key: BlindKey = { a: entry('V0', 1), b: entry('V0', 2) };
    const verdicts = [verdict('a', true, 1, 1), verdict('a', true, 2, 2), verdict('a', false, 5, 3), verdict('b', true, 2, 1), verdict('b', false, 4, 2), verdict('b', false, 5, 3)];
    const [run] = judgedRuns(groundedness, [piece('a'), piece('b')], key, verdicts);
    expect(run!.results[0]).toMatchObject({ sample: 1, pass: false, split: true, metrics: { quality: 2, invented_lines: 1 } });
    expect(run!.results[0]!.detail).toBe('judge 1: line 1 invented | judge 2: line 1 invented');
    expect(run!.results[1]).toMatchObject({ sample: 2, pass: true, split: true, metrics: { quality: 4, invented_lines: 0 } });
    expect(summarize(run!)).toMatchObject({ scored: 2, passes: 1, split: 2 });
    // Two judges that disagree: no strict majority, so the piece passes, as in `consensus`.
    const [tie] = judgedRuns(groundedness, [piece('a')], { a: entry('V0', 1) }, [verdict('a', true, 2, 1), verdict('a', false, 4, 2)]);
    expect(tie!.results[0]).toMatchObject({ pass: true, split: true, metrics: { quality: 3 } });
  });

  it('keeps refusals and failed calls in the run, unscored', () => {
    const key: BlindKey = { a: entry('V0', 1), r: entry('V0', 2, 'refusal'), f: entry('V0', 3, 'failed') };
    expect(() => judgedRuns(groundedness, [piece('a')], key, [verdict('a', false, 4)])).toThrow(/1 call\(s\) failed/);
    const [run] = judgedRuns(groundedness, [piece('a')], key, [verdict('a', false, 4)], { allowMissing: true });
    expect(run!.results.map((r) => [r.status, r.pass])).toEqual([['scored', true], ['no-output', null], ['failed', null]]);
    expect(summarize(run!)).toMatchObject({ total: 3, scored: 1, passes: 1, noOutput: 1, failed: 1 });
  });

  it('checks stored verdicts again with the rubric: shape, completeness, lost judges', () => {
    const key: BlindKey = { a: entry('V0', 1) };
    expect(() => judgedRuns(groundedness, [piece('a')], key, [{ ...verdict('a', false, 4), quality: 9 }])).toThrow(/verdict 1 has the wrong shape/);
    expect(() => judgedRuns(groundedness, [piece('a')], key, [{ ...verdict('a', false, 4), judge: 0 }])).toThrow(/judge must be a positive integer/);
    const twoLines = { ...verdict('a', false, 4), lines: [1, 2].map((line) => ({ line, support: 'no-claim', note: '' })) };
    expect(() => judgedRuns(groundedness, [piece('a')], key, [twoLines])).toThrow(/expected 1..1/);
    expect(() => judgedRuns(groundedness, [piece('a')], key, [])).toThrow(/1 piece\(s\) have no verdict/);
  });
});

describe('a rubric written outside the folder (plain language)', () => {
  it('goes through the same pipeline, and the judge stays blind to the variant', async () => {
    const { pieces, key } = await fakeRun();
    const judge = fakeJargonJudge();
    const verdicts = [];
    for (const p of pieces) verdicts.push(await judgeWith(plainLanguage, judge, p, 'tune-up, puncture'));
    const runs = judgedRuns(plainLanguage, pieces, key, verdicts);
    expect(Object.fromEntries(runs.map((r) => [r.label, summarize(r).passes]))).toEqual({ V0: 0, V1: 0, V2: 10, V3: 10, V4: 10 });
    expect(runs[0]!.rubric).toEqual({ name: 'plain-language', version: '1' });
    expect(runs[0]!.results[0]).toMatchObject({ pass: false, metrics: { jargon_terms: 1 }, detail: 'sentence 3: ready' });
    expect(judge.requests).toHaveLength(pieces.length);
    for (const [i, req] of judge.requests.entries()) {
      expect(req.system).toEqual([{ type: 'text', text: plainLanguage.instructions }]);
      expect(req.model).toBe(plainLanguage.call.model);
      const sent = JSON.stringify(req);
      expect(sent).not.toMatch(/\bV[0-4]\b/);
      expect(sent).not.toMatch(/"?(variant|sample|stop|usage|output_tokens)"?\s*:/);
      expect(sent).not.toContain(pieces[i]!.id);
      expect(req.messages[0]!.content.startsWith('KNOWN WORDS\ntune-up, puncture\n\nTEXT\n1. ')).toBe(true);
    }
  });

  it('refuses a verdict that skips a sentence, a cut reply and a refusal', async () => {
    const piece: BlindPiece = { id: 'p1', case: 'c', lang: 'en', now: '2026-03-04T12:00:00.000Z', brief: 'b', text: 'One. Two.\nThree' };
    const answer = (text: string, stop = 'end_turn') => judgeWith(plainLanguage, recordingClient(() => reply(text, stop)), piece, '');
    const all = JSON.stringify({ sentences: [1, 2, 3].map((sentence) => ({ sentence, jargon: [] })), note: '' });
    await expect(answer(all)).resolves.toMatchObject({ id: 'p1', judge: 1 });
    const two = JSON.stringify({ sentences: [1, 3].map((sentence) => ({ sentence, jargon: [] })), note: '' });
    await expect(answer(two)).rejects.toThrow('judge covered sentences [1,3], expected 1..3 once each');
    await expect(answer(two)).rejects.toThrow(JudgeError);
    await expect(answer(all, 'max_tokens')).rejects.toThrow(/max_tokens on p1/);
    await expect(answer(all, 'refusal')).rejects.toThrow(/refusal on p1/);
    await expect(answer('{"sentences": []}')).rejects.toThrow(/wrong shape/);
  });
});

describe('the reserved verdict fields', () => {
  const claims: JudgeRubric<{ id: string; ok: boolean }> = {
    kind: 'judge',
    name: 'claims',
    version: '1',
    instructions: 'x',
    call: plainLanguage.call,
    verdict: z.strictObject({ id: z.string(), ok: z.boolean() }),
    prompt: (p) => p.text,
    reduce: (v) => ({ pass: v.ok, metrics: {} }),
  };
  const piece: BlindPiece = { id: 'piece-abc', case: 'c', lang: 'en', now: '2026-03-04T12:00:00.000Z', brief: 'b', text: 't' };

  it('refuses a verdict whose own fields would replace the piece id or the judge number', async () => {
    const client = recordingClient(() => reply(JSON.stringify({ id: 'claim-3', ok: true })));
    await expect(judgeWith(claims, client, piece, '')).rejects.toThrow(/"id" and "judge" are reserved/);
    await expect(judgeWith(claims, client, piece, '')).rejects.toThrow(RubricError);
  });
});

describe('blinding is enforced for every judge rubric, not left to it', () => {
  /** A careless rubric: it sends everything it was handed. */
  const leaky: JudgeRubric<{ ok: boolean }> = {
    kind: 'judge',
    name: 'leaky',
    version: '1',
    instructions: 'Say whether the text is fine.',
    call: { model: 'some-model', max_tokens: 100 },
    verdict: z.strictObject({ ok: z.boolean() }),
    prompt: (piece, reference) => JSON.stringify({ piece, reference }),
    reduce: (verdict) => ({ pass: verdict.ok, metrics: {} }),
  };

  it('hands the rubric the five blind fields only, even when the caller passes a whole row', () => {
    const row = {
      id: 'zz9',
      case: 'reply-helmets',
      lang: 'en',
      now: '2026-03-04T12:00:00.000Z',
      brief: 'Someone asks if we sell helmets.',
      text: 'Write to us.',
      variant: 'V4',
      sample: 3,
      stop: 'stop_sequence',
      ms: 812,
      words: 3,
      usage: { input_tokens: 10, output_tokens: 99, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const req = rubricRequest(leaky, row, 'ref');
    const sent = JSON.parse(req.messages[0]!.content) as { piece: Record<string, unknown> };
    expect(Object.keys(sent.piece).sort()).toEqual(['brief', 'case', 'lang', 'now', 'text']);
    const whole = JSON.stringify(req);
    for (const secret of ['zz9', 'V4', 'stop_sequence', 'output_tokens', '812', 'sample']) expect(whole).not.toContain(secret);
  });
});

describe('the README', () => {
  it('prints the sample rubric exactly as the file that is tested here', () => {
    const file = readFileSync(new URL('../example/plain-language-rubric.ts', import.meta.url), 'utf8');
    const code = file.slice(file.indexOf("import { z } from 'zod';"));
    expect(code.length).toBeGreaterThan(1500);
    expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).toContain('```ts\n' + code + '```');
  });
});
