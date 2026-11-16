// The rewriter's own fact rubric (design 4.6 step 3): the judge reads the rewrite line by line
// against the CV (the fact sheet) and the user's original text (the brief). Its replies come from a
// script through a real gateway, as text replies since the judge makes text calls, so the call
// shape, the line rule and the revert plan are tested offline. The CV and every text here are fictional (evals/cases/cv/en.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JudgeError, judgeWith, LineSupport } from '../../evals/src/index.ts';
import { applyEdits, splitSentences, type AppliedEdit } from '../src/edits.ts';
import { gatewayModelClient } from '../src/model-client.ts';
import {
  factSheet,
  judgeLines,
  judgeRuns,
  planReverts,
  REWRITE_JUDGE_PROMPT_VERSION,
  rewritePiece,
  rewriteRubric,
  type RewriteVerdict,
} from '../src/rubric.ts';
import { callSettings } from '../src/tasks.ts';
import type { Edit } from '../src/types.ts';
import { scriptedGateway, USER } from './scripted-gateway.ts';

const CV = readFileSync(new URL('../evals/cases/cv/en.md', import.meta.url), 'utf8');

const ORIGINAL = [
  'Hi Ana,',
  'Thanks for the call on Tuesday. I cut the median first reply time from 9 hours to 3 hours. I would like to help your team.',
  'Best,',
  'Daniel',
].join('\n');

/** Applies edits to ORIGINAL by quote, so each test names the sentence by its text. */
function rewriteWith(edits: ReadonlyArray<Omit<Edit, 'sentenceId' | 'reason'>>): { text: string; accepted: AppliedEdit[] } {
  const sentences = splitSentences(ORIGINAL, 'en');
  const full = edits.map((e) => {
    const sentence = sentences.find((s) => s.text.includes(e.before));
    if (sentence === undefined) throw new Error(`no sentence quotes "${e.before}"`);
    return { ...e, sentenceId: sentence.id, reason: 'test' };
  });
  const result = applyEdits(ORIGINAL, sentences, full);
  expect(result.rejected).toEqual([]);
  return result;
}

function verdict(supports: readonly LineSupport[], notes: Record<number, string> = {}): RewriteVerdict {
  return { lines: supports.map((support, i) => ({ line: i + 1, support, note: notes[i + 1] ?? '' })), note: '' };
}

const lineOf = (text: string, needle: string): number => {
  const line = judgeLines(text, 'en').find((l) => l.text.includes(needle));
  if (line === undefined) throw new Error(`no line has "${needle}"`);
  return line.line;
};

describe('rewriteRubric', () => {
  it('keeps the labels of evals judge, so its verdicts read the same way', () => {
    const shape = rewriteRubric.verdict.safeParse(verdict(['fact-sheet', 'brief', 'arithmetic', 'no-claim', 'invented']));
    expect(shape.success).toBe(true);
    expect(rewriteRubric.verdict.safeParse({ lines: [{ line: 1, support: 'guess', note: '' }], note: '' }).success).toBe(false);
    expect(LineSupport.options).toEqual(['fact-sheet', 'brief', 'arithmetic', 'no-claim', 'invented']);
  });

  it('is written for a person writing about themselves, not for a business', () => {
    expect(rewriteRubric.instructions).toMatch(/CV/);
    expect(rewriteRubric.instructions).toMatch(/about themselves/);
    expect(rewriteRubric.instructions).not.toMatch(/business|TONE/);
    for (const label of LineSupport.options) expect(rewriteRubric.instructions).toContain(`"${label}"`);
  });

  it('calls with the judge task settings, which the gateway ModelClient accepts', () => {
    expect(rewriteRubric.call).toEqual(callSettings('rewrite.judge', rewriteRubric.call.max_tokens));
  });

  it('numbers the rewrite as S0 splits it, with the CV and the original as tagged data', () => {
    const { text } = rewriteWith([{ before: 'I would like to help your team.', after: 'I want to help your team.' }]);
    const piece = rewritePiece({ original: ORIGINAL, rewritten: text, lang: 'en' });
    const body = rewriteRubric.prompt(piece, factSheet({ cvMarkdown: CV }));
    const lines = splitSentences(text, 'en');
    for (const [i, s] of lines.entries()) expect(body).toContain(`${i + 1}. ${s.text}`);
    expect(body).toContain(`REWRITE (${lines.length} lines)`);
    expect(body).toMatch(/<perfil>\n[\s\S]*Brightwell Parcels[\s\S]*\n<\/perfil>/);
    expect(body).toMatch(/<texto>\nHi Ana,[\s\S]*\n<\/texto>/);
  });

  it('puts the recipient and the extra facts in the fact sheet, never the user id', () => {
    const sheet = factSheet({ cvMarkdown: CV, extraFacts: ['Available from March'], recipient: { name: 'Ana', org: 'Kestrel Freight' } });
    expect(sheet).toContain('Available from March');
    expect(sheet).toContain('Kestrel Freight');
    expect(sheet).toContain(CV.trim());
  });
});

