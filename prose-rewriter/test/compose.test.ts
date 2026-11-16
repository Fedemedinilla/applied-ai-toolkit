// F6b: S4 composes with S3 (design 4.4: S3 edits, then S4 styles). The first real-model eval run
// refused the style edits on every sentence S3 had edited ("the edit overlaps #N, accepted before
// it": full 45, no-examples 39, edit-sonnet 44). The texts and replies below are the run's own,
// from the fictional eval cases (evals/cases/), replayed over the scripted gateway.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import { loadCases } from '../evals/cases.ts';
import { splitSentences } from '../src/edits.ts';
import { factInvariant } from '../src/facts.ts';
import type { PromptRefs } from '../src/prompt.ts';
import { rewrite } from '../src/rewrite.ts';
import { judgeLines } from '../src/rubric.ts';
import { prepare } from '../src/stages/analyse.ts';
import { RewriteInput, type RewriteResult } from '../src/types.ts';
import { scriptedGateway, type ScriptedReply } from './scripted-gateway.ts';

const ROOT = new URL('../../', import.meta.url);
const json = (file: string): unknown[] => JSON.parse(readFileSync(new URL(file, ROOT), 'utf8')) as unknown[];
const REFS: PromptRefs = {
  sources: json('style-refs/sources.json').map((s) => Source.parse(s)),
  principles: LANGS.flatMap((lang) => json(`style-refs/principles/${lang}.json`).map((p) => Principle.parse(p))),
  examples: LANGS.flatMap((lang) => json(`style-refs/examples/${lang}.json`).map((e) => Example.parse(e))),
};
const CASES = loadCases(ROOT);
const input = (id: string): RewriteInput => {
  const c = CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c.input;
};

interface Proposed {
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  readonly ruleId?: string;
  readonly principleId?: string;
}

/** The sentenceId of the sentence of `text` that holds `before`, as the model named it. */
function at(text: string, lang: 'es' | 'en', before: string): number {
  const id = splitSentences(text, lang).findIndex((s) => s.text.includes(before));
  if (id < 0) throw new Error(`"${before}" is in no sentence`);
  return id;
}
const reply = (text: string, lang: 'es' | 'en', list: readonly Proposed[]): ScriptedReply => ({
  data: { edits: list.map((e) => ({ sentenceId: at(text, lang, e.before), ...e })) },
});
const plan = (n: number): ScriptedReply => ({
  data: { items: Array.from({ length: n }, (_, sentenceId) => ({ sentenceId, action: 'remove-formula', reason: 'set phrase' })) },
});
const verdict = (rewritten: string, lang: 'es' | 'en'): ScriptedReply => ({
  text: JSON.stringify({ lines: judgeLines(rewritten, lang).map((l) => ({ line: l.line, support: 'no-claim', note: '' })), note: '' }),
});

/** Every result: O ⊆ R ⊆ O ∪ C, and the diff applied to O gives R. */
function expectSound(i: RewriteInput, result: RewriteResult): void {
  const sources = prepare(RewriteInput.parse(i)).sources;
  expect(factInvariant(i.text, result.rewritten, sources, [], { lang: i.lang }).holds).toBe(true);
  let text = i.text;
  for (const h of [...result.diff].sort((a, b) => b.span.start - a.span.start)) text = text.slice(0, h.span.start) + h.after + text.slice(h.span.end);
  expect(text).toBe(result.rewritten);
}

