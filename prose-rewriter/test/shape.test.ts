// The shape of a text against its channel guide, measured by code: the body's words, its paragraphs
// and the sentences in each. The greeting, the sign-off and the signature are not body.
import { describe, expect, it } from 'vitest';
import { Channel } from '../../style-refs/src/index.ts';
import { measureShape } from '../src/shape.ts';

const guide = Channel.parse({
  id: 'es-email-neutral',
  genre: 'email',
  lang: 'es',
  variety: 'rioplatense',
  register: 'neutral',
  persona: 'Escribís como una profesional que le habla a un par.',
  reader: 'Lo lee alguien con poco tiempo.',
  shape: { words: { min: 20, max: 40 }, paragraphs: { max: 2, maxSentences: 2 }, opening: 'Dice por qué escribís.', closing: 'Un próximo paso.' },
  canonical: 'Te escribo por el sitio. Te cuento cómo lo encararía.',
  fictional: true,
});

const MAIL = [
  'Hola, Martín:',
  '',
  'Te escribo porque vi que están renovando el sitio. Me gustaría ayudarlos con eso.',
  '',
  'Mantengo tres sitios WordPress con copias semanales. Si te sirve, te cuento cómo lo hago.',
  '',
  'Valeria Sosa',
].join('\n');

describe('measureShape', () => {
  it('counts the body only: words, paragraphs and the sentences of each', () => {
    const s = measureShape(MAIL, 'es', guide);
    expect(s.words).toBe(29);
    expect(s.paragraphs).toEqual([2, 2]);
    expect(s.greeting).toBe(true);
    expect(s.signature).toBe(true);
    expect(s.problems).toEqual([]);
  });

  it('reports a body under or over the word range', () => {
    expect(measureShape('Hola, Martín:\n\nTe escribo por el sitio.\n\nValeria', 'es', guide).problems.map((p) => p.kind)).toEqual(['too-short']);
    const long = `Hola, Martín:\n\n${'Te escribo por el sitio de ustedes, que vi hace poco. '.repeat(4).trim()}\n\nValeria`;
    expect(measureShape(long, 'es', guide).problems.map((p) => p.kind)).toEqual(['too-long', 'long-paragraph']);
  });

  it('reports too many paragraphs, and a paragraph with more sentences than the guide allows, naming it', () => {
    const three = 'Hola:\n\nUno dos tres cuatro cinco seis siete.\n\nOcho nueve diez once doce trece.\n\nCatorce quince dieciséis diecisiete dieciocho diecinueve veinte.\n\nValeria';
    const s = measureShape(three, 'es', guide);
    expect(s.problems).toEqual([{ kind: 'too-many-paragraphs', message: '3 paragraphs; the channel wants at most 2' }]);
    const dense = 'Hola:\n\nUno dos tres. Cuatro cinco seis. Siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve veinte.\n\nValeria';
    expect(measureShape(dense, 'es', guide).problems).toEqual([{ kind: 'long-paragraph', message: 'paragraph 1 has 3 sentences; the channel wants at most 2' }]);
  });

  it('reads a WhatsApp with no blank line as one paragraph and no signature', () => {
    const s = measureShape('Hola Lu, ¿cómo andás? Te hago una consulta rápida sobre el sitio, avisame cuando puedas y lo vemos', 'es', guide);
    expect(s.paragraphs).toEqual([2]);
    expect(s.signature).toBe(false);
  });

  it('measures nothing against a missing guide, and says so', () => {
    const s = measureShape(MAIL, 'es', undefined);
    expect(s.words).toBe(29);
    expect(s.problems).toEqual([]);
    expect(s.guide).toBeNull();
  });
});
