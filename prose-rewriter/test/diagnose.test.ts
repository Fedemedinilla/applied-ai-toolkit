// diagnose(): step 2 of the cohesion plan. One structured call reads the whole message (why the
// writer writes, what the reader needs, where an idea does not follow, whether the opening and the
// closing do what the channel asks, what reads as generated), next to the shape code measured. Code
// keeps only what the model can back: a purpose or a need it quotes from the text, the recipient
// or the goal, and gaps and sentences that exist. Not yet called by rewrite().
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Channel, Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import { diagnose, DIAGNOSE_PROMPT_VERSION } from '../src/diagnose.ts';
import type { PromptRefs } from '../src/prompt.ts';
import { REWRITE_TASKS } from '../src/tasks.ts';
import { RewriteInput } from '../src/types.ts';
import { scriptedGateway, USER } from './scripted-gateway.ts';

const REPO = join(import.meta.dirname, '..', '..');
const read = (file: string): string => readFileSync(join(REPO, file), 'utf8');
const json = (file: string): unknown[] => JSON.parse(read(file)) as unknown[];
const REFS: PromptRefs = {
  sources: json('style-refs/sources.json').map((s) => Source.parse(s)),
  principles: LANGS.flatMap((lang) => json(`style-refs/principles/${lang}.json`).map((p) => Principle.parse(p))),
  examples: LANGS.flatMap((lang) => json(`style-refs/examples/${lang}.json`).map((e) => Example.parse(e))),
  channels: LANGS.flatMap((lang) => json(`style-refs/channels/${lang}.json`).map((c) => Channel.parse(c))),
};

const MAIL = [
  'Hola, Martín:',
  '',
  'Espero que estés muy bien. Me apasiona potenciar sinergias. Vi que en la agencia buscan ayuda con WordPress.',
  '',
  'Mantengo tres sitios WordPress con copias semanales. Quedo a tu entera disposición.',
  '',
  'Valeria Sosa',
].join('\n');

const input = (over: Partial<RewriteInput> = {}): RewriteInput =>
  RewriteInput.parse({
    text: MAIL,
    genre: 'email',
    lang: 'es',
    variety: 'rioplatense',
    mode: 'redaccion',
    profile: { cvMarkdown: read('prose-rewriter/evals/cases/cv/es-rioplatense.md') },
    recipient: { name: 'Martín', org: 'Agencia Nodo' },
    goal: 'preguntar si toman freelance',
    ...over,
  });

const reply = (over: Record<string, unknown> = {}) => ({
  data: {
    purpose: { found: true, quote: 'buscan ayuda con WordPress', note: 'Writes because the agency is looking for WordPress help.' },
    readerNeed: { found: true, quote: 'ayuda con WordPress', note: 'The agency needs a hand with WordPress.' },
    gaps: [{ afterSentenceId: 2, why: 'Jumps from passion to the agency with nothing between.' }],
    opening: { works: false, why: 'Opens on a stock wish, not on why she writes.' },
    closing: { works: false, why: 'A stock closer, no next step.' },
    artificial: [{ sentenceId: 1, quote: 'Espero que estés muy bien', why: 'Stock opener.' }],
    ...over,
  },
});

