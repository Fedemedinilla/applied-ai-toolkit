// The fact check of design 4.6, in code: extract, the inventory of the original against the CV,
// the per-edit rules and the invariant O ⊆ R ⊆ O ∪ C. Every text is fictional: Valeria Sosa Pereyra
// and Daniel Okoro are the fictional CVs of evals/cases/cv/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEdit, extract, factInvariant, factReport, inventory, placeholders, type FactSources } from '../src/facts.ts';
import { specifics } from '../src/specifics.ts';
import { FactReport } from '../src/types.ts';

const CV_DIR = join(import.meta.dirname, '..', 'evals', 'cases', 'cv');
const CV_ES = readFileSync(join(CV_DIR, 'es-rioplatense.md'), 'utf8');
const CV_EN = readFileSync(join(CV_DIR, 'en.md'), 'utf8');
const ES = { lang: 'es' } as const;
const EN = { lang: 'en' } as const;
const keys = (text: string, opts: Parameters<typeof extract>[1] = ES) => extract(text, opts).map((f) => f.key);
const C_ES: FactSources = { cv: CV_ES, recipient: ['Marta', 'Imprenta Del Sur'] };

describe('extract', () => {
  it('reads numbers, a date, a time, an amount, an email and a URL, normalized', () => {
    const text = 'Migré los mails de 12 personas el 3/11/2026 a las 15:00 por US$ 1.200; escribime a valeria.sosa@cv.example o https://valeria-sosa.example.';
    expect(keys(text)).toEqual(['12', '2026-11-03', '15:00', 'USD 1200', 'valeria.sosa@cv.example', 'https://valeria-sosa.example']);
  });

  it('keeps the unit with the number, the same in both languages', () => {
    expect(keys('La página pasó de 4,1 s a 1,6 s y ahorra 30 horas.')).toEqual(['4.1 s', '1.6 s', '30 h']);
    expect(keys('Cut the reply from 9 hours to 3 hours; searches fell from 31% to 22%.', EN)).toEqual(['9 h', '3 h', '31%', '22%']);
  });

  it('reads one date however it is written, and a number word as its number', () => {
    expect(keys('El 3 de noviembre de 2026 lo vemos.')).toEqual(['2026-11-03']);
    expect(keys('We meet on November 3, 2026.', EN)).toEqual(['2026-11-03']);
    expect(keys('Desde marzo de 2023 y desde June 2022.')).toEqual(['2023-03', '2022-06']);
    expect(keys('Mantengo tres sitios WordPress.')).toEqual(['3', 'wordpress']);
    expect(keys('Over six months.', EN)).toEqual(['6 mo']);
  });

  it('reads proper nouns, acronyms, tools and the profile anchors', () => {
    const facts = extract('Armé para la Ferretería Quintana un formulario con Supabase, SQL y n8n.', ES);
    expect(facts.map((f) => [f.kind, f.key])).toEqual([
      ['proper-noun', 'ferretería'],
      ['proper-noun', 'quintana'],
      ['proper-noun', 'supabase'],
      ['acronym', 'sql'],
      ['tool', 'n8n'],
    ]);
    expect(keys('Uso GPT-4, S3 y 2FA, no 6s.')).toEqual(['gpt-4', 's3', '2fa', '6 s']);
    expect(extract('Armo tableros en Power BI.', { lang: 'es', anchors: ['Power BI'] }).map((f) => [f.kind, f.key])).toEqual([['anchor', 'power bi']]);
  });

  it('reads a phone as its digits', () => {
    expect(keys('Llamame al +54 9 351 0000-0000.')).toEqual(['tel:+54935100000000']);
  });

  it('never reads a placeholder as a fact, and lists it apart', () => {
    const text = 'Recibe [COMPLETAR: 15 pedidos por semana, a las 9:30] desde Astro.';
    expect(keys(text)).toEqual(['astro']);
    expect(placeholders(text)).toEqual(['[COMPLETAR: 15 pedidos por semana, a las 9:30]']);
  });

  it('covers every specific the copy of specifics() reads', () => {
    const text = 'Llego a las 8:30, cobro 1.200 por 3 horas; info en www.sitio.example y hola@sitio.example.';
    const facts = extract(text, ES);
    for (const s of specifics(text)) {
      const at = text.indexOf(s.text);
      expect(facts.some((f) => f.start <= at && at + s.text.length <= f.end), s.text).toBe(true);
    }
  });
});

describe('inventory', () => {
  it('labels each fact of the original and flags what is not in the CV', () => {
    const O = 'Hola Marta, armé el formulario de la Ferretería Quintana: recibe 40 pedidos por semana y lo usan 25 personas.';
    const { facts, flags } = inventory(O, C_ES, ES);
    expect(facts.map((f) => [f.key, f.label])).toEqual([
      ['marta', 'del-destinatario'],
      ['ferretería', 'en-cv'],
      ['quintana', 'en-cv'],
      ['40', 'en-cv'],
      ['25', 'solo-del-usuario'],
    ]);
    expect(flags).toEqual([{ kind: 'not-in-cv', span: { start: O.indexOf('25'), end: O.indexOf('25') + 2 }, message: 'Tu texto dice «25»; no figura en tu CV.' }]);
  });

  it('writes the flag in English for an English text', () => {
    const { flags } = inventory('At Brightwell Parcels I wrote 80 help articles.', { cv: CV_EN }, EN);
    expect(flags.map((f) => f.message)).toEqual(['Your text says "80"; it is not in your CV.']);
  });
});

