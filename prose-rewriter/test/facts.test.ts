// The fact check of design 4.6, in code: extract, the inventory of the original against the CV,
// the per-edit rules and the invariant O ⊆ R ⊆ O ∪ C. Every text is fictional: Valeria Sosa Pereyra
// and Daniel Okoro are the fictional CVs of evals/cases/cv/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalNumber, checkEdit, extract, factInvariant, factReport, inventory, placeholders, type FactSources } from '../src/facts.ts';
import { splitSentences } from '../src/edits.ts';
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

describe('numbers written in words', () => {
  it('reads every number word, compounds included, as its number', () => {
    expect(keys('Atiendo veinticinco clientes, trece sitios y dieciséis tiendas.')).toEqual(['25', '13', '16']);
    expect(keys('Son sesenta, doscientos y treinta y cinco.')).toEqual(['60', '200', '35']);
    expect(keys('Cobré mil quinientos y luego dos mil trescientos cuarenta.')).toEqual(['1500', '2340']);
    expect(keys('Took twenty-five calls, thirteen tickets and two hundred and five emails over fifteen hundred days.', EN)).toEqual(['25', '13', '205', '1500 d']);
    // Separate numbers stay separate; "un", "una" and "one" are articles unless a multiplier follows.
    expect(keys('Tengo dos, tres o cuatro. Una idea y un millón de gracias.')).toEqual(['2', '3', '4', '1000000']);
  });

  it('reverts a change between number words', () => {
    const O = 'Atiendo veinticinco clientes.';
    expect(checkEdit({ sentenceId: 0, before: 'veinticinco', after: 'sesenta', reason: 'test' }, { O, C: { cv: '' }, sentences: [O], lang: 'es' })).toMatchObject({ status: 'reverted', reason: 'changed-number' });
  });

  it('accepts a number rewritten between digits and words', () => {
    const accepts = (O: string, before: string, after: string) =>
      checkEdit({ sentenceId: 0, before, after, reason: 'test' }, { O, C: { cv: '' }, sentences: [O], lang: 'es' }).status;
    expect(accepts('Cobro dos mil pesos.', 'dos mil pesos', '2.000 pesos')).toBe('accepted');
    expect(accepts('Cobro 2.000 pesos.', '2.000 pesos', 'dos mil pesos')).toBe('accepted');
    expect(accepts('Son 1.500 por mes.', '1.500', 'mil quinientos')).toBe('accepted');
    expect(accepts('Bajó un 10% el rebote.', '10%', 'diez por ciento')).toBe('accepted');
    expect(accepts('Llego a las 15:00.', '15:00', '15 h')).toBe('accepted');
    expect(keys('Trabajé 15 h seguidas.')).toEqual(['15 h']);
  });
});

describe('magnitudes, hours and days', () => {
  const change = (O: string, before: string, after: string, lang: 'es' | 'en' = 'es') =>
    checkEdit({ sentenceId: 0, before, after, reason: 'test' }, { O, C: { cv: '' }, sentences: [O], lang });

  it('keeps the magnitude word or letter with its number', () => {
    expect(keys('Facturó 1,2 millones y luego 3 mil.')).toEqual(['1200000', '3000']);
    expect(keys('Raised USD 1.2k and then USD 1.2M; 2.5 billion users.', EN)).toEqual(['USD 1200', 'USD 1200000', '2500000000']);
    expect(keys('Recaudó dos millones de dólares.')).toEqual(['USD 2000000']);
    expect(change('Facturó 1,2 millones.', 'millones', 'billones')).toMatchObject({ status: 'reverted', reason: 'changed-number' });
    expect(change('Raised USD 1.2k.', '1.2k', '1.2M', 'en')).toMatchObject({ status: 'reverted', reason: 'changed-number' });
  });

  it('reads am and pm on a whole hour', () => {
    expect(keys('Meet at 9 am or at 9 pm, or 3 p.m.', EN)).toEqual(['9:00', '21:00', '15:00']);
    expect(change('Meet at 9 am.', '9 am', '9 pm', 'en')).toMatchObject({ status: 'reverted', reason: 'changed-number' });
  });

  it('reads a weekday or a month alone as a date', () => {
    expect(keys('Nos vemos el lunes y arranco en marzo.')).toEqual(['weekday:1', '--03']);
    expect(keys('We meet on Monday and I start in May.', EN)).toEqual(['weekday:1', '--05']);
    expect(keys('May I send it on Friday?', EN)).toEqual(['weekday:5']);
    expect(change('We meet on Monday.', 'Monday', 'Friday', 'en')).toMatchObject({ status: 'reverted', reason: 'changed-number' });
    expect(change('Arranco en marzo.', 'marzo', 'abril')).toMatchObject({ status: 'reverted', reason: 'changed-number' });
    expect(factInvariant('Nos vemos el lunes.', 'Nos vemos el viernes.', { cv: '' }, [], ES).holds).toBe(false);
  });
});