describe('diagnose', () => {
  it('is a task of its own, with a fixed prompt version', () => {
    expect(REWRITE_TASKS).toContain('rewrite.diagnose');
    expect(DIAGNOSE_PROMPT_VERSION).toBe('rewrite-diagnose@1');
  });

  it('makes one call and returns the reading next to the shape code measured against the channel guide', async () => {
    const scripted = scriptedGateway({ 'rewrite.diagnose': [reply()] });
    const d = await diagnose(input(), { gateway: scripted.gateway, refs: REFS, userId: USER });
    scripted.assertDone();
    expect(scripted.calls.map((c) => [c.task, c.request.promptVersion])).toEqual([['rewrite.diagnose', 'rewrite-diagnose@1']]);
    expect(d.shape.guide).toBe('es-email-neutral');
    expect(d.shape.paragraphs).toEqual([3, 2]);
    expect(d.reading?.purpose).toEqual({ found: true, quote: 'buscan ayuda con WordPress', note: 'Writes because the agency is looking for WordPress help.' });
    expect(d.reading?.gaps).toEqual([{ afterSentenceId: 2, why: 'Jumps from passion to the agency with nothing between.' }]);
    expect(d.dropped).toEqual([]);
    expect(d.usage.calls).toBe(1);
    expect(d.unread).toBe(false);
  });

  it('sends the text as data, the shape and the findings, and asks it to quote, never to guess', async () => {
    const scripted = scriptedGateway({ 'rewrite.diagnose': [reply()] });
    await diagnose(input(), { gateway: scripted.gateway, refs: REFS, userId: USER });
    const user = String(scripted.calls[0]?.request.messages[0]?.content);
    expect(user).toMatch(/^TASK: diagnose/);
    expect(user).toMatch(/<texto>\n\[0\] Hola, Martín:/);
    expect(user).toContain('SHAPE (measured by code against the channel guide es-email-neutral)');
    expect(user).toContain('- paragraphs: 2, with 3 and 2 sentences');
    expect(user).toMatch(/FINDINGS \(slop-lint, by sentenceId\)/);
    expect(user).toMatch(/quote[^\n]*exactly[^\n]*found false/i);
    expect(scripted.calls[0]?.request.system).toHaveLength(4);
  });

  it('drops a purpose or a need it cannot quote from the text, the recipient or the goal', async () => {
    const scripted = scriptedGateway({ 'rewrite.diagnose': [reply({ readerNeed: { found: true, quote: 'quieren bajar costos', note: 'Guessed.' } })] });
    const d = await diagnose(input(), { gateway: scripted.gateway, refs: REFS, userId: USER });
    expect(d.reading?.readerNeed).toEqual({ found: false, quote: '', note: 'Guessed.' });
    expect(d.dropped).toEqual(['readerNeed: «quieren bajar costos» is not in the text, the recipient or the goal']);
  });

  it('accepts a quote from the recipient or the goal, whatever its case and spacing', async () => {
    const scripted = scriptedGateway({ 'rewrite.diagnose': [reply({ purpose: { found: true, quote: 'Preguntar  si toman freelance', note: 'From the goal.' } })] });
    const d = await diagnose(input(), { gateway: scripted.gateway, refs: REFS, userId: USER });
    expect(d.reading?.purpose.found).toBe(true);
    expect(d.dropped).toEqual([]);
  });

  it('drops a gap after the last body sentence or outside the body, and a quote not in its sentence', async () => {
    const scripted = scriptedGateway({
      'rewrite.diagnose': [
        reply({
          gaps: [{ afterSentenceId: 0, why: 'After the greeting.' }, { afterSentenceId: 5, why: 'After the last.' }, { afterSentenceId: 3, why: 'Real.' }],
          artificial: [{ sentenceId: 4, quote: 'Me apasiona', why: 'Wrong sentence.' }, { sentenceId: 5, quote: 'entera disposición', why: 'Stock closer.' }],
        }),
      ],
    });
    const d = await diagnose(input(), { gateway: scripted.gateway, refs: REFS, userId: USER });
    expect(d.reading?.gaps).toEqual([{ afterSentenceId: 3, why: 'Real.' }]);
    expect(d.reading?.artificial).toEqual([{ sentenceId: 5, quote: 'entera disposición', why: 'Stock closer.' }]);
    expect(d.dropped).toEqual([
      'gap after sentence 0: both sentences must be body sentences, one after the other',
      'gap after sentence 5: both sentences must be body sentences, one after the other',
      'artificial in sentence 4: «Me apasiona» is not in that sentence',
    ]);
  });

  it('asks once more when the reply cannot be read, and reports no reading when the retry fails too', async () => {
    const bad = { data: { purpose: 'not an object' } };
    const scripted = scriptedGateway({ 'rewrite.diagnose': [bad, bad] });
    const d = await diagnose(input(), { gateway: scripted.gateway, refs: REFS, userId: USER });
    scripted.assertDone();
    expect(scripted.calls).toHaveLength(2);
    expect(d.reading).toBeNull();
    expect(d.unread).toBe(true);
    expect(d.shape.words).toBeGreaterThan(0);
  });

  it('measures the shape without a guide when the channel has none, and still reads', async () => {
    const scripted = scriptedGateway({ 'rewrite.diagnose': [reply()] });
    const d = await diagnose(input({ genre: 'cover-letter', register: 'formal' }), { gateway: scripted.gateway, refs: REFS, userId: USER });
    expect(d.shape.guide).toBeNull();
    expect(String(scripted.calls[0]?.request.messages[0]?.content)).toContain('SHAPE (measured by code; this channel has no guide)');
  });
});
