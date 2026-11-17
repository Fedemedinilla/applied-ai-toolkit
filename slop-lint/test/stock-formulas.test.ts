// MAIL-04 and the LEX-01 spelling fix: the stock openers and closers of a mail that the live
// rewriter eval of 17 November 2026 found surviving a rewrite, because no rule reported them.
// Every name and company below is fictional.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/lint.ts';
import type { Genre, Lang } from '../src/types.ts';

const MAIL_GENRES: readonly Genre[] = ['email', 'follow-up', 'whatsapp'];
const hits = (text: string, lang: Lang, genre: Genre, id = 'MAIL-04') =>
  lint(text, { lang, genre }).findings.filter((f) => f.ruleId === id);

describe('MAIL-04, stock mail formulas', () => {
  const english: Array<[string, string]> = [
    ['Hi Dana,\n\nI hope this email finds you well. The March file is ready.\n\nBest,\nSam', 'I hope this email finds you well'],
    ['Hi Dana,\n\nI hope this message finds you well. The March file is ready.\n\nBest,\nSam', 'I hope this message finds you well'],
    ['Hi Dana,\n\nThe March file is ready. Please do not hesitate to contact me with questions.\n\nBest,\nSam', 'Please do not hesitate to contact'],
    ['Hi Dana,\n\nThe March file is ready. Don’t hesitate to reach out.\n\nBest,\nSam', 'Don’t hesitate to reach out'],
    ['Hi Dana,\n\nCould you send the logins at your earliest convenience?\n\nBest,\nSam', 'at your earliest convenience'],
    ['Hi Dana,\n\nThe March file is ready. I look forward to hearing from you.\n\nBest,\nSam', 'I look forward to hearing from you'],
    ['Hi Dana,\n\nThe March file is ready. Looking forward to hearing from you!\n\nBest,\nSam', 'Looking forward to hearing from you'],
    // Review of 17/11: the same formulas in the wording the eval did not use.
    ['Hi Dana,\n\nHope this finds you well. The March file is ready.\n\nBest,\nSam', 'Hope this finds you well'],
    ['Hi Dana,\n\nI trust this email finds you well. The March file is ready.\n\nBest,\nSam', 'I trust this email finds you well'],
    ['Hi Dana,\n\nI hope this letter finds you in good health. The March file is ready.\n\nBest,\nSam', 'I hope this letter finds you in good health'],
    ['Hi Dana,\n\nThe March file is ready. I look forward to your reply.\n\nBest,\nSam', 'I look forward to your reply'],
  ];
  const spanish: Array<[string, string]> = [
    ['Hola, Laura:\n\nEspero que este mensaje te encuentre muy bien. Te paso el tablero de marzo.\n\nSaludos,\nAna', 'Espero que este mensaje te encuentre muy bien'],
    ['Hola, Laura:\n\nEspero que este correo la encuentre bien. Le paso el tablero de marzo.\n\nSaludos,\nAna', 'Espero que este correo la encuentre bien'],
    ['Hola, Laura:\n\nTe paso el tablero de marzo. Quedo atenta a tus comentarios.\n\nSaludos,\nAna', 'Quedo atenta a tus comentarios'],
    ['Hola, Laura:\n\nTe paso el tablero de marzo. Quedo atento a cualquier consulta.\n\nSaludos,\nAna', 'Quedo atento a cualquier consulta'],
    ['Hola, Laura:\n\nTe paso el tablero de marzo. Quedo a disposición por cualquier duda.\n\nSaludos,\nAna', 'Quedo a disposición'],
    ['Hola, Laura:\n\nTe paso el tablero de marzo. Agradezco de antemano tu respuesta.\n\nSaludos,\nAna', 'Agradezco de antemano'],
    // Review of 17/11: a singular determiner, and the wording the eval did not use.
    ['Hola, Laura:\n\nTe paso el tablero de marzo. Quedo atenta a tu respuesta.\n\nSaludos,\nAna', 'Quedo atenta a tu respuesta'],
    ['Hola, Laura:\n\nLe paso el tablero de marzo. Quedo atento a su respuesta.\n\nSaludos,\nAna', 'Quedo atento a su respuesta'],
    ['Hola, Laura:\n\nEspero que te encuentres muy bien. Te paso el tablero de marzo.\n\nSaludos,\nAna', 'Espero que te encuentres muy bien'],
    ['Hola, Laura:\n\nEspero que se encuentre bien. Le paso el tablero de marzo.\n\nSaludos,\nAna', 'Espero que se encuentre bien'],
    ['Hola, Laura:\n\nLe paso el tablero de marzo. Quedo a la espera de su respuesta.\n\nSaludos,\nAna', 'Quedo a la espera de su respuesta'],
    ['Hola, Laura:\n\nTe paso el tablero de marzo. Quedo a la espera de tus comentarios.\n\nSaludos,\nAna', 'Quedo a la espera de tus comentarios'],
  ];

  for (const genre of MAIL_GENRES) {
    it(`reports each English formula at level 2, severity low, in ${genre}`, () => {
      for (const [text, match] of english) {
        expect(hits(text, 'en', genre).map((f) => [f.match, f.level, f.severity]), match).toEqual([[match, 2, 'low']]);
      }
    });

    it(`reports each Spanish formula at level 2, severity low, in ${genre}`, () => {
      for (const [text, match] of spanish) {
        expect(hits(text, 'es', genre).map((f) => [f.match, f.level, f.severity]), match).toEqual([[match, 2, 'low']]);
      }
    });
  }

  it('never runs on a cover letter, the default genre', () => {
    for (const [text] of english) expect(lint(text, { lang: 'en' }).findings.map((f) => f.ruleId)).not.toContain('MAIL-04');
    for (const [text] of spanish) expect(lint(text, { lang: 'es' }).findings.map((f) => f.ruleId)).not.toContain('MAIL-04');
  });

  it('leaves the plain wording near each formula alone', () => {
    const plain: Array<[string, Lang]> = [
      ['I hope the move went well. I hope you are doing well after the trip.', 'en'],
      ['I did not hesitate to call the carrier. The convenience store opens at 8.', 'en'],
      ['I look forward to Thursday. Hearing from the carrier took a week.', 'en'],
      ['Espero que estés bien. Espero que el tablero te sirva.', 'es'],
      ['Quedo atenta al tablero de marzo. El archivo queda a disposición de los gerentes.', 'es'],
      ['Te agradezco el dato de la feria.', 'es'],
      // Review of 17/11: a subject before "do not hesitate", and "quedó" typed without its accent.
      ['We do not hesitate to call the carrier when a parcel is late.', 'en'],
      ['El servidor quedo a disposición del equipo. La planilla quedo a disposicion de los gerentes.', 'es'],
      ['Espero que la encuentres en el cajón. Quedo a la espera del camión.', 'es'],
    ];
    for (const [text, lang] of plain) for (const genre of MAIL_GENRES) expect(hits(text, lang, genre), text).toEqual([]);
  });

  it('leaves "quedo a tu entera disposición" to LEX-01, which reports it at level 1, so the closer is charged once', () => {
    const text = 'Hola, Laura:\n\nTe paso el tablero. Quedo a tu entera disposición.\n\nSaludos,\nAna';
    const result = lint(text, { lang: 'es', genre: 'email' });
    expect(result.findings.filter((f) => /disposici/u.test(f.match)).map((f) => f.ruleId)).toEqual(['LEX-01']);
  });

  it('reports nothing on the human texts of the labelled set', () => {
    const dir = new URL('../fixtures/', import.meta.url);
    for (const genre of readdirSync(dir).filter((g) => g !== 'cover-letters')) {
      for (const file of readdirSync(new URL(`${genre}/`, dir))) {
        const set = JSON.parse(readFileSync(new URL(`${genre}/${file}`, dir), 'utf8')) as { lang: Lang; genre: Genre; items: Array<{ id: string; kind: string; text: string }> };
        for (const item of set.items.filter((i) => i.kind === 'human')) expect(hits(item.text, set.lang, set.genre), item.id).toEqual([]);
      }
    }
  });
});

describe('LEX-01 reads "disposicion" typed without its accent', () => {
  // A chat is often typed without accents: "quedo a tu entera disposicion" is the same closer.
  for (const genre of ['cover-letter', ...MAIL_GENRES] as const) {
    it(`in ${genre}`, () => {
      const text = 'hola Hernan! te paso el turnero, quedo a tu entera disposicion para lo que necesites';
      expect(hits(text, 'es', genre, 'LEX-01').map((f) => f.match)).toEqual(['quedo a tu entera disposicion']);
    });
  }
});