describe('phones, lists and fractions', () => {
  const accepts = (O: string, before: string, after: string) =>
    checkEdit({ sentenceId: 0, before, after, reason: 'test' }, { O, C: { cv: '' }, sentences: [O], lang: 'es' }).status;

  it('does not read a list of numbers or a date and a count as a phone', () => {
    expect(keys('Talles 36 38 40 42 44.')).toEqual(['36', '38', '40', '42', '44']);
    expect(keys('Desde el 2026-11-03 15 personas.')).toEqual(['2026-11-03', '15']);
    expect(keys('Trabajé 2018-2020-2022.')).toEqual(['2018', '2020', '2022']);
    expect(accepts('Desde el 2026-11-03 trabajo así.', '2026-11-03', '3/11/2026')).toBe('accepted');
    expect(accepts('Talles 36 38 40 42 44.', '36 38 40 42 44', '36, 38, 40, 42 y 44')).toBe('accepted');
  });

  it('still reads the phones people write', () => {
    expect(keys('Llamá al 351 000-0000 o al (011) 4444-5555, o al 3510000000.')).toEqual(['tel:3510000000', 'tel:01144445555', 'tel:3510000000']);
    expect(keys('Not a phone: 12345678.', EN)).toEqual(['12345678']);
  });

  it('reads 24/7 and a fraction as numbers, and a day and month as a date', () => {
    expect(keys('Atención 24/7 y 1/2 kilo de pan.')).toEqual(['24/7', '1/2']);
    expect(keys('Lo entrego el 3/4 y el 3/11.')).toEqual(['--04-03', '--11-03']);
  });
});

describe('canonicalNumber and the language-dependent readings', () => {
  it('reads separators by language, as its docstring says', () => {
    expect(canonicalNumber('1.200', 'es')).toBe('1200');
    expect(canonicalNumber('1,200', 'en')).toBe('1200');
    expect(canonicalNumber('1,200', 'es')).toBe('1.2');
    expect(canonicalNumber('1.200', 'en')).toBe('1.2');
    expect(canonicalNumber('4,1', 'es')).toBe('4.1');
    expect(canonicalNumber('4.1', 'en')).toBe('4.1');
    expect(canonicalNumber('1.234.567,5', 'es')).toBe('1234567.5');
  });

  it('drops leading and trailing zeros', () => {
    expect(canonicalNumber('007', 'es')).toBe('7');
    expect(canonicalNumber('4,10', 'es')).toBe('4.1');
    expect(canonicalNumber('2.50', 'en')).toBe('2.5');
  });

  it('reads a numeric date day first in Spanish and month first in English', () => {
    expect(keys('Nos vemos el 3/11/2026.')).toEqual(['2026-11-03']);
    expect(keys('We meet on 11/3/2026.', EN)).toEqual(['2026-11-03']);
  });

  it('needs 9 digits for a phone and an hour of 23 or less for "hs"', () => {
    expect(keys('Not a phone: 1234 5678.', EN)).toEqual(['1234', '5678']);
    expect(keys('Llego a las 18 hs; son 25 hs de viaje.')).toEqual(['18:00', '25']);
  });
});