// es-email-heavy, run "full": S3's six edits and S4's five, verbatim.
const ES_S3: Proposed[] = [
  { before: 'Propuesta de valor para potenciar su presencia digital', after: 'Mantenimiento de sitios WordPress [COMPLETAR: qué le pedís u ofrecés concretamente a Martín]', reason: "El asunto era una fórmula y trataba de 'su' a quien después se vosea; ahora dice de qué trata el mail con el dato del CV y deja marcado lo que falta.", ruleId: 'es-plain-exact-words', principleId: 'es-plain-exact-words' },
  { before: 'Espero que este mensaje te encuentre muy bien.', after: '', reason: 'Fórmula de apertura que no le da nada al lector y demora el motivo del mail.', ruleId: 'es-only-what-moves-the-reader', principleId: 'es-only-what-moves-the-reader' },
  { before: 'Me pongo en contacto con vos porque me apasiona aportar valor agregado y potenciar sinergias en un mundo cada vez más digital.', after: 'Te escribo para [COMPLETAR: qué querés ofrecerle o preguntarle a la Cooperativa La Huella]; desde marzo de 2023 trabajo por cuenta propia como desarrolladora web.', reason: 'Frases de plantilla que no dicen para qué escribe; va el motivo concreto (a completar) apoyado en un dato del CV.', ruleId: 'LEX-01', principleId: 'es-lead-with-the-point' },
  { before: 'Soy una profesional proactiva y orientada a resultados.', after: '', reason: 'Adjetivos de carácter sin un hecho que los respalde; la oración siguiente ya da el dato concreto.', ruleId: 'ESP-04', principleId: 'es-adjective-only-with-a-fact' },
  { before: 'Sin lugar a dudas, puedo llevar el sitio de la cooperativa al siguiente nivel.', after: 'Rehice el sitio de la Panadería Los Álamos en Astro: la página principal pasó de 4,1 s a 1,6 s de carga en un celular de gama baja. [COMPLETAR: qué harías concretamente en el sitio de la cooperativa, si lo viste y sabés qué necesita]', reason: 'Promesa vacía sobre un sitio del que no hay datos; se cambia por un resultado medido del CV, sin prometer nada sobre el sitio de la cooperativa.', ruleId: 'es-plain-exact-words', principleId: 'es-plain-exact-words' },
  { before: 'Quedo a tu entera disposición ante cualquier consulta.', after: '[COMPLETAR: qué paso siguiente proponés, por ejemplo una llamada y qué días podés]', reason: 'Cierre de plantilla; el final tiene que dejar un paso concreto, que solo vos podés definir.', ruleId: 'LEX-01', principleId: 'es-know-the-end-first' },
];
const ES_S4: Proposed[] = [
  { before: 'Espero que este mensaje te encuentre muy bien.', after: '', reason: 'Es una fórmula de cortesía que no le dice nada a Martín y demora el motivo del mail.', principleId: 'es-only-what-moves-the-reader' },
  { before: 'Me pongo en contacto con vos porque me apasiona aportar valor agregado y potenciar sinergias en un mundo cada vez más digital.', after: 'Te escribo porque [COMPLETAR: qué le proponés o le preguntás a Martín sobre el sitio de la cooperativa].', reason: 'La oración no dice qué pedís ni qué ofrecés. El motivo concreto tiene que ir acá, al principio, y solo vos lo sabés.', principleId: 'es-lead-with-the-point' },
  { before: 'Soy una profesional proactiva y orientada a resultados.', after: 'Soy desarrolladora web y trabajo por cuenta propia desde marzo de 2023.', reason: '"Proactiva" y "orientada a resultados" no aportan ningún dato. Tu CV sí: a qué te dedicás y desde cuándo.', principleId: 'es-adjective-only-with-a-fact' },
  { before: 'Sin lugar a dudas, puedo llevar el sitio de la cooperativa al siguiente nivel.', after: 'En el sitio de la cooperativa puedo [COMPLETAR: qué trabajo concreto harías].', reason: '"Llevar al siguiente nivel" no dice qué harías, y "sin lugar a dudas" promete sin respaldo. Falta nombrar el trabajo concreto.', principleId: 'es-plain-exact-words' },
  { before: 'Quedo a tu entera disposición ante cualquier consulta.', after: 'Si te interesa, lo hablamos cuando puedas.', reason: 'Es una fórmula hecha. El cierre pesa más si propone un paso siguiente, dicho como se lo dirías en persona.', principleId: 'es-say-it-as-you-would-tell-it' },
];

// en-follow-up-light, run "full": S3's two edits, verbatim.
const EN_S3: Proposed[] = [
  { before: 'I just wanted to follow up on the proposal I sent for your help desk, a project I am passionate about.', after: 'On [COMPLETAR: the day you sent the proposal to Tom] I sent you my proposal for setting up your help desk.', reason: 'Removes the throat-clearing opener and the stock phrase about passion, which carry no fact, and leads with the proposal. The day it was sent is not in the text or the CV, so it is left for the writer to fill in.', ruleId: 'LEX-03', principleId: 'en-lead-with-the-point' },
  { before: 'Please let me know if you have any questions.', after: 'Could you tell me [COMPLETAR: what you want Tom to decide or answer about the proposal, for example a start date or a call]?', reason: 'The stock closing asks nothing. A direct question gives Tom something to answer; the exact decision the writer wants is not stated, so it is left to fill in.', ruleId: 'en-specific-concrete', principleId: 'en-specific-concrete' },
];
const EN_S3_TEXT = 'On [COMPLETAR: the day you sent the proposal to Tom] I sent you my proposal for setting up your help desk.';

