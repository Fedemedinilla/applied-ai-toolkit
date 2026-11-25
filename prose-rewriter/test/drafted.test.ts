// The 'drafted' strategy (cohesion plan, steps 2 to 4): diagnosis, outline and a draft of the body,
// checked as one edit over the whole body by the same placement, fact checks, relint and judge as any
// edit. When the draft does not stand, 'single' rewrites the text and the draft is a reverted change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Channel, Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import { factInvariant } from '../src/facts.ts';
import type { PromptRefs } from '../src/prompt.ts';
import { rewrite } from '../src/rewrite.ts';
import { judgeLines } from '../src/rubric.ts';
import { prepare } from '../src/stages/analyse.ts';
import { RewriteInput, type RewriteResult } from '../src/types.ts';
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

const GREETING = 'Hola, Martín:';
const BODY = 'Espero que estés muy bien. Me apasiona potenciar sinergias. Vi que en la agencia buscan ayuda con WordPress.\n\nMantengo tres sitios WordPress con copias semanales. Quedo a tu entera disposición.';
const MAIL = `${GREETING}\n\n${BODY}\n\nValeria Sosa`;
const DRAFT =
  'Te escribo porque vi que en la agencia buscan ayuda con WordPress, y me gustaría darles una mano.\n\n' +
  'Hoy mantengo tres sitios WordPress con copias semanales y actualizaciones mensuales. Ese mismo cuidado se lo podría dar a los sitios que ustedes atienden.\n\n' +
  'Si te interesa, lo charlamos cuando te quede cómodo.';
const around = (body: string): string => `${GREETING}\n\n${body}\n\nValeria Sosa`;

const input = (over: Partial<RewriteInput> = {}): RewriteInput =>
  RewriteInput.parse({
    text: MAIL,
    genre: 'email',
    lang: 'es',
    variety: 'rioplatense',
    mode: 'redaccion',
    profile: { cvMarkdown: read('prose-rewriter/evals/cases/cv/es-rioplatense.md') },
    recipient: { name: 'Martín', org: 'Agencia Nodo' },
    ...over,
  });

const diagnosis = {
  data: {
    purpose: { found: true, quote: 'buscan ayuda con WordPress', note: 'The agency is looking for WordPress help.' },
    readerNeed: { found: true, quote: 'ayuda con WordPress', note: 'A hand with WordPress.' },
    gaps: [{ afterSentenceId: 2, why: 'From passion to the agency with nothing between.' }],
    opening: { works: false, why: 'A stock wish.' },
    closing: { works: false, why: 'A stock closer.' },
    artificial: [{ sentenceId: 1, quote: 'Espero que estés muy bien', why: 'Stock opener.' }],
  },
};
const outline = (facts: Array<{ from: 'text' | 'cv' | 'recipient'; quote: string }> = [{ from: 'text', quote: 'tres sitios WordPress con copias semanales' }]) => ({
  data: {
    parts: [
      { role: 'opening', intent: 'Why she writes.', facts: [{ from: 'text', quote: 'buscan ayuda con WordPress' }] },
      { role: 'result', intent: 'What she does, tied to the agency.', facts },
      { role: 'next-step', intent: 'An easy next step.', facts: [] },
    ],
    drop: [1, 2, 5],
  },
});
const draft = (body: string) => ({ data: { body } });
const verdict = (rewritten: string) => ({ text: JSON.stringify({ lines: judgeLines(rewritten, 'es').map((l) => ({ line: l.line, support: 'no-claim', note: '' })), note: '' }) });

const tasksOf = (s: { calls: readonly { task: string }[] }) => s.calls.map((c) => c.task);
const sound = (i: RewriteInput, r: RewriteResult) => expect(factInvariant(i.text, r.rewritten, prepare(RewriteInput.parse(i)).sources, [], { lang: i.lang }).holds).toBe(true);

