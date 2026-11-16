// The voice profile of design 4.5: measured by code, written into the prompt as data, and checked
// after a rewrite so it does not add what the writer never uses.
import { describe, expect, it } from 'vitest';
import { voicePromptLines, voiceProfile, voiceViolations } from '../src/voice.ts';

// Fictional messages: Valeria Sosa Pereyra is the fictional CV of evals/cases/cv/es-rioplatense.md.
const WHATSAPP = 'hola Marta, te paso el presupuesto del sitio. si podés mirarlo esta semana avisame y lo vemos\ngracias!';

describe('voiceProfile', () => {
  it('measures a rioplatense WhatsApp with no model', () => {
    const p = voiceProfile(WHATSAPP, 'es');
    expect(p.treatment).toBe('voseo');
    expect(p.counts).toMatchObject({ voseo: 2, tuteo: 0, usted: 0, invertedMarks: 0, closingMarks: 1, accents: 1, emoji: 0, che: 0 });
    expect(p.greeting).toBe(true);
    expect(p.signOff).toBe(true);
    expect(p.initialCapital).toBe(false);
    // The greeting stays (it opens a long line); the closing "gracias!" is a sign-off, not a sentence.
    expect(p.sentences).toBe(2);
    expect(p.meanSentenceWords).toBe(8.5);
    expect(p.sentenceWordsSpread).toBe(0.5);
  });

  it('tells tuteo, usted and a mix apart, and leaves treatment out of English', () => {
    expect(voiceProfile('¿Puedes mirarlo? Avísame.', 'es').treatment).toBe('tuteo');
    expect(voiceProfile('Le escribo para saber si usted pudo verlo.', 'es').treatment).toBe('usted');
    expect(voiceProfile('Si querés, dime.', 'es').treatment).toBe('mixed');
    expect(voiceProfile('Te paso el link.', 'es').treatment).toBe('none');
    expect(voiceProfile('If you can, tell me.', 'en').treatment).toBe('none');
  });

  it('counts emoji but not the trademark signs, and English contractions but not possessives', () => {
    expect(voiceProfile('Listo 👍 queda así 🙂', 'es').counts.emoji).toBe(2);
    expect(voiceProfile('Astro™ and WordPress®.', 'en').counts.emoji).toBe(0);
    expect(voiceProfile("I'm free Friday and it's fine, but Valeria's site isn't done.", 'en').counts.contractions).toBe(3);
  });
});

describe('voicePromptLines', () => {
  it('writes the profile as data, not adjectives', () => {
    expect(voicePromptLines(voiceProfile(WHATSAPP, 'es'))).toEqual([
      'usa voseo',
      'no usa ¿¡',
      'usa tildes (1)',
      'no usa emoji',
      'no dice "che"',
      'oraciones de 8,5 palabras en promedio (desvío 0,5)',
      'abre con saludo',
      'cierra con despedida',
      'empieza en minúscula',
    ]);
  });

  it('writes English lines for an English text', () => {
    const lines = voicePromptLines(voiceProfile("Hi Ana,\n\nI'm sending the quote. It covers the new site.\n\nBest,\nValeria", 'en'));
    expect(lines).toEqual([
      'uses contractions (1)',
      'uses no emoji',
      'sentences of 4.5 words on average (spread 0.5)',
      'opens with a greeting',
      'closes with a sign-off',
      'starts with a capital letter',
    ]);
  });
});

describe('voiceViolations', () => {
  const kinds = (original: string, rewritten: string, genre: 'whatsapp' | 'email' = 'whatsapp', lang: 'es' | 'en' = 'es') =>
    voiceViolations(original, rewritten, { genre, lang }).map((v) => v.kind);

  it('keeps a rioplatense WhatsApp without ¿¡ as it is', () => {
    const tidy = 'hola Marta, te paso el presupuesto del sitio. si podés mirarlo esta semana, avisame y lo vemos\ngracias!';
    expect(kinds(WHATSAPP, tidy)).toEqual([]);
    expect(kinds(WHATSAPP, 'hola Marta, te paso el presupuesto. ¿podés mirarlo esta semana? avisame\n¡gracias!')).toEqual(['inverted-marks']);
  });

  it('flags a rewrite that adds emoji or "che"', () => {
    expect(kinds(WHATSAPP, `${WHATSAPP} 🙌`)).toEqual(['emoji']);
    expect(kinds(WHATSAPP, WHATSAPP.replace('hola Marta', 'che Marta'))).toEqual(['che']);
  });

  it('flags a tuteo rewrite of a voseo text', () => {
    const tuteo = 'hola Marta, te paso el presupuesto del sitio. si puedes mirarlo esta semana avísame y lo vemos\ngracias!';
    expect(kinds(WHATSAPP, tuteo)).toEqual(['treatment']);
    expect(voiceViolations(WHATSAPP, tuteo, { genre: 'whatsapp', lang: 'es' })[0]?.message).toMatch(/tuteo/);
  });

  it('flags an initial capital or accents added to a WhatsApp, and lets the email genre ask for them', () => {
    const plain = 'hola, te paso el link. avisame si lo podes ver';
    const tidy = 'Hola, te paso el link. Avisame si lo podés ver';
    expect(kinds(plain, tidy)).toEqual(['accents', 'initial-capital']);
    expect(kinds(plain, tidy, 'email')).toEqual([]);
    expect(kinds('hi Ana, sending the quote today', 'Hi Ana, sending the quote today', 'email', 'en')).toEqual([]);
    expect(kinds('hi Ana, sending the quote today', 'Hi Ana, sending the quote today', 'whatsapp', 'en')).toEqual(['initial-capital']);
  });

  it('flags contractions added to an English text that used none, and ignores Spanish traits there', () => {
    expect(kinds('I am sending the quote today.', "I'm sending the quote today.", 'email', 'en')).toEqual(['contractions']);
    expect(kinds('I am sending the quote today.', 'I am sending the quote today, ¿ok?', 'email', 'en')).toEqual([]);
  });
});