describe('the judge through the gateway', () => {
  const settings = rewriteRubric.call;

  it('returns a verdict that covers every line', async () => {
    const { text } = rewriteWith([{ before: 'I would like to help your team.', after: 'I want to help your team.' }]);
    const count = judgeLines(text, 'en').length;
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: JSON.stringify(verdict(Array<LineSupport>(count).fill('no-claim'))) }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: REWRITE_JUDGE_PROMPT_VERSION });
    const judged = await judgeWith(rewriteRubric, client, rewritePiece({ original: ORIGINAL, rewritten: text, lang: 'en' }), factSheet({ cvMarkdown: CV }), 1, settings);
    expect(judged.lines).toHaveLength(count);
    expect(scripted.calls[0]?.sent).toMatchObject({ model: 'claude-sonnet-5-5' });
    scripted.assertDone();
  });

  it('refuses an incomplete reply: a missing line is not a pass', async () => {
    const { text } = rewriteWith([{ before: 'I would like to help your team.', after: 'I want to help your team.' }]);
    const count = judgeLines(text, 'en').length;
    const missing = verdict(Array<LineSupport>(count).fill('no-claim'));
    missing.lines.splice(1, 1);
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: JSON.stringify(missing) }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: REWRITE_JUDGE_PROMPT_VERSION });
    const judged = judgeWith(rewriteRubric, client, rewritePiece({ original: ORIGINAL, rewritten: text, lang: 'en' }), factSheet({ cvMarkdown: CV }), 1, settings);
    await expect(judged).rejects.toBeInstanceOf(JudgeError);
    await expect(judged).rejects.toThrow(/expected 1\.\.\d+ once each/);
  });

  it('refuses a reply that names a line twice', async () => {
    const { text } = rewriteWith([{ before: 'I would like to help your team.', after: 'I want to help your team.' }]);
    const count = judgeLines(text, 'en').length;
    const twice = verdict(Array<LineSupport>(count).fill('no-claim'));
    twice.lines[1] = { ...twice.lines[0]!, line: 1 };
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: JSON.stringify(twice) }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: REWRITE_JUDGE_PROMPT_VERSION });
    await expect(
      judgeWith(rewriteRubric, client, rewritePiece({ original: ORIGINAL, rewritten: text, lang: 'en' }), factSheet({ cvMarkdown: CV }), 1, settings),
    ).rejects.toBeInstanceOf(JudgeError);
  });
});