describe('checkEdit', () => {
  const O = 'Migré los mails de 12 personas a un dominio propio. Armé un formulario que recibe muchos pedidos. Contoso me pidió el sitio.';
  const sentences = ['Migré los mails de 12 personas a un dominio propio.', 'Armé un formulario que recibe muchos pedidos.', 'Contoso me pidió el sitio.'];
  const ctx = { O, C: C_ES, sentences, lang: 'es' } as const;
  const edit = (sentenceId: number, before: string, after: string, drop?: boolean) => ({ sentenceId, before, after, reason: 'test', ...(drop === undefined ? {} : { drop }) });

  it('reverts an edit that invents a fact', () => {
    const r = checkEdit(edit(1, 'muchos pedidos', '70 pedidos'), ctx);
    expect(r).toMatchObject({ status: 'reverted', reason: 'invented' });
    expect(r.status === 'reverted' && r.facts.map((f) => f.key)).toEqual(['70']);
  });

  it('always reverts a changed number, even with drop and even when the CV holds the new one', () => {
    const withFifteen = { ...ctx, C: { ...C_ES, extraFacts: ['Migré 15 personas.'] } };
    expect(checkEdit(edit(0, '12 personas', '15 personas'), ctx)).toMatchObject({ status: 'reverted', reason: 'changed-number' });
    expect(checkEdit(edit(0, '12 personas', '15 personas', true), withFifteen)).toMatchObject({ status: 'reverted', reason: 'changed-number' });
  });

  it('reverts an edit that loses a fact without drop', () => {
    expect(checkEdit(edit(0, 'de 12 personas', 'del equipo'), ctx)).toMatchObject({ status: 'reverted', reason: 'lost' });
  });

  it('accepts a drop only when the fact stays in another sentence', () => {
    expect(checkEdit(edit(0, 'de 12 personas', 'del equipo', true), ctx)).toMatchObject({ status: 'reverted', reason: 'drop-not-elsewhere' });
    const twice = { ...ctx, sentences: [...sentences, 'Eran 12 personas.'] };
    const r = checkEdit(edit(0, 'de 12 personas', 'del equipo', true), twice);
    expect(r.status).toBe('accepted');
    expect(r.status === 'accepted' && r.dropped.map((f) => f.key)).toEqual(['12']);
  });

  it('accepts a fact from the CV that the original lacks, and reports it in fromCv', () => {
    const r = checkEdit(edit(1, 'muchos pedidos', 'unos 40 pedidos por semana'), ctx);
    expect(r.status).toBe('accepted');
    expect(r.status === 'accepted' && r.fromCv.map((f) => f.key)).toEqual(['40']);
  });

  it('accepts a placeholder, whatever its label says', () => {
    expect(checkEdit(edit(1, 'muchos pedidos', '[COMPLETAR: 70 pedidos por semana]'), ctx)).toMatchObject({ status: 'accepted', fromCv: [], dropped: [] });
  });

  it('does not lose a name that moves to the start of its sentence', () => {
    expect(checkEdit(edit(2, 'Contoso me pidió el sitio', 'El sitio me lo pidió Contoso'), ctx).status).toBe('accepted');
  });

  it('reverts an edit whose before is not in its sentence', () => {
    expect(checkEdit(edit(1, 'pocos pedidos', '40 pedidos'), ctx)).toMatchObject({ status: 'reverted', reason: 'not-found' });
  });
});

describe('factInvariant', () => {
  const O = 'Migré los mails de 12 personas. Armé un formulario que recibe muchos pedidos.';

  it('holds on accepted edits: the original facts kept, the new ones from the CV', () => {
    const R = 'Migré los mails de 12 personas. Armé un formulario que recibe unos 40 pedidos por semana.';
    expect(factInvariant(O, R, C_ES, [], ES)).toEqual({ holds: true, missing: [], extra: [] });
  });

  it('fails with the list of differences otherwise', () => {
    const R = 'Migré los mails del equipo. Armé un formulario que recibe 70 pedidos.';
    const result = factInvariant(O, R, C_ES, [], ES);
    expect(result.holds).toBe(false);
    expect(result.missing.map((f) => f.key)).toEqual(['12']);
    expect(result.extra.map((f) => f.key)).toEqual(['70']);
  });

  it('lets an accepted drop go missing', () => {
    const R = 'Migré los mails del equipo. Armé un formulario que recibe muchos pedidos.';
    expect(factInvariant(O, R, C_ES, ['12'], ES).holds).toBe(true);
  });
});

describe('factReport', () => {
  it('builds the FactReport of the contract', () => {
    const O = 'Hola Marta, migré los mails de 12 personas y lo usan 25 personas. Recibe muchos pedidos.';
    const R = 'Hola Marta, migré los mails de 12 personas. Recibe unos 40 pedidos [COMPLETAR: desde cuándo].';
    const report = factReport(O, R, C_ES, ES);
    expect(FactReport.parse(report)).toEqual({
      kept: ['marta', '12'],
      dropped: ['25'],
      added: [],
      fromCv: ['40'],
      notInCv: ['25'],
      placeholders: ['[COMPLETAR: desde cuándo]'],
    });
  });
});