describe('S4 after S3 (F6b eval run)', () => {
  it('es-email-heavy: a style edit on a sentence whose S3 edit was reverted is placed, not refused as an overlap', async () => {
    const i = input('es-email-heavy');
    const style = ES_S4[1] as Proposed;
    // S3's third edit is reverted (voice: the run's "adds usted"); S4's rewrite of that sentence then
    // stands on the sentence as the user wrote it. The other style edits quote text S3 removed or
    // rewrote, so they no longer apply.
    const expected = i.text
      .replace((ES_S3[1] as Proposed).before, '')
      .replace(style.before, style.after)
      .replace((ES_S3[3] as Proposed).before, '')
      .replace((ES_S3[4] as Proposed).before, (ES_S3[4] as Proposed).after)
      .replace((ES_S3[5] as Proposed).before, (ES_S3[5] as Proposed).after);
    const scripted = scriptedGateway({
      'rewrite.plan': [plan(10)],
      'rewrite.edit': [reply(i.text, 'es', ES_S3)],
      'rewrite.style': [reply(i.text, 'es', ES_S4)],
      'rewrite.judge': [verdict(expected, 'es')],
    });
    const result = await rewrite(i, { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    expect(result.changes.find((c) => c.stage === 'style' && c.after === style.after)).toMatchObject({ status: 'applied' });
    expect(result.changes.filter((c) => /overlaps/.test(c.revertReason ?? ''))).toEqual([]);
    expect(result.rewritten).toBe(expected);
    expectSound(i, result);
  });

  it('en-follow-up-light: S4 reads the text S3 left, and its edit on S3\'s sentence composes into one edit', async () => {
    const i = input('en-follow-up-light');
    const s3 = EN_S3[0] as Proposed;
    const styled = 'I sent you my proposal for setting up your help desk on [COMPLETAR: the day you sent the proposal to Tom].';
    const expected = i.text.replace(s3.before, styled).replace((EN_S3[1] as Proposed).before, (EN_S3[1] as Proposed).after);
    const scripted = scriptedGateway({
      'rewrite.plan': [plan(4)],
      'rewrite.edit': [reply(i.text, 'en', EN_S3)],
      // Quotes S3's text: the sentence as the edit step left it.
      'rewrite.style': [{ data: { edits: [{ sentenceId: at(i.text, 'en', s3.before), before: EN_S3_TEXT, after: styled, reason: 'Lead with the proposal, not the date.', principleId: 'en-lead-with-the-point' }] } }],
      'rewrite.judge': [verdict(expected, 'en')],
    });
    const result = await rewrite(i, { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    const stylePrompt = JSON.stringify(scripted.calls.find((c) => c.task === 'rewrite.style')?.request.messages);
    expect(stylePrompt).toContain(EN_S3_TEXT);
    expect(stylePrompt).not.toContain('I just wanted to follow up');
    expect(result.rewritten).toBe(expected);
    // One change carries the sentence from the original to its final text, and every check ran on it.
    expect(result.changes.find((c) => c.status === 'applied' && c.stage === 'style')).toMatchObject({ before: s3.before, after: styled });
    expect(result.changes.find((c) => c.stage === 'edit' && c.after === s3.after)).toMatchObject({ status: 'reverted', revertReason: expect.stringMatching(/merged into/) });
    expect(result.diff.map((h) => h.before)).toEqual([s3.before, (EN_S3[1] as Proposed).before]);
    expectSound(i, result);
  });

  it('en-follow-up-light: a composed edit that invents a fact is reverted and the S3 edit it held comes back', async () => {
    const i = input('en-follow-up-light');
    const s3 = EN_S3[0] as Proposed;
    const expected = i.text.replace(s3.before, s3.after).replace((EN_S3[1] as Proposed).before, (EN_S3[1] as Proposed).after);
    const scripted = scriptedGateway({
      'rewrite.plan': [plan(4)],
      'rewrite.edit': [reply(i.text, 'en', EN_S3)],
      'rewrite.style': [{ data: { edits: [{ sentenceId: at(i.text, 'en', s3.before), before: 'your help desk', after: 'your Freshdesk help desk', reason: 'Name the tool.', principleId: 'en-specific-concrete' }] } }],
      'rewrite.judge': [verdict(expected, 'en')],
    });
    const result = await rewrite(i, { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    expect(result.rewritten).toBe(expected);
    expect(result.changes.find((c) => c.stage === 'style')).toMatchObject({ status: 'reverted', revertReason: expect.stringMatching(/Freshdesk/) });
    expect(result.changes.find((c) => c.stage === 'edit' && c.after === s3.after)).toMatchObject({ status: 'applied' });
    expectSound(i, result);
  });

  it('keeps refusing two style edits that truly overlap each other', async () => {
    const i = input('en-follow-up-light');
    const s3 = EN_S3[0] as Proposed;
    const id = at(i.text, 'en', s3.before);
    const first = 'I sent you my proposal for setting up your help desk on [COMPLETAR: the day you sent the proposal to Tom].';
    const expected = i.text.replace(s3.before, first).replace((EN_S3[1] as Proposed).before, (EN_S3[1] as Proposed).after);
    const scripted = scriptedGateway({
      'rewrite.plan': [plan(4)],
      'rewrite.edit': [reply(i.text, 'en', EN_S3)],
      'rewrite.style': [
        {
          data: {
            edits: [
              { sentenceId: id, before: EN_S3_TEXT, after: first, reason: 'Lead with the proposal.', principleId: 'en-lead-with-the-point' },
              { sentenceId: id, before: 'my proposal for setting up', after: 'the proposal to set up', reason: 'Shorter.', principleId: 'en-omit-needless-words' },
            ],
          },
        },
      ],
      'rewrite.judge': [verdict(expected, 'en')],
    });
    const result = await rewrite(i, { gateway: scripted.gateway, refs: REFS });
    scripted.assertDone();
    expect(result.rewritten).toBe(expected);
    expect(result.changes.find((c) => c.stage === 'style' && c.after === 'the proposal to set up')).toMatchObject({ status: 'reverted', revertReason: expect.stringMatching(/overlaps/) });
    expectSound(i, result);
  });
});