describe("rewrite() with strategy 'drafted'", () => {
  it('diagnoses, outlines and drafts the body, keeps the greeting and the signature, and ships it as one checked change', async () => {
    const expected = around(DRAFT);
    const scripted = scriptedGateway({ 'rewrite.diagnose': [diagnosis], 'rewrite.plan': [outline()], 'rewrite.edit': [draft(DRAFT)], 'rewrite.judge': [verdict(expected)] });
    const i = input();
    const result = await rewrite(i, { gateway: scripted.gateway, refs: REFS, userId: USER, strategy: 'drafted' });
    scripted.assertDone();
    expect(tasksOf(scripted)).toEqual(['rewrite.diagnose', 'rewrite.plan', 'rewrite.edit', 'rewrite.judge']);
    expect(scripted.calls.slice(0, 3).map((c) => c.request.promptVersion)).toEqual(['rewrite-diagnose@1', 'rewrite-outline@1', 'rewrite-draft@1']);
    expect(result.rewritten).toBe(expected);
    expect(result.status).toBe('ok');
    expect(result.changes).toEqual([expect.objectContaining({ id: 'd1', stage: 'edit', status: 'applied', before: BODY, after: DRAFT })]);
    expect(result.usage.calls).toBe(4);
    sound(i, result);
  });

  it('sends the draft the diagnosis and the outline as data, with the closing constraint and the check', async () => {
    const expected = around(DRAFT);
    const scripted = scriptedGateway({ 'rewrite.diagnose': [diagnosis], 'rewrite.plan': [outline()], 'rewrite.edit': [draft(DRAFT)], 'rewrite.judge': [verdict(expected)] });
    await rewrite(input(), { gateway: scripted.gateway, refs: REFS, userId: USER, strategy: 'drafted' });
    const task = String(scripted.calls[2]?.request.messages[0]?.content);
    expect(task).toMatch(/^TASK: draft/);
    expect(task).toContain('70 to 170 words');
    expect(task).toMatch(/Do not add an introduction, a generic closing or self-praising adjectives\. End on the next step\./);
    expect(task).toMatch(/Before answering, check: the first sentence says why/);
    expect(task).toMatch(/DIAGNOSIS[^\n]*\n<texto>\n[\s\S]*purpose: «buscan ayuda con WordPress»/);
    expect(task).toMatch(/OUTLINE[^\n]*\n<texto>\n1\. opening: Why she writes\./);
  });

  it('leaves out of the draft prompt an outline fact whose quote is not in its source', async () => {
    const expected = around(DRAFT);
    const scripted = scriptedGateway({
      'rewrite.diagnose': [diagnosis],
      'rewrite.plan': [outline([{ from: 'cv', quote: 'diez años en Google' }, { from: 'text', quote: 'tres sitios WordPress con copias semanales' }])],
      'rewrite.edit': [draft(DRAFT)],
      'rewrite.judge': [verdict(expected)],
    });
    await rewrite(input(), { gateway: scripted.gateway, refs: REFS, userId: USER, strategy: 'drafted' });
    const task = String(scripted.calls[2]?.request.messages[0]?.content);
    expect(task).not.toContain('diez años en Google');
    expect(task).toContain('«tres sitios WordPress con copias semanales» (text)');
  });

  it('takes out a draft sentence that states a fact neither the text nor the CV states, and says so', async () => {
    const inventing = DRAFT.replace('y me gustaría darles una mano.', 'y me gustaría darles una mano. Trabajé ocho años en Mercado Libre.');
    const expected = around(DRAFT);
    const scripted = scriptedGateway({ 'rewrite.diagnose': [diagnosis], 'rewrite.plan': [outline()], 'rewrite.edit': [draft(inventing)], 'rewrite.judge': [verdict(expected)] });
    const i = input();
    const result = await rewrite(i, { gateway: scripted.gateway, refs: REFS, userId: USER, strategy: 'drafted' });
    expect(result.rewritten).toBe(expected);
    expect(result.changes[0]?.reason).toMatch(/1 sentence\(s\) of the draft taken out/);
    sound(i, result);
  });

  it('falls back to single when the draft loses a fact of the text, and reports the draft as reverted', async () => {
    const losing = DRAFT.replace('Hoy mantengo tres sitios WordPress con copias semanales y actualizaciones mensuales. ', '');
    const fixed = MAIL.replace('Espero que estés muy bien. ', '');
    const scripted = scriptedGateway({
      'rewrite.diagnose': [diagnosis],
      'rewrite.plan': [outline()],
      'rewrite.edit': [draft(losing), { data: { edits: [{ sentenceId: 1, before: 'Espero que estés muy bien.', after: '', reason: 'stock opener' }] } }],
      'rewrite.judge': [verdict(fixed)],
    });
    const i = input();
    const result = await rewrite(i, { gateway: scripted.gateway, refs: REFS, userId: USER, strategy: 'drafted' });
    scripted.assertDone();
    expect(tasksOf(scripted)).toEqual(['rewrite.diagnose', 'rewrite.plan', 'rewrite.edit', 'rewrite.edit', 'rewrite.judge']);
    expect(result.rewritten).toBe(fixed);
    expect(result.changes[0]).toMatchObject({ id: 'd1', status: 'reverted', revertReason: expect.stringMatching(/^facts: [\s\S]*; the single strategy rewrote the text instead$/) });
    expect(result.changes.slice(1).map((c) => c.status)).toEqual(['applied']);
    expect(result.usage.calls).toBe(5);
    sound(i, result);
  });

  it('falls back to single, with no draft change, when the diagnosis cannot be read', async () => {
    const bad = { data: { purpose: 'unreadable' } };
    const fixed = MAIL.replace('Espero que estés muy bien. ', '');
    const scripted = scriptedGateway({
      'rewrite.diagnose': [bad, bad],
      'rewrite.edit': [{ data: { edits: [{ sentenceId: 1, before: 'Espero que estés muy bien.', after: '', reason: 'stock opener' }] } }],
      'rewrite.judge': [verdict(fixed)],
    });
    const result = await rewrite(input(), { gateway: scripted.gateway, refs: REFS, userId: USER, strategy: 'drafted' });
    scripted.assertDone();
    expect(result.rewritten).toBe(fixed);
    expect(result.changes.map((c) => c.id)).not.toContain('d1');
  });

  it('is single outside redaccion and with keep phrases', async () => {
    for (const over of [{ mode: 'pulido' as const }, { keep: ['Quedo a tu entera disposición.'] }]) {
      const fixed = MAIL.replace('Espero que estés muy bien. ', '');
      const scripted = scriptedGateway({
        'rewrite.edit': [{ data: { edits: [{ sentenceId: 1, before: 'Espero que estés muy bien.', after: '', reason: 'stock opener' }] } }],
        'rewrite.judge': [verdict(fixed)],
      });
      await rewrite(input(over), { gateway: scripted.gateway, refs: REFS, userId: USER, strategy: 'drafted' });
      scripted.assertDone();
      expect(tasksOf(scripted)).toEqual(['rewrite.edit', 'rewrite.judge']);
    }
  });
});
