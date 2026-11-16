// F6a: the eval harness of prose-rewriter/evals/, offline, over the scripted gateway.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendJsonl, decide, gate, parseRun, readJsonl } from '../../evals/src/index.ts';
import { Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import { caseOrder, JUDGE_RUBRICS, judgePieces, judgeRuns, type JudgeRecord } from '../evals/judges.ts';
import { pipelineVariant, runPipelines, singleCall, VARIANTS, type EvalCase, type PieceRecord } from '../evals/pipeline.ts';
import { PROMPT_VERSION, singleCallPrompt, systemBlocks, type PromptRefs } from '../src/prompt.ts';
import { rewrite } from '../src/rewrite.ts';
import { judgeLines } from '../src/rubric.ts';
import { RewriteInput } from '../src/types.ts';
import { scriptedGateway } from './scripted-gateway.ts';

const ROOT = new URL('../../', import.meta.url);
const CV_ES = readFileSync(new URL('prose-rewriter/evals/cases/cv/es-rioplatense.md', ROOT), 'utf8');
const json = (file: string): unknown[] => JSON.parse(readFileSync(new URL(file, ROOT), 'utf8')) as unknown[];
const REFS: PromptRefs = {
  sources: json('style-refs/sources.json').map((s) => Source.parse(s)),
  principles: LANGS.flatMap((lang) => json(`style-refs/principles/${lang}.json`).map((p) => Principle.parse(p))),
  examples: LANGS.flatMap((lang) => json(`style-refs/examples/${lang}.json`).map((e) => Example.parse(e))),
};

/** Fictional mail: greeting line 0, body 1 to 4, signature 5 and 6; two LEX-01 findings in sentence 2. */
const MAIL = 'Hola Marta,\nEspero que estés bien. Quería comentarte que me apasiona potenciar sinergias. El sitio de la panadería ya carga en 1,6 s. ¿Lo vemos el jueves?\nSaludos,\nValeria';
const SINERGIAS = 'Quería comentarte que me apasiona potenciar sinergias.';
const FIXED = 'Quería contarte que el sitio está listo.';

const mail = (text: string): RewriteInput => ({ text, genre: 'email', lang: 'es', variety: 'rioplatense', profile: { cvMarkdown: CV_ES } });
const plan = (...sentenceIds: number[]) => ({ data: { items: sentenceIds.map((sentenceId) => ({ sentenceId, action: 'remove-formula', reason: 'set phrase', ruleId: 'LEX-01' })) } });
const edits = (...list: Array<{ sentenceId: number; before: string; after: string; principleId?: string }>) => ({
  data: { edits: list.map((e) => ({ reason: 'fix', ...e })) },
});
/** The fact judge's reply over the lines of `rewritten`, nothing invented. */
const factVerdict = (rewritten: string) => ({
  text: JSON.stringify({ lines: judgeLines(rewritten, 'es').map((l) => ({ line: l.line, support: 'no-claim', note: '' })), note: '' }),
});
const tasksOf = (s: { calls: readonly { task: string }[] }) => s.calls.map((c) => c.task);

describe('rewrite() options for the eval variants', () => {
  it('skips S4 when skipStyle is set, and still runs it by default', async () => {
    const expected = MAIL.replace(SINERGIAS, FIXED);
    const skipped = scriptedGateway({ 'rewrite.plan': [plan(2)], 'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })], 'rewrite.judge': [factVerdict(expected)] });
    const result = await rewrite(mail(MAIL), { gateway: skipped.gateway, refs: REFS, skipStyle: true });
    skipped.assertDone();
    expect(tasksOf(skipped)).toEqual(['rewrite.plan', 'rewrite.edit', 'rewrite.judge']);
    expect(result.rewritten).toBe(expected);

    const full = scriptedGateway({
      'rewrite.plan': [plan(2)],
      'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })],
      'rewrite.style': [edits()],
      'rewrite.judge': [factVerdict(expected)],
    });
    await rewrite(mail(MAIL), { gateway: full.gateway, refs: REFS, skipStyle: false });
    full.assertDone();
    expect(tasksOf(full)).toEqual(['rewrite.plan', 'rewrite.edit', 'rewrite.style', 'rewrite.judge']);
  });
});

const CLEAN_CHAT = 'Hola Marta, te paso el link del sitio nuevo de la panadería. Lo armé en Astro y carga en 1,6 s. Avisame si querés que lo veamos el jueves.';
const usage = (input: number, output: number, cacheRead = 0) => ({ usage: { input, output, cacheRead } });

describe('the single-call baseline (design 4.10)', () => {
  it('builds one prompt that plans and edits, with the same system blocks as the stages', () => {
    const input = RewriteInput.parse(mail(MAIL));
    const context = { input, register: 'neutral' as const, refs: REFS };
    const p = singleCallPrompt(context, []);
    expect(p.task).toBe('rewrite.edit');
    expect(p.promptVersion).toBe(`rewrite-single@${PROMPT_VERSION}`);
    expect(p.system).toEqual(systemBlocks(context));
    const [turn] = p.messages;
    expect(turn?.role).toBe('user');
    expect(String(turn?.content)).toMatch(/^TASK: plan and edit in one step/);
    expect(String(turn?.content)).toContain(`[2] ${SINERGIAS}`);
  });

  it('makes exactly one call and applies the edits it can place', async () => {
    const scripted = scriptedGateway({
      'rewrite.edit': [{ ...edits({ sentenceId: 2, before: SINERGIAS, after: FIXED }, { sentenceId: 3, before: 'no está', after: 'x' }), ...usage(900, 120) }],
    });
    const result = await singleCall(mail(MAIL), { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    expect(scripted.calls.map((c) => [c.task, c.request.promptVersion])).toEqual([['rewrite.edit', `rewrite-single@${PROMPT_VERSION}`]]);
    expect(result).toMatchObject({ rewritten: MAIL.replace(SINERGIAS, FIXED), applied: 1, refused: 1, usage: { calls: 1 } });
  });

  it('takes the same early exit as rewrite(): no call', async () => {
    const scripted = scriptedGateway({});
    const result = await singleCall({ ...mail(CLEAN_CHAT), genre: 'whatsapp' }, { gateway: scripted.gateway, refs: REFS });
    expect(scripted.calls).toEqual([]);
    expect(result).toMatchObject({ rewritten: CLEAN_CHAT, applied: 0, refused: 0, usage: { calls: 0, costUsd: 0 } });
  });
});

const CASES: EvalCase[] = [{ id: 'es-email-slop', input: mail(MAIL) }];
const byId = (id: string) => {
  const v = VARIANTS.find((x) => x.id === id);
  if (v === undefined) throw new Error(`no variant ${id}`);
  return v;
};

describe('the pipeline variants (design 5, "F6 suma")', () => {
  it('lists the full pipeline, the ablations, the single-call baseline and another model on rewrite.edit', () => {
    expect(VARIANTS.map((v) => v.id)).toEqual(['full', 'no-style', 'no-examples', 'single-call', 'edit-sonnet-5-5']);
  });

  it('refuses a variant that overrides the judge, a repeated id or a repeated case before any call', async () => {
    expect(() => pipelineVariant({ id: 'x', kind: 'pipeline', tasks: { 'rewrite.judge': { model: 'claude-opus-5-5', effort: 'medium' } } } as never)).toThrow(/rewrite.judge/);
    const scripted = scriptedGateway({});
    await expect(runPipelines(CASES, [byId('full'), byId('full')], { gateway: scripted.gateway, refs: REFS })).rejects.toThrow(/full is listed twice/);
    await expect(runPipelines([...CASES, ...CASES], [byId('full')], { gateway: scripted.gateway, refs: REFS })).rejects.toThrow(/es-email-slop is listed twice/);
    expect(scripted.calls).toEqual([]);
  });

  it('sends rewrite.edit with another model through the request config, and leaves the other tasks on theirs', async () => {
    const expected = MAIL.replace(SINERGIAS, FIXED);
    const scripted = scriptedGateway({
      'rewrite.plan': [plan(2)],
      'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })],
      'rewrite.style': [edits()],
      'rewrite.judge': [factVerdict(expected)],
    });
    await runPipelines(CASES, [byId('edit-sonnet-5-5')], { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    expect(scripted.calls.map((c) => [c.task, c.sent?.['model']])).toEqual([
      ['rewrite.plan', 'claude-fable-5-2'],
      ['rewrite.edit', 'claude-sonnet-5-5'],
      ['rewrite.style', 'claude-fable-5-2'],
      ['rewrite.judge', 'claude-sonnet-5-5'],
    ]);
  });

  it('drops the examples from the prompt in no-examples, and only them', async () => {
    const expected = MAIL.replace(SINERGIAS, FIXED);
    const reply = { 'rewrite.plan': [plan(2)], 'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })], 'rewrite.style': [edits()], 'rewrite.judge': [factVerdict(expected)] };
    const full = scriptedGateway(reply);
    const bare = scriptedGateway(reply);
    await runPipelines(CASES, [byId('full')], { gateway: full.gateway, refs: REFS });
    await runPipelines(CASES, [byId('no-examples')], { gateway: bare.gateway, refs: REFS });
    const [f, b] = [full.calls[0]?.request.system ?? [], bare.calls[0]?.request.system ?? []];
    expect(f[1]).toMatch(/^EXAMPLES[^\n]*\n\nExample /);
    expect(b[1]).toBe('EXAMPLES (fictional people; before and after pairs of this genre and register)\nNone for this genre and register.');
    expect([b[0], b[2], b[3]]).toEqual([f[0], f[2], f[3]]);
  });
});

describe('runPipelines', () => {
  it('runs cases x variants and records one piece each, with tokens, calls, the extra round and the cost', async () => {
    const expected = MAIL.replace(SINERGIAS, FIXED);
    const scripted = scriptedGateway({
      'rewrite.plan': [{ ...plan(2), ...usage(1000, 50, 800) }],
      'rewrite.edit': [
        { ...edits({ sentenceId: 2, before: SINERGIAS, after: FIXED }), ...usage(1100, 60, 800) },
        { ...edits({ sentenceId: 2, before: SINERGIAS, after: FIXED }), ...usage(900, 70) },
      ],
      'rewrite.judge': [{ ...factVerdict(expected), ...usage(500, 40) }],
    });
    const seen: PieceRecord[] = [];
    const records = await runPipelines(CASES, [byId('no-style'), byId('single-call')], { gateway: scripted.gateway, refs: REFS, record: (r) => seen.push(r) });
    scripted.assertDone();
    expect(seen).toEqual(records);
    expect(records.map((r) => [r.case, r.variant, r.genre, r.lang, r.mode, r.status, r.status === 'done' ? r.rewritten : r.error])).toEqual([
      ['es-email-slop', 'no-style', 'email', 'es', 'pulido', 'done', expected],
      ['es-email-slop', 'single-call', 'email', 'es', 'pulido', 'done', expected],
    ]);
    const [pipeline, single] = records;
    expect(pipeline?.usage).toMatchObject({ calls: 3, extraRound: false, tokens: { input: 2600, output: 150, cacheRead: 1600, cacheWrite5m: 0, cacheWrite1h: 0 } });
    expect(pipeline?.usage.calls).toBe(pipeline?.status === 'done' && pipeline.result.kind === 'pipeline' ? pipeline.result.usage.calls : -1);
    expect(single?.usage).toMatchObject({ calls: 1, extraRound: false, tokens: { input: 900, output: 70, cacheRead: 0 } });
    expect(typeof pipeline?.usage.costUsd).toBe('number');
    expect(pipeline?.usage.costUsd).toBeGreaterThan(0);
  });

  it('marks the extra round when S3 runs twice', async () => {
    // The first edit leaves the LEX-01 findings in place, so S6 asks for one more S3 round.
    const expected = MAIL.replace(SINERGIAS, FIXED);
    const scripted = scriptedGateway({
      'rewrite.plan': [plan(2)],
      'rewrite.edit': [edits({ sentenceId: 2, before: 'comentarte', after: 'contarte' }), edits({ sentenceId: 2, before: 'que me apasiona potenciar sinergias', after: 'que el sitio está listo' })],
      'rewrite.judge': [factVerdict(expected)],
    });
    const [r] = await runPipelines(CASES, [byId('no-style')], { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    expect(r?.status === 'done' ? r.rewritten : r?.error).toBe(expected);
    expect(r?.usage).toMatchObject({ calls: 4, extraRound: true });
  });

  it('records a failed piece and goes on; a cap stops the run after recording it', async () => {
    // A plan the schema refuses fails the piece; the run goes on to the next variant.
    const scripted = scriptedGateway({ 'rewrite.plan': [{ data: { items: 'none' } }], 'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })] });
    const records = await runPipelines(CASES, [byId('full'), byId('single-call')], { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    expect(records.map((r) => [r.variant, r.status, r.usage.calls])).toEqual([['full', 'failed', 1], ['single-call', 'done', 1]]);
    expect(records[0]?.status === 'failed' ? records[0].error : '').toMatch(/^ResponseError/);

    // The plan spends past the monthly cap, so the gateway refuses the edit call before it is sent.
    const capped = scriptedGateway(
      { 'rewrite.plan': [{ ...plan(2), ...usage(100_000, 1000) }], 'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })] },
      { caps: { perJobUsd: 1, dailyPerUserUsd: 1, monthlyUsd: 0.01 } },
    );
    const seen: PieceRecord[] = [];
    await expect(runPipelines(CASES, [byId('full'), byId('single-call')], { gateway: capped.gateway, refs: REFS, record: (r) => seen.push(r) })).rejects.toThrow();
    expect(seen.map((r) => [r.variant, r.status, r.usage.calls])).toEqual([['full', 'failed', 1]]);
    expect(capped.calls.map((c) => [c.task, c.sent === null])).toEqual([['rewrite.plan', false], ['rewrite.edit', true]]);
    expect(seen[0]?.status === 'failed' ? seen[0].error : '').toMatch(/^CapError/);
  });

  it('writes the records with evals appendJsonl, one line per piece', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rewriter-evals-')), 'run.jsonl');
    const scripted = scriptedGateway({});
    const clean: EvalCase = { id: 'es-whatsapp-clean', input: { ...mail(CLEAN_CHAT), genre: 'whatsapp' } };
    await runPipelines([clean], [byId('full'), byId('single-call')], { gateway: scripted.gateway, refs: REFS, record: (r) => appendJsonl(path, r) });
    const lines = readJsonl<PieceRecord>(path);
    expect(lines.map((r) => [r.case, r.variant, r.status, r.usage.calls, r.usage.costUsd])).toEqual([
      ['es-whatsapp-clean', 'full', 'done', 0, 0],
      ['es-whatsapp-clean', 'single-call', 'done', 0, 0],
    ]);
  });
});

describe('the blind judges as a per-piece pass (design 5)', () => {
  const NOW = new Date('2026-11-16T12:00:00Z');
  const pipelined = MAIL.replace(SINERGIAS, FIXED);
  const single = MAIL.replace(SINERGIAS, 'Te escribo por el sitio.');
  const piece = (variant: string, rewritten: string): PieceRecord => ({
    case: 'es-email-slop',
    genre: 'email',
    lang: 'es',
    mode: 'pulido',
    variant,
    status: 'done',
    rewritten,
    result: { kind: 'single-call', rewritten, applied: 1, refused: 0, usage: { calls: 1, costUsd: 0 } },
    usage: { calls: 1, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, extraRound: false },
  });
  const choice = (c: 'A' | 'B') => ({ text: JSON.stringify({ choice: c, note: '' }) });
  const yes = (key: string, value: boolean) => ({ text: JSON.stringify({ [key]: value, note: '' }) });

  it('lists the four judge rubrics of design 5, pairwise twice', () => {
    expect(JUDGE_RUBRICS.map((r) => r.name)).toEqual(['pairwise-original', 'pairwise-baseline', 'same-voice', 'register-fit', 'literary-contamination']);
  });

  it('derives the A/B order from the case id alone: the same on every run', () => {
    expect(caseOrder('es-email-slop', 'pairwise-original')).toBe(caseOrder('es-email-slop', 'pairwise-original'));
    const orders = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => caseOrder(id, 'pairwise-original')));
    expect(orders).toEqual(new Set(['AB', 'BA']));
  });

  it('judges blind through rewrite.judge, maps the choice back through the order, and feeds gate() and decide()', async () => {
    // Every pairwise judge answers "A": whether that is the candidate depends on the order of the case.
    const scripted = scriptedGateway({
      'rewrite.judge': [choice('A'), choice('A'), choice('A'), yes('same', true), yes('same', false), yes('fits', true), yes('fits', true), yes('contaminated', false), yes('contaminated', true)],
    });
    const seen: JudgeRecord[] = [];
    const records = await judgePieces(CASES, [piece('full', pipelined), piece('single-call', single)], { gateway: scripted.gateway, now: NOW, record: (r) => seen.push(r) });
    scripted.assertDone();
    expect(seen).toEqual(records);
    expect(scripted.calls.every((c) => c.task === 'rewrite.judge' && c.sent?.['model'] === 'claude-sonnet-5-5')).toBe(true);

    // Blind: no variant name reaches the judge, and the A/B texts follow the order of the case.
    for (const c of scripted.calls) expect(JSON.stringify(c.request.messages)).not.toMatch(/single-call|full|pipeline/);
    const pairOrder = caseOrder('es-email-slop', 'pairwise-original');
    const first = String(scripted.calls[0]?.request.messages[0]?.content);
    const a = first.slice(first.indexOf('VERSION A'), first.indexOf('VERSION B'));
    expect(a).toContain(pairOrder === 'AB' ? 'Quería comentarte que me apasiona potenciar sinergias.' : 'Quería contarte');

    const pass = (rubric: string, variant: string) => records.find((r) => r.rubric === rubric && r.variant === variant)?.pass;
    const aWins = (order: string) => order === 'BA'; // A is the candidate when the order is BA
    expect(pass('pairwise-original', 'full')).toBe(aWins(pairOrder));
    expect(pass('pairwise-original', 'single-call')).toBe(aWins(pairOrder));
    expect(pass('pairwise-baseline', 'full')).toBe(aWins(caseOrder('es-email-slop', 'pairwise-baseline')));
    expect(records.filter((r) => r.rubric === 'pairwise-baseline').map((r) => r.variant)).toEqual(['full']);
    // The judging order is shuffled, so the yes/no verdicts land on either variant; each count holds.
    for (const rubric of ['same-voice', 'literary-contamination']) expect(records.filter((r) => r.rubric === rubric).map((r) => r.pass).sort()).toEqual([false, true]);
    expect(records.filter((r) => r.rubric === 'register-fit').map((r) => r.pass)).toEqual([true, true]);
    expect(records.every((r) => r.usage.calls === 1)).toBe(true);

    const runs = judgeRuns(records);
    const full = parseRun(runs.get('pairwise-original/full'));
    const baseline = parseRun(runs.get('pairwise-original/single-call'));
    expect(full.results).toEqual([{ case: 'es-email-slop', sample: 1, status: 'scored', pass: aWins(pairOrder), metrics: {} }]);
    expect(gate(baseline, full).state).toMatch(/^(pass|fail|inconclusive)$/);
    // pairwise-baseline gives both sides from the same verdicts: the baseline's pass is the pipeline's loss.
    const versus = parseRun(runs.get('pairwise-baseline/single-call vs full'));
    expect(versus.results[0]?.pass).toBe(!pass('pairwise-baseline', 'full'));
    const pipelineSide = parseRun(runs.get('pairwise-baseline/full'));
    const count = (run: typeof versus) => run.results.filter((r) => r.pass === true).length;
    expect(gate(versus, pipelineSide).state).toBe(decide(count(versus), 1, count(pipelineSide), 1));
  });

  it('does not pay to compare a text with itself, and carries a failed piece to every rubric', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [yes('fits', true), yes('contaminated', false)] });
    const failed: PieceRecord = { ...piece('no-style', ''), status: 'failed', error: 'ResponseError: x' } as PieceRecord;
    const records = await judgePieces(CASES, [piece('full', MAIL), failed], { gateway: scripted.gateway, now: NOW });
    scripted.assertDone();
    const full = records.filter((r) => r.variant === 'full').map((r) => [r.rubric, r.status, r.pass]);
    expect(full).toEqual([
      ['pairwise-original', 'no-output', null],
      ['same-voice', 'no-output', null],
      ['register-fit', 'scored', true],
      ['literary-contamination', 'scored', true],
    ]);
    expect(records.filter((r) => r.variant === 'no-style').map((r) => [r.rubric, r.status])).toEqual([
      ['pairwise-original', 'failed'],
      ['same-voice', 'failed'],
      ['register-fit', 'failed'],
      ['literary-contamination', 'failed'],
    ]);
  });

  it('records a judge reply it cannot read as failed and goes on', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: 'I prefer A.' }, yes('same', true), yes('fits', true), yes('contaminated', false)] });
    const records = await judgePieces(CASES, [piece('full', pipelined)], { gateway: scripted.gateway, now: NOW });
    scripted.assertDone();
    expect(records.map((r) => [r.rubric, r.status])).toEqual([
      ['pairwise-original', 'failed'],
      ['same-voice', 'scored'],
      ['register-fit', 'scored'],
      ['literary-contamination', 'scored'],
    ]);
    expect(records[0]?.error).toMatch(/^JudgeError/);
  });
});