describe('planReverts', () => {
  it('reverts the edits that touch an invented line, last to first, and leaves the others', async () => {
    const { text, accepted } = rewriteWith([
      { before: 'Thanks for the call on Tuesday.', after: "Thanks for Tuesday's call." },
      { before: 'I would like', after: 'I led a team of 12 engineers and I would like' },
      { before: 'your team', after: 'your support team' },
    ]);
    const lines = judgeLines(text, 'en');
    const invented = lineOf(text, 'team of 12');
    const supports = lines.map((l) => (l.line === invented ? 'invented' : 'no-claim') as LineSupport);
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: JSON.stringify(verdict(supports, { [invented]: 'the CV names no team of 12' })) }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: REWRITE_JUDGE_PROMPT_VERSION });
    const judged = await judgeWith(rewriteRubric, client, rewritePiece({ original: ORIGINAL, rewritten: text, lang: 'en' }), factSheet({ cvMarkdown: CV }), 1, rewriteRubric.call);

    const plan = planReverts({ original: ORIGINAL, rewritten: text, lang: 'en', verdict: judged, edits: accepted, round: 'first' });
    expect(plan.revert).toEqual(['e3', 'e2']);
    expect(plan.fallback).toEqual([]);
    expect(plan.userClaims).toEqual([]);
  });

  it('follows the order the edits were made in, not their place in the text', () => {
    const { text, accepted } = rewriteWith([
      { before: 'your team', after: 'your support team' },
      { before: 'I would like', after: 'I led a team of 12 engineers and I would like' },
    ]);
    const invented = lineOf(text, 'team of 12');
    const supports = judgeLines(text, 'en').map((l) => (l.line === invented ? 'invented' : 'no-claim') as LineSupport);
    const plan = planReverts({ original: ORIGINAL, rewritten: text, lang: 'en', verdict: verdict(supports), edits: accepted, round: 'first' });
    // e1 was made first and sits later in the line: it is reverted last.
    expect(plan.revert).toEqual(['e2', 'e1']);
  });

  it('reverts an edit that deleted a sentence next to an invented line: what it removed may have qualified it', () => {
    const { text, accepted } = rewriteWith([
      { before: 'I would like to help your team.', after: '' },
      { before: 'from 9 hours to 3 hours', after: 'from 9 hours to 1 hour' },
    ]);
    const invented = lineOf(text, '1 hour');
    const supports = judgeLines(text, 'en').map((l) => (l.line === invented ? 'invented' : 'no-claim') as LineSupport);
    const plan = planReverts({ original: ORIGINAL, rewritten: text, lang: 'en', verdict: verdict(supports), edits: accepted, round: 'first' });
    expect(plan.revert).toEqual(['e2', 'e1']);
  });

  it('on the final round, sends a line still invented back to its original text with a flag', () => {
    const { text, accepted } = rewriteWith([{ before: 'I would like to help your team.', after: 'I helped teams like yours for years.' }]);
    const invented = lineOf(text, 'for years');
    const supports = judgeLines(text, 'en').map((l) => (l.line === invented ? 'invented' : 'no-claim') as LineSupport);
    const plan = planReverts({
      original: ORIGINAL,
      rewritten: text,
      lang: 'en',
      verdict: verdict(supports, { [invented]: 'no years with such teams in the CV' }),
      edits: accepted,
      round: 'final',
    });
    expect(plan.revert).toEqual(['e1']);
    const [fallback] = plan.fallback;
    expect(fallback?.line).toBe(invented);
    expect(fallback?.edits).toEqual(['e1']);
    expect(ORIGINAL.slice(fallback?.original.start, fallback?.original.end)).toBe('I would like to help your team.');
    expect(fallback?.flag).toMatchObject({ kind: 'not-in-cv', span: fallback?.original });
    expect(fallback?.flag.message).toContain('no years with such teams in the CV');
  });

  it('never reverts the user own words: an invented line no edit touched is flagged, not changed', () => {
    const { text, accepted } = rewriteWith([{ before: 'Thanks for the call on Tuesday.', after: "Thanks for Tuesday's call." }]);
    const invented = lineOf(text, '9 hours');
    const supports = judgeLines(text, 'en').map((l) => (l.line === invented ? 'invented' : 'no-claim') as LineSupport);
    for (const round of ['first', 'final'] as const) {
      const plan = planReverts({ original: ORIGINAL, rewritten: text, lang: 'en', verdict: verdict(supports), edits: accepted, round });
      expect(plan.revert).toEqual([]);
      expect(plan.fallback).toEqual([]);
      expect(plan.userClaims.map((c) => c.line)).toEqual([invented]);
      expect(ORIGINAL.slice(plan.userClaims[0]?.flag.span?.start, plan.userClaims[0]?.flag.span?.end)).toContain('9 hours');
    }
  });

  it('refuses a verdict that does not cover the rewrite it is applied to', () => {
    const { text, accepted } = rewriteWith([{ before: 'I would like to help your team.', after: 'I want to help your team.' }]);
    expect(() => planReverts({ original: ORIGINAL, rewritten: text, lang: 'en', verdict: verdict(['no-claim']), edits: accepted, round: 'first' })).toThrow(JudgeError);
  });
});

describe('judgeRuns (D10)', () => {
  it('runs on email, follow-up and cover-letter in every mode', () => {
    for (const genre of ['email', 'follow-up', 'cover-letter'] as const) {
      for (const mode of [undefined, 'minimo', 'pulido', 'reescritura'] as const) {
        expect(judgeRuns({ genre, mode })).toBe(true);
        expect(judgeRuns({ genre, mode, strict: false })).toBe(true);
      }
    }
  });

  it('runs on WhatsApp in minimo only with strict, and minimo is the WhatsApp default', () => {
    expect(judgeRuns({ genre: 'whatsapp' })).toBe(false);
    expect(judgeRuns({ genre: 'whatsapp', mode: 'minimo' })).toBe(false);
    expect(judgeRuns({ genre: 'whatsapp', mode: 'minimo', strict: false })).toBe(false);
    expect(judgeRuns({ genre: 'whatsapp', mode: 'minimo', strict: true })).toBe(true);
    expect(judgeRuns({ genre: 'whatsapp', strict: true })).toBe(true);
  });

  it('runs on WhatsApp outside minimo', () => {
    expect(judgeRuns({ genre: 'whatsapp', mode: 'pulido' })).toBe(true);
    expect(judgeRuns({ genre: 'whatsapp', mode: 'reescritura' })).toBe(true);
  });
});
