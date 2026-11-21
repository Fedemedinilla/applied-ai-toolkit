// The reader-value judge (decision of 2026-11-21): the human review of 2026-11-20 found rewrites
// that read like "the CV in fewer words". This judge asks what the review asked. Fictional data.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JUDGE_RUBRICS, judgePieces, READER_VALUE } from '../evals/judges.ts';
import type { EvalCase, PieceRecord } from '../evals/pipeline.ts';
import type { RewriteInput } from '../src/types.ts';
import { scriptedGateway } from './scripted-gateway.ts';

const CV_ES = readFileSync(new URL('../evals/cases/cv/es-rioplatense.md', import.meta.url), 'utf8');
const NOW = new Date('2026-11-21T12:00:00Z');
const ORIGINAL = 'Hola Marta,\nRehice el sitio de la panadería en Astro y ahora carga en 1,6 s.\nSaludos,\nValeria';
const REWRITE = 'Hola Marta,\nTe escribo porque vi que la escuela quiere renovar el sitio, y me gustaría ayudarlos con eso. Rehice el sitio de la panadería en Astro y ahora carga en 1,6 s; algo así podría hacer con el de ustedes.\nSaludos,\nValeria';
const input: RewriteInput = { text: ORIGINAL, genre: 'email', lang: 'es', variety: 'rioplatense', profile: { cvMarkdown: CV_ES } };
const CASES: EvalCase[] = [{ id: 'es-email-reader', input }];
const piece: PieceRecord = {
  case: 'es-email-reader',
  genre: 'email',
  lang: 'es',
  mode: 'redaccion',
  variant: 'single-guarded',
  status: 'done',
  rewritten: REWRITE,
  result: { kind: 'single-call', rewritten: REWRITE, applied: 1, refused: 0, usage: { calls: 1, costUsd: 0 } },
  usage: { calls: 1, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, extraRound: false },
};

describe('the reader-value judge', () => {
  it('runs before the fact check, on the judge task', () => {
    expect(JUDGE_RUBRICS.map((r) => r.name).slice(-2)).toEqual(['reader-value', 'fact-check']);
    expect(READER_VALUE.instructions).toMatch(/something the CV alone does not/u);
    expect(READER_VALUE.instructions).toMatch(/the CV in fewer words/u);
    expect(READER_VALUE.instructions).toMatch(/Do not reward length/u);
  });

  it('reads the message next to the CV it goes with, and scores the answer', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: 'Here it is: {"gives": true, "note": "says why and links the result to the school"} done' }] });
    const records = await judgePieces(CASES, [piece], { gateway: scripted.gateway, now: NOW, rubrics: ['reader-value'] });
    scripted.assertDone();
    expect(records.map((r) => [r.rubric, r.status, r.pass])).toEqual([['reader-value', 'scored', true]]);
    const user = String(scripted.calls[0]!.request.messages[0]?.content);
    expect(user).toContain('Rehice el sitio de la Panadería Los Álamos en Astro');
    expect(user).toContain('me gustaría ayudarlos con eso');
  });

  it('fails a message that only restates the CV', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: JSON.stringify({ gives: false, note: 'a list of CV facts' }) }] });
    const records = await judgePieces(CASES, [piece], { gateway: scripted.gateway, now: NOW, rubrics: ['reader-value'] });
    expect(records[0]).toMatchObject({ rubric: 'reader-value', status: 'scored', pass: false });
  });
});