describe('checkEdit fromCv', () => {
  it('leaves out a fact the original already states in another sentence', () => {
    const sentences = ['Migré los mails de 12 personas.', 'Armé un formulario que recibe muchos pedidos.'];
    const ctx = { O: sentences.join(' '), C: C_ES, sentences, lang: 'es' } as const;
    const r = checkEdit({ sentenceId: 1, before: 'muchos pedidos', after: 'pedidos de 12 personas y unos 40 por semana', reason: 'test' }, ctx);
    expect(r.status).toBe('accepted');
    expect(r.status === 'accepted' && r.fromCv.map((f) => f.key)).toEqual(['40']);
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

describe('names at the start of a sentence', () => {
  // extractAnchors skips a sentence's first word, so a name there needs its own reading: a name
  // known from elsewhere in O, C or the sentence is a name there too, and an unknown capitalized
  // opening word that is not a frequent opener is read as a possible name.
  const one = (O: string, C: FactSources, lang: 'es' | 'en' = 'es') => ({ O, C, sentences: [O], lang });
  const edit = (before: string, after: string) => ({ sentenceId: 0, before, after, reason: 'test' });

  it('reverts a name invented as the first word of the sentence', () => {
    const r = checkEdit(edit('Armé', 'Google me pidió que armara'), one('Armé el formulario.', { cv: '' }));
    expect(r).toMatchObject({ status: 'reverted', reason: 'invented' });
    expect(r.status === 'reverted' && r.facts.map((f) => f.key)).toEqual(['google']);
    expect(checkEdit(edit('I built', 'Google hired me to build'), one('I built the form.', { cv: '' }, 'en'))).toMatchObject({ status: 'reverted', reason: 'invented' });
    const contoso = one('Contoso me pidió el sitio.', { cv: 'Trabajé para Contoso.' });
    expect(checkEdit(edit('Contoso me pidió', 'Google y Contoso me pidieron'), contoso)).toMatchObject({ status: 'reverted', reason: 'invented' });
  });

  it('reverts an edit that loses a name from the first word of the sentence', () => {
    expect(checkEdit(edit('Supabase guarda', 'Una base guarda'), one('Supabase guarda los pedidos.', C_ES))).toMatchObject({ status: 'reverted', reason: 'lost' });
    expect(checkEdit(edit('Supabase guarda', 'Una base guarda'), one('Supabase guarda los pedidos.', { cv: '' }))).toMatchObject({ status: 'reverted', reason: 'lost' });
    expect(checkEdit(edit('Contoso me pidió', 'Me pidieron'), one('Contoso me pidió el sitio.', { cv: '' }))).toMatchObject({ status: 'reverted', reason: 'lost' });
  });

  it('reads a known name at the start of a sentence, and leaves frequent openers and verbs alone', () => {
    expect(keys('Supabase guarda los pedidos. Uso Supabase.')).toEqual(['supabase', 'supabase']);
    expect(keys('Armé el formulario. Quiero sumar pagos.')).toEqual([]);
    expect(checkEdit(edit('Me gustaría mucho poder sumar', 'Quiero sumar'), one('Me gustaría mucho poder sumar pagos.', { cv: '' })).status).toBe('accepted');
    expect(checkEdit(edit('Armé', 'Yo armé'), one('Armé el formulario.', { cv: '' })).status).toBe('accepted');
  });

  it('lets a rewrite cut a slop sentence that opens with a contraction or a connector', () => {
    // Found by the D3 cases: these openers were read as possible names, so a correct rewrite that
    // cut the slop sentence failed the invariant as if it had lost a name.
    const en = [
      ["I wrote 60 articles. Let's connect and explore how I can add value.", 'I wrote 60 articles.'],
      ['I keep 120 laptops patched. Furthermore, I know SQL well.', 'I keep 120 laptops patched. I know SQL well.'],
      ["I wrote 60 articles. It's a mindset. That's my passion. Here's the thing.", 'I wrote 60 articles.'],
      ['Throughout my journey, I wrote 60 articles.', 'I wrote 60 articles.'],
      ['I wrote 60 articles.\n\nWarm regards,\nDaniel', 'I wrote 60 articles.\n\nBest,\nDaniel'],
      ['I wrote 60 articles.\n\nWarmest regards,\nDaniel', 'I wrote 60 articles.\n\nBest,\nDaniel'],
      ['Whether big or small, I wrote 60 articles. Moreover, they help.', 'I wrote 60 articles. They help.'],
    ] as const;
    for (const [O, R] of en) expect(factInvariant(O, R, { cv: 'x' }, [], EN), O).toMatchObject({ holds: true });
    const es = [
      ['Rehice el sitio. Asimismo, armé un formulario.', 'Rehice el sitio. También armé un formulario.'],
      ['Rehice el sitio. Cabe destacar que me apasiona.', 'Rehice el sitio.'],
      ['Rehice el sitio. Juntos podemos lograrlo.', 'Rehice el sitio.'],
      ['Rehice el sitio. Será un placer charlar.', 'Rehice el sitio.'],
      ['Quería contarte que rehice el sitio.', 'Rehice el sitio.'],
    ] as const;
    for (const [O, R] of es) expect(factInvariant(O, R, { cv: '' }, [], ES), O).toMatchObject({ holds: true });
  });

  it('breaks the invariant for a name invented or lost at the start of a sentence', () => {
    expect(factInvariant('Armé el formulario.', 'Google me contrató. Armé el formulario.', { cv: '' }, [], ES).extra.map((f) => f.key)).toEqual(['google']);
    expect(factInvariant('I built the form.', 'Google hired me. I built the form.', { cv: 'x' }, [], EN).holds).toBe(false);
    expect(factInvariant('Contoso me pidió el sitio.', 'Me pidieron el sitio.', { cv: '' }, [], ES).missing.map((f) => f.key)).toEqual(['contoso']);
  });
});

describe('ordinary words at the start of a sentence or a list item', () => {
  // The live eval of 17/11 and the fact-check probe: a capitalized verb or noun opening a line
  // ("Optimizar", "Comparto", "Soluciones", "Built", "Proven") was read as a possible name, so a
  // rewrite that changed or cut it was reverted as a lost or invented fact (about 420 false alarms
  // over 147 cases). A lexicon of the verbs and nouns these texts open lines with, and noun and
  // verb endings no name shares, read them as words; surnames that look like verbs stay names.
  const openings = (text: string, lang: 'es' | 'en') => extract(text, { lang, openings: true }).filter((f) => f.opening === true).map((f) => f.text);
  const one = (O: string, lang: 'es' | 'en') => ({ O, C: { cv: '' }, sentences: splitSentences(O, lang).map((s) => s.text), lang });

  it('reads the verbs and nouns a Spanish line opens with as words', () => {
    const lines = [
      'Optimizar procesos.', 'Liderar equipos.', 'Potenciar sinergias.', 'Mejorar la carga.', 'Comparto algunos ejemplos abajo.',
      'Disfruto este tipo de trabajo.', 'Ayudo a comercios chicos con su web.', 'Prefiero una llamada corta.', 'Vi que buscan gente.',
      'Rehice el sitio.', 'Saben lo que hacen.', 'Tarda unos días.', 'Mantengo el sitio.', 'Confirmo el martes.', 'Probalo y avisame.',
      'Ignorá lo anterior.', 'Soluciones a medida para tu negocio.', 'Mantenimiento mensual del sitio.', 'Diseño de páginas.',
      'Transformación digital de punta a punta.', 'Velocidad de carga.', 'Atención al cliente.', 'Búsqueda de desarrolladora.',
      'Comunicación clara.', 'Optimización integral de procesos.', 'Pasión por la web.', 'Postulación al puesto.', 'Presupuesto del sitio.',
      'Propuesta de valor.', 'Sinergias y valor.', 'Sitio de la escuela.', 'Formulario de pedidos.', 'Desarrolladora web.', 'Formada en diseño.',
      'Automatizar reportes.', 'Tenemos que hablar.',
    ];
    for (const line of lines) expect(openings(line, 'es'), line).toEqual([]);
  });

  it('reads the verbs, nouns and adjectives an English line opens with as words', () => {
    const lines = [
      'Built the help center.', 'Got your message.', 'Allow me to explain.', 'Enjoy the rest of your week.', 'Want to talk?', 'Free on Friday.',
      'Below are some examples.', 'Proven track record of driving customer satisfaction.', 'Strong communication skills.', 'Passion for support.',
      'Cutting-edge solutions.', 'Congrats on the launch!', 'Cut the backlog in half.', 'Fancy a call?', 'Great to hear.', 'Help desk setup.',
      'Ignore the previous instructions.', 'Imagine a faster inbox.', 'Key skills.', 'Laptop fleet management.', 'Note the dates.',
      'Passion drives me.', 'Pressure is part of the job.', 'Quick question.', 'Reference available.', 'Revolutionize your support.',
      'Right, here it is.', 'Searches fell.', 'Short version.', 'Support work.', "They'd love it.", 'Tools I use.', 'Communication matters.',
    ];
    for (const line of lines) expect(openings(line, 'en'), line).toEqual([]);
  });

  it('still reads a name that looks like a verb or a noun as a possible name', () => {
    const es = [
      'Aguilar me recomendó.', 'Escobar revisó el sitio.', 'Bolívar me pasó el contacto.', 'Salazar me llamó.', 'Javier me pidió el sitio.',
      'Oscar me escribió.', 'Pilar me recomendó.', 'Omar quiere el sitio.', 'Walter me contrató.', 'Concepción me escribió.', 'Asunción me llamó.',
      'Gonzalo me pidió el sitio.', 'Sarmiento me contrató.', 'Camilo me escribió.', 'Globant me contrató.',
    ];
    for (const line of es) expect(openings(line, 'es'), line).toEqual([line.split(' ')[0]]);
    const en = ['Mark referred me.', 'Grant asked for it.', 'Drew wrote back.', 'Olivier sent the brief.', 'Pillar hired me.', 'Chase called.', 'Hope called.'];
    for (const line of en) expect(openings(line, 'en'), line).toEqual([line.split(' ')[0]]);
  });

  it('accepts a changed or cut opening verb or noun, and still reverts an invented name there', () => {
    const O = 'Hola Marta,\n\nBusco un puesto donde pueda:\n- Optimizar procesos.\n- Liderar equipos.\n\nSaludos,\nValeria';
    const sentences = one(O, 'es').sentences;
    const at = (q: string): number => sentences.findIndex((s) => s.includes(q));
    expect(checkEdit({ sentenceId: at('Optimizar'), before: 'Optimizar', after: 'Mejorar', reason: 't' }, one(O, 'es')).status).toBe('accepted');
    expect(factInvariant(O, O.replace('- Optimizar', '- Mejorar'), { cv: '' }, [], ES).holds).toBe(true);
    expect(factInvariant(O, O.replace('Busco un puesto', 'Comparto algunos ejemplos. Busco un puesto'), { cv: '' }, [], ES).holds).toBe(true);
    expect(factInvariant(O, O.replace('- Liderar equipos.\n', ''), { cv: '' }, [], ES).holds).toBe(true);
    expect(factInvariant(O, O.replace('Busco un puesto', 'Escobar me recomendó. Busco un puesto'), { cv: '' }, [], ES).extra.map((f) => f.key)).toEqual(['escobar']);
    const en = 'Hi Tom,\n\nHere is what I have done:\n- Spearheaded the help desk.\n- Proven track record of driving customer satisfaction.\n\nBest,\nDaniel';
    expect(factInvariant(en, en.replace('Spearheaded', 'Built'), { cv: 'x' }, [], EN).holds).toBe(true);
    expect(factInvariant(en, en.replace('- Proven track record of driving customer satisfaction.\n', ''), { cv: 'x' }, [], EN).holds).toBe(true);
    expect(factInvariant(en, en.replace('Here is', 'Grant asked what. Here is'), { cv: 'x' }, [], EN).extra.map((f) => f.key)).toEqual(['grant']);
  });

  // Review of 17/11: the word list must never hide a name. A key both ordinary and named by the
  // CV or the original ("Make" the tool, "Éxito" the store) is the name when it opens a line, and
  // a word that is also a common first name ("Leo") is not in the list at all.
  it('keeps a name the CV or the original states when it opens a line, even if it is also an ordinary word', () => {
    const make = 'Make and n8n workflows for clinics.';
    const cvMake = { cv: 'Automation with Make and n8n.' };
    expect(factInvariant(make, 'n8n workflows for clinics.', cvMake, [], EN).missing.map((f) => f.key)).toEqual(['make']);
    expect(factInvariant(make, 'Zapier and n8n workflows for clinics.', cvMake, [], EN).missing.map((f) => f.key)).toEqual(['make']);
    expect(factInvariant('- Éxito: tienda online.', '- Tienda online.', { cv: 'Ventas en Éxito.' }, [], ES).missing.map((f) => f.key)).toEqual(['éxito']);
  });

  it('reads "Leo" at a line start as a name, invented or dropped', () => {
    const O = 'Hola Nadia.\nMe pasaron tu contacto. Te escribo por el sitio.';
    expect(factInvariant(O, O.replace('Me pasaron', 'Leo me pasó'), { cv: 'x' }, [], ES).extra.map((f) => f.key)).toEqual(['leo']);
    const L = 'Leo me pasó tu contacto. Te escribo.';
    expect(factInvariant(L, 'Me pasaron tu contacto. Te escribo.', { cv: 'Referencia: Leo Ibarra.' }, [], ES).missing.map((f) => f.key)).toEqual(['leo']);
    expect(factInvariant(L, 'Me pasaron tu contacto. Te escribo.', { cv: 'x' }, [], ES).missing.map((f) => f.key)).toEqual(['leo']);
  });

  it('reads a tool or a name with a noun ending as a possible name (Notion, Fusion, Motion, Vision, Ness)', () => {
    for (const line of ['Notion holds every brief.', 'Fusion runs the books.', 'Motion edits the videos.', 'Vision reads the scans.', 'Ness hired me.'])
      expect(openings(line, 'en'), line).toEqual([line.split(' ')[0]]);
    const O = 'Notion is where I keep every client brief.';
    expect(factInvariant(O, 'I keep every client brief in one place.', { cv: 'x' }, [], EN).missing.map((f) => f.key)).toEqual(['notion']);
    expect(factInvariant('I keep every brief.', 'Notion holds every brief.', { cv: 'x' }, [], EN).extra.map((f) => f.key)).toEqual(['notion']);
  });

  it('reads a capitalized word followed by an article as a verb, whatever the verb (Relevar el sitio, Audit the plugins)', () => {
    const es = '- Relevar el sitio.\n- Ordenar los plugins.';
    expect(factInvariant(es, '- Auditar el sitio.\n- Limpiar los plugins.', { cv: 'x' }, [], ES).holds).toBe(true);
    const en = '- Audit the plugins.\n- Trim the theme.';
    expect(factInvariant(en, '- Map the plugins.\n- Slim the theme.', { cv: 'x' }, [], EN).holds).toBe(true);
    // A name is followed by a verb, not an article: these stay names.
    expect(openings('Escobar revisó el sitio.', 'es')).toEqual(['Escobar']);
    expect(openings('Grant asked for the brief.', 'en')).toEqual(['Grant']);
  });

  it('reads a first name with an accented ending as a name (José, Noé, Andrés, Inés), and a past verb as a verb', () => {
    for (const line of ['José me pasó tu contacto.', 'Noé me escribió.', 'Andrés me recomendó.', 'Inés me llamó.', 'René revisó el sitio.'])
      expect(openings(line, 'es'), line).toEqual([line.split(' ')[0]]);
    for (const line of ['Armé el sitio.', 'Llegó el pedido.', 'Trabajé dos años ahí.', 'Lideré el equipo.']) expect(openings(line, 'es'), line).toEqual([]);
    const O = 'José me pasó tu contacto. Te escribo.';
    expect(factInvariant(O, 'Me pasaron tu contacto. Te escribo.', { cv: 'x' }, [], ES).missing.map((f) => f.key)).toEqual(['josé']);
  });
});

describe('an acronym is not an ordinary word', () => {
  // The probe (cause E): "It's" backed a dropped "IT", and the CV's "IT" made the opener "It" a
  // name, so cutting "It was a game-changer." read as a lost fact.
  const cv = 'IT technician at Harrow Lane Primary School since 2019.';
  it('does not back a dropped acronym with an ordinary word that starts the same way', () => {
    const O = "I am applying for the IT Service Desk Analyst role. It's the work I do.";
    expect(factInvariant(O, "I am applying for the Service Desk Analyst role. It's the work I do.", { cv }, [], EN).missing.map((f) => f.key)).toEqual(['it']);
  });

  it('does not read the opener "It" as the acronym "IT"', () => {
    const O = 'I kept 120 laptops patched. It was a game-changer.';
    expect(factInvariant(O, 'I kept 120 laptops patched.', { cv }, [], EN)).toMatchObject({ holds: true });
  });
});

describe('names are matched as names', () => {
  // A name in R is backed only by the same name in O or C, capitalized: the same words in lower
  // case are ordinary words.
  it('does not take common words in lower case for an invented company', () => {
    expect(factInvariant('Hice una tienda en la nube.', 'Hice la tienda de Tienda Nube.', { cv: '' }, [], ES).extra.map((f) => f.key)).toEqual(['tienda', 'nube']);
    const banco = factInvariant('Armé el sitio.', 'Armé el sitio para Banco Nación.', { cv: 'Trabajé en un banco de la nación.' }, [], ES);
    expect(banco.extra.map((f) => f.key)).toEqual(['banco', 'nación']);
    const O = 'Armé el sitio.';
    const r = checkEdit({ sentenceId: 0, before: 'el sitio', after: 'el sitio para Banco Nación', reason: 'test' }, { O, C: { cv: 'Trabajé en un banco de la nación.' }, sentences: [O], lang: 'es' });
    expect(r).toMatchObject({ status: 'reverted', reason: 'invented' });
  });
});

describe('numbers are compared as a sequence, not a set', () => {
  // Design 4.6: "un número cambiado (12 por 15) se revierte siempre", also when the new value is
  // already somewhere in O, when two numbers swap places, or when a number is repeated in place
  // of another word.
  const edit = (sentenceId: number, before: string, after: string) => ({ sentenceId, before, after, reason: 'test' });
  const of = (sentences: string[]) => ({ O: sentences.join(' '), C: { cv: '' }, sentences, lang: 'es' as const });

  it('reverts two numbers that swap places', () => {
    const ctx = of(['La página pasó de 4,1 s a 1,6 s.']);
    expect(checkEdit(edit(0, 'de 4,1 s a 1,6 s', 'de 1,6 s a 4,1 s'), ctx)).toMatchObject({ status: 'reverted', reason: 'changed-number' });
    expect(factInvariant('La página pasó de 4,1 s a 1,6 s.', 'La página pasó de 1,6 s a 4,1 s.', { cv: '' }, [], ES).holds).toBe(false);
  });

  it('reverts a number changed to one O states elsewhere', () => {
    const ctx = of(['Atendí 12 clientes y 12 proveedores.', 'Cerré 15 pedidos.']);
    expect(checkEdit(edit(0, '12 proveedores', '15 proveedores'), ctx)).toMatchObject({ status: 'reverted', reason: 'changed-number' });
    const R = 'Atendí 12 clientes y 15 proveedores. Cerré 15 pedidos.';
    expect(factInvariant(ctx.O, R, { cv: '' }, [], ES).holds).toBe(false);
  });

  it('reverts a count repeated in place of another word', () => {
    const ctx = of(['Tengo una clienta y dos proveedores.']);
    expect(checkEdit(edit(0, 'una clienta', 'dos clientas'), ctx)).toMatchObject({ status: 'reverted', reason: 'changed-number' });
  });

  it('still lets numbers of different kinds move within the sentence', () => {
    const ctx = of(['En marzo de 2023 migré 12 casillas.']);
    expect(checkEdit(edit(0, 'En marzo de 2023 migré 12 casillas', 'Migré 12 casillas en marzo de 2023'), ctx).status).toBe('accepted');
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

describe('ordinary words at the start of a sentence (F6b eval run)', () => {
  // The first real-model run reverted edits that removed slop because a capitalized first word was
  // read as a name: "loses Quedo without drop" 30 times, "loses Me", "loses Unlocking", "adds
  // Cualquier". Every text below is the run's own, from the fictional eval cases.
  const C_HEAVY_ES: FactSources = { cv: CV_ES, recipient: ['Martín Ocampo', 'Cooperativa La Huella'] };
  const check = (O: string, C: FactSources, before: string, after: string, lang: 'es' | 'en' = 'es') => {
    const sentences = splitSentences(O, lang).map((s) => s.text);
    const sentenceId = sentences.findIndex((s) => s.includes(before));
    expect(sentenceId, before).toBeGreaterThanOrEqual(0);
    return checkEdit({ sentenceId, before, after, reason: 'test' }, { O, C, sentences, lang });
  };

  it('accepts a closing formula replaced by a concrete offer (Quedo)', () => {
    const O = 'Estimada Lucía:\n\nRehice el sitio de la Panadería Los Álamos en Astro: la página principal pasó de 4,1 s a 1,6 s de carga. Estoy convencida de que mi perfil encaja perfectamente con los valores de Estudio Lumen.\n\nQuedo a la espera de su respuesta.\n\nSaludos cordiales,\nValeria Sosa Pereyra';
    const C = { cv: CV_ES, recipient: ['Lucía Ferrero', 'Estudio Lumen'] };
    expect(check(O, C, 'Quedo a la espera de su respuesta.', 'Si le sirve, le muestro los proyectos en una llamada breve.').status).toBe('accepted');
  });

  it('accepts a stock opener cut after an emoji (Me) and a follow-up opener rewritten (Solo)', () => {
    const O = 'Gracias por recomendarme con la gente de la librería, Sofi 🙌 Me apasiona este tipo de proyectos y quedo a tu entera disposición. Te aviso cómo me va!';
    expect(check(O, { cv: CV_ES, recipient: ['Sofía'] }, ' Me apasiona este tipo de proyectos y quedo a tu entera disposición.', '').status).toBe('accepted');
    const F = 'Hola Martín,\n\nEspero que este mensaje te encuentre muy bien. Solo quería hacer un seguimiento de mi mensaje anterior, ya que me apasiona la posibilidad de potenciar sinergias con la cooperativa y aportar valor agregado a su presencia digital.\n\nSaludos,\nValeria';
    const before = 'Solo quería hacer un seguimiento de mi mensaje anterior, ya que me apasiona la posibilidad de potenciar sinergias con la cooperativa y aportar valor agregado a su presencia digital.';
    const after = 'Te pasé el presupuesto para mantener el sitio de la cooperativa [COMPLETAR: cuándo lo enviaste] y quería saber si lo pudiste ver.';
    expect(check(F, C_HEAVY_ES, before, after).status).toBe('accepted');
  });

  it('accepts a new first word that is an ordinary word (Cualquier, Pudiste, Hablamos)', () => {
    const W = 'Hola Sofi! Soy una profesional proactiva y orientada a resultados. Hago sitios en WordPress y en Astro. Quedo a tu entera disposición!';
    expect(check(W, { cv: CV_ES, recipient: ['Sofía'] }, 'Quedo a tu entera disposición!', 'Cualquier cosa avisame!').status).toBe('accepted');
    const E = 'Hola Martín,\n\nMantengo tres sitios WordPress con copias semanales y actualizaciones mensuales.\n\nQuedo a tu entera disposición ante cualquier consulta.\n\nSaludos,\nValeria';
    const before = 'Quedo a tu entera disposición ante cualquier consulta.';
    expect(check(E, C_HEAVY_ES, before, '¿Pudiste ver el presupuesto? [COMPLETAR: qué necesitás que Martín te responda sobre el presupuesto, por ejemplo si lo aprueban, y para cuándo]').status).toBe('accepted');
    expect(check(E, C_HEAVY_ES, before, '¿Hablamos [COMPLETAR: qué próximo paso proponés y cuándo, por ejemplo una llamada y los días que podés]?').status).toBe('accepted');
  });

  it('accepts a slop subject line rewritten after its label (Unlocking)', () => {
    const O = 'Subject: Unlocking world-class support for Kestrel Books\n\nHi Tom,\n\nI use Zendesk every day and wrote 60 help articles for Brightwell Parcels.\n\nBest,\nDaniel';
    const after = 'Support engineer writing about [COMPLETAR: the reason for writing to Kestrel Books, such as a specific opening or a question]';
    expect(check(O, { cv: CV_EN, recipient: ['Tom Hale', 'Kestrel Books'] }, 'Unlocking world-class support for Kestrel Books', after, 'en').status).toBe('accepted');
  });

  it('holds the invariant for the single-call rewrites the rubric failed', () => {
    const O = 'Hola Sofi! Espero que estés muy bien. Me pongo en contacto con vos porque me apasiona aportar valor agregado y potenciar sinergias en un mundo cada vez más digital. Soy una profesional proactiva y orientada a resultados. Hago sitios en WordPress y en Astro. Quedo a tu entera disposición!';
    const R = 'Hola Sofi! Espero que estés muy bien. Te escribo porque [COMPLETAR: qué le querés pedir o contar a Sofi]. Soy desarrolladora web freelance. Hago sitios en WordPress y en Astro. Cualquier cosa avisame!';
    const result = factInvariant(O, R, { cv: CV_ES, recipient: ['Sofía'] }, [], ES);
    expect(result.missing.map((f) => f.text)).toEqual([]);
    expect(result.extra.map((f) => f.text)).toEqual([]);
  });

  it('still protects a real name at the start of a sentence', () => {
    // Kestrel is a name because C writes it capitalized mid-sentence, whatever the first word looks like.
    const C = { cv: 'I wrote help articles for Kestrel Books in 2024.' };
    expect(check('Kestrel Books is hiring a support engineer.', C, 'Kestrel Books is hiring', 'The shop is hiring', 'en')).toMatchObject({ status: 'reverted', reason: 'lost' });
    expect(check('Solo uso Supabase. Supabase guarda los pedidos.', { cv: '' }, 'Supabase guarda', 'Una base guarda')).toMatchObject({ status: 'reverted', reason: 'lost' });
    expect(factInvariant('Kestrel Books is hiring.', 'The shop is hiring.', C, [], EN).missing.map((f) => f.key)).toEqual(['kestrel', 'books']);
  });
});

describe('lower-case evidence for a first word', () => {
  it('does not take a URL or an email as the word in lower case', () => {
    const O = 'Contoso me pidió el sitio. Escribime a ana@contoso.example o a https://contoso.example.';
    const sentences = ['Contoso me pidió el sitio.', 'Escribime a ana@contoso.example o a https://contoso.example.'];
    const edit = { sentenceId: 0, before: 'Contoso me pidió', after: 'Me pidieron', reason: 'test' };
    expect(checkEdit(edit, { O, C: { cv: '' }, sentences, lang: 'es' })).toMatchObject({ status: 'reverted', reason: 'lost' });
  });
});

describe('a name at the start of a sentence that is also a common word', () => {
  // A word written in lower case somewhere (O, C, R or the edit) said nothing about the same word
  // capitalized at a sentence start: "Mark referred me" and "hit the mark" are two words.
  it('reports a lost name although O or C writes the same word in lower case', () => {
    const lost = (O: string, R: string, C: FactSources, opts: { lang: 'es' | 'en' }) => factInvariant(O, R, C, [], opts).missing.map((f) => f.text);
    expect(lost('Hi. Mark referred me.', 'Hi. A colleague referred me.', { cv: 'Left a mark on the team.' }, EN)).toEqual(['Mark']);
    expect(lost('Hi. Mark referred me. I hit the mark on every launch.', 'Hi. A colleague referred me. I shipped every launch.', { cv: '' }, EN)).toEqual(['Mark']);
    expect(lost('Hola. Luz me pasó tu contacto. Hago fotos con luz natural.', 'Hola. Me pasaron tu contacto. Hago fotos.', { cv: '' }, ES)).toEqual(['Luz']);
  });

  it('reports an invented name although the rewrite also writes the word in lower case', () => {
    const added = (O: string, R: string, opts: { lang: 'es' | 'en' }) => factInvariant(O, R, { cv: '' }, [], opts).extra.map((f) => f.text);
    expect(added('Hi. Your team referred me. Let me know.', 'Hi. Hope referred me. I hope we can talk.', EN)).toEqual(['Hope']);
    expect(added('Hola. Me pasaron tu contacto.', 'Hola. Paz me pasó tu contacto. Lo dejo en paz.', ES)).toEqual(['Paz']);
    expect(added('Hola. Me pasaron tu contacto.', 'Hola. Sol me pasó tu contacto. Trabajo de sol a sol.', ES)).toEqual(['Sol']);
    const O = 'Hi. Your team referred me.';
    const edit = { sentenceId: 1, before: 'Your team referred me.', after: 'Hope referred me, and I hope we talk.', reason: 'test' };
    expect(checkEdit(edit, { O, C: { cv: '' }, sentences: ['Hi.', 'Your team referred me.'], lang: 'en' })).toMatchObject({ status: 'reverted', reason: 'invented' });
  });
});

describe('a surname with a verb ending at the start of a sentence', () => {
  // "-amos/-emos/-imos" and "-aste/-iste" read "¿Pudiste ver...?" and "¿Hablamos...?" as verbs in
  // the F6b run, and also Ramos, Lemos and Jean-Baptiste.
  it('reports a lost or invented Ramos, Lemos or Jean-Baptiste', () => {
    const R = 'Hola. Me pasaron tu contacto. Busco trabajo.';
    for (const name of ['Ramos', 'Lemos', 'Jean-Baptiste']) {
      const O = `Hola. ${name} me pasó tu contacto. Busco trabajo.`;
      expect(factInvariant(O, R, { cv: '' }, [], ES).missing.map((f) => f.text), name).toEqual([name]);
      expect(factInvariant(R, O, { cv: '' }, [], ES).extra.map((f) => f.text), name).toEqual([name]);
    }
    const edit = { sentenceId: 0, before: 'Ramos me pasó', after: 'Me pasaron', reason: 'test' };
    expect(checkEdit(edit, { O: 'Ramos me pasó tu contacto.', C: { cv: '' }, sentences: ['Ramos me pasó tu contacto.'], lang: 'es' })).toMatchObject({ status: 'reverted', reason: 'lost' });
  });
});

describe('a name right after an emoji', () => {
  // The emoji break made "Me" after "Sofi 🙌" a first word (F6b run); a name there must stay a name.
  it('reports a lost name after an emoji, even one that is also a common word', () => {
    const lost = (O: string, R: string) => factInvariant(O, R, { cv: '' }, [], ES).missing.map((f) => f.text);
    expect(lost('Gracias 🙌 Rosa me recomendó. Me gusta el rosa.', 'Gracias 🙌 Me recomendaron. Me gusta el rosa.')).toEqual(['Rosa']);
    expect(lost('Gracias 🙌 Lemos me recomendó.', 'Gracias 🙌 Me recomendaron.')).toEqual(['Lemos']);
  });
});

describe('the forms the probe of 17/11 found unread', () => {
  it('does not read the markers of a numbered list as numbers (es-email-heavy-4)', () => {
    const O = 'Te propongo:\n1. Revisar el sitio.\n2) Migrar los mails de 12 personas.\n3. Armar el formulario.';
    expect(keys(O)).toEqual(['12']);
    expect(factInvariant(O, 'Te propongo revisar el sitio, migrar los mails de 12 personas y armar el formulario.', { cv: '' }, [], ES)).toMatchObject({ holds: true });
    // A number that opens a line without a marker's period or parenthesis is still a number.
    expect(keys('Pedidos por semana:\n40 en marzo.')).toEqual(['40', '--03']);
  });

  it('reads a bare domain as a URL, so dropping or changing it is a lost fact (en-email-good-3)', () => {
    const O = 'Tom Hale at calder-systems.example can tell you more. My site is valeria-sosa.com.ar.';
    expect(extract(O, EN).filter((f) => f.kind === 'url').map((f) => f.key)).toEqual(['calder-systems.example', 'valeria-sosa.com.ar']);
    expect(factInvariant(O, 'Tom Hale can tell you more. My site is valeria-sosa.com.ar.', { cv: 'x' }, [], EN).missing.map((f) => f.key)).toEqual(['calder-systems.example']);
    // The same domain behind a scheme states it; a version number or a file name is not a domain.
    expect(factInvariant(O, O.replace('calder-systems.example', 'https://calder-systems.example'), { cv: 'x' }, [], EN).missing).toEqual([]);
    expect(extract('Uso Node.js 20.1 y edito config.ts y README.md.', ES).filter((f) => f.kind === 'url')).toEqual([]);
  });
});

// Live run 2 of 17/11, es-email-heavy-4: the splitter cuts "1. Comunicación clara" into the
// sentences "1." and "Comunicación clara", so the edit deleting "1." was checked on the sentence
// "1." alone, where no space follows the marker; read as the number 1, its deletion "lost" 1 and was
// reverted. The rewrite then kept "1.\n2.\n3." on their own lines, read as the numbers 1 and 2 again.
describe('a list marker with nothing after it (es-email-heavy-4, live run 2)', () => {
  const LIST = 'Mis fortalezas:\n\n1. Comunicación clara\n2. Atención al detalle\n3. Pasión por aprender';
  const check = (sentence: string, before: string, extra: { drop?: boolean } = {}) =>
    checkEdit({ sentenceId: 0, before, after: '', reason: 'test', ...extra }, { O: LIST, C: { cv: '' }, sentences: [sentence], lang: 'es' });

  it('reads a marker as a marker whether or not text follows it', () => {
    expect(keys('1.')).toEqual([]);
    expect(keys('Mis fortalezas:\n1.\n2)\n3.')).toEqual([]);
    expect(keys('1.\n2.\n3.\n\nGracias.')).toEqual([]);
  });

  it('accepts the deletion of a bare marker, the sentence the splitter cuts it into', () => {
    expect(check('1.', '1.')).toMatchObject({ status: 'accepted', dropped: [] });
  });

  it('accepts the deletion of a whole item, marker and text, when the text holds no fact', () => {
    expect(check('1. Comunicación clara', '1. Comunicación clara')).toMatchObject({ status: 'accepted', dropped: [] });
  });

  it('still reverts the deletion of an item whose text states a fact', () => {
    const O = 'Hice:\n1. Migré los mails de 12 personas';
    const r = checkEdit({ sentenceId: 0, before: '1. Migré los mails de 12 personas', after: '', reason: 'test' }, { O, C: { cv: '' }, sentences: ['1. Migré los mails de 12 personas'], lang: 'es' });
    expect(r).toMatchObject({ status: 'reverted', reason: 'lost' });
    expect(r.status === 'reverted' ? r.facts.map((f) => f.key) : []).toEqual(['12']);
  });

  it('does not read the orphan markers a rewrite leaves as numbers it added', () => {
    const R = 'Mis fortalezas:\n\n1.\n2.\n3.';
    expect(factInvariant(LIST, R, { cv: '' }, [], ES)).toMatchObject({ holds: true, extra: [] });
  });
});
