// Step S0 of design 4.4: numbered sentences with spans in the text's own coordinates, and the
// subject, greeting, body and signature kept apart. Every text is fictional: Valeria Sosa Pereyra
// and Daniel Okoro are the fictional CVs of evals/cases/cv/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitSentences, textParts } from '../src/edits.ts';

const MAIL_ES = [
  'Asunto: Sitio de la Panadería Los Álamos',
  '',
  'Hola Marta,',
  '',
  'Te escribo por la propuesta del 3/11. La Sra. Quintana me pidió el formulario y ya está listo.',
  '¿Lo vemos el jueves a las 15:00?',
  '',
  'Saludos,',
  'Valeria Sosa Pereyra',
].join('\n');

describe('textParts', () => {
  it('keeps the subject, the greeting, the body and the signature apart, in order and without gaps', () => {
    const parts = textParts(MAIL_ES, 'es');
    expect(parts.map((p) => [p.part, MAIL_ES.slice(p.start, p.end).trim()])).toEqual([
      ['subject', 'Asunto: Sitio de la Panadería Los Álamos'],
      ['greeting', 'Hola Marta,'],
      ['body', 'Te escribo por la propuesta del 3/11. La Sra. Quintana me pidió el formulario y ya está listo.\n¿Lo vemos el jueves a las 15:00?'],
      ['signature', 'Saludos,\nValeria Sosa Pereyra'],
    ]);
    expect(parts[0]?.start).toBe(0);
    expect(parts.at(-1)?.end).toBe(MAIL_ES.length);
    for (let i = 1; i < parts.length; i++) expect(parts[i]?.start).toBe(parts[i - 1]?.end);
  });

  it('reads a WhatsApp message without frame as body only', () => {
    const text = 'Che, mañana te paso el link del sitio';
    expect(textParts(text, 'es')).toEqual([{ part: 'body', start: 0, end: text.length }]);
  });

  it('does not take a long line that opens with "Gracias" for the sign-off', () => {
    const text = 'Hi Priya,\nThanks for the call on Monday about the ticket backlog and the new help centre.\nBest,\nDaniel';
    expect(textParts(text, 'en').map((p) => p.part)).toEqual(['greeting', 'body', 'signature']);
  });
});

describe('splitSentences', () => {
  it('numbers the sentences from 0, with spans that slice the text exactly', () => {
    const sentences = splitSentences(MAIL_ES, 'es');
    expect(sentences.map((s) => [s.id, s.part, s.text])).toEqual([
      [0, 'subject', 'Asunto: Sitio de la Panadería Los Álamos'],
      [1, 'greeting', 'Hola Marta,'],
      [2, 'body', 'Te escribo por la propuesta del 3/11.'],
      [3, 'body', 'La Sra. Quintana me pidió el formulario y ya está listo.'],
      [4, 'body', '¿Lo vemos el jueves a las 15:00?'],
      [5, 'signature', 'Saludos,'],
      [6, 'signature', 'Valeria Sosa Pereyra'],
    ]);
    for (const s of sentences) expect(MAIL_ES.slice(s.start, s.end)).toBe(s.text);
  });

  it('never joins a greeting to the body, even when the body starts in lower case', () => {
    const text = 'Hola Marta,\nte paso el link.';
    expect(splitSentences(text, 'es').map((s) => [s.part, s.text])).toEqual([
      ['greeting', 'Hola Marta,'],
      ['body', 'te paso el link.'],
    ]);
  });

  it('splits English the same way, keeping initials and abbreviations inside a sentence', () => {
    const text = 'I moved the help centre for Mr. D. Okoro in 2024. It cut replies from 9 hours to 3 hours.';
    expect(splitSentences(text, 'en').map((s) => s.text)).toEqual([
      'I moved the help centre for Mr. D. Okoro in 2024.',
      'It cut replies from 9 hours to 3 hours.',
    ]);
  });

  it('returns nothing for a blank text', () => {
    expect(splitSentences(' \n\n ', 'es')).toEqual([]);
  });
});

// slop-lint's splitter is not on the public surface prose-rewriter may import, so edits.ts carries a
// copy. The sentences of a rewrite and of slop-lint's findings have to be the same ones, so this
// test reads both files as text and compares what was copied.
describe('the copy of slop-lint splitSentences', () => {
  const REPO = join(import.meta.dirname, '..', '..');
  const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
  const between = (source: string, from: string, to: string): string => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    expect(start, from).toBeGreaterThanOrEqual(0);
    expect(end, to).toBeGreaterThan(start);
    return source.slice(start, end);
  };
  const lint = read('slop-lint/src/text.ts');
  const ours = read('prose-rewriter/src/edits.ts');

  it('copies the abbreviations and helpers verbatim', () => {
    const from = 'const ABBREVIATIONS';
    const to = '/**\n * Splits plain text into sentences';
    expect(between(ours, from, to)).toBe(between(lint, from, to));
  });

  it('copies the body of splitSentences verbatim', () => {
    const body = (source: string, signature: string) => between(source, signature, '\n}\n').slice(signature.length);
    expect(body(ours, 'function splitSpans(text: string): Span[] {')).toBe(body(lint, 'export function splitSentences(text: string): Span[] {'));
  });
});
