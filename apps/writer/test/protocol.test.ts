// The marker protocol: what counts as a titles block or a draft, what is dropped, and the
// canonical text that goes back into the history.

import { describe, expect, it } from 'vitest';
import { parseReply, parseTitles, placeholders, serializeReply } from '../src/protocol.ts';

describe('titles', () => {
  it('reads the A:/B:/C: form the prompt asks for', () => {
    expect(parseReply('[[TITULOS]]\nA: Muestra anual\nB: Invitación a la muestra\nC: Los esperamos en la muestra\n[[/TITULOS]]')).toEqual({
      kind: 'titles',
      titles: ['Muestra anual', 'Invitación a la muestra', 'Los esperamos en la muestra'],
    });
  });

  it('accepts numbered, dashed, quoted and bold lines, and drops blanks and repeats', () => {
    expect(parseTitles('\n1. "Uno"\n- **Dos**\n  c) «Tres»  \n\nuno\n')).toEqual(['Uno', 'Dos', 'Tres']);
  });

  it('drops titles over 120 characters and keeps at most five', () => {
    expect(parseTitles(`A: ${'x'.repeat(121)}\nB: corto`)).toEqual(['corto']);
    expect(parseTitles('1\n2\n3\n4\n5\n6\n7')).toHaveLength(5);
  });

  it('is not a titles block with fewer than two titles, or without its closing marker', () => {
    expect(parseReply('[[TITULOS]]\nA: Solo uno\n[[/TITULOS]]')).toEqual({ kind: 'text', text: 'A: Solo uno' });
    expect(parseReply('[[TITULOS]]\nA: Uno\nB: Dos')).toEqual({ kind: 'text', text: 'A: Uno\nB: Dos' });
  });
});

describe('drafts', () => {
  it('reads a Spanish draft and drops text outside the block', () => {
    expect(parseReply('Aquí está:\n[[COMUNICADO]]\nEstimadas familias:\n\nTexto.\n[[/COMUNICADO]]\nEspero que sirva.')).toEqual({
      kind: 'draft',
      es: 'Estimadas familias:\n\nTexto.',
      en: null,
    });
  });

  it('splits a bilingual draft at the [[EN]] line', () => {
    expect(parseReply('[[COMUNICADO]]\nHola.\n[[EN]]\nHello.\n[[/COMUNICADO]]')).toEqual({ kind: 'draft', es: 'Hola.', en: 'Hello.' });
    expect(parseReply('[[COMUNICADO]]\nHola.\n[[EN]]\n\n[[/COMUNICADO]]')).toEqual({ kind: 'draft', es: 'Hola.', en: null });
  });

  it('a complete draft wins over a titles block in the same reply', () => {
    const reply = parseReply('[[TITULOS]]\nA: Uno\nB: Dos\n[[/TITULOS]]\n[[COMUNICADO]]\nTexto.\n[[/COMUNICADO]]');
    expect(reply.kind).toBe('draft');
  });

  it('an unclosed or empty draft is text, with the markers removed', () => {
    expect(parseReply('[[COMUNICADO]]\nEstimadas familias:\nEl viernes')).toEqual({ kind: 'text', text: 'Estimadas familias:\nEl viernes' });
    expect(parseReply('[[COMUNICADO]]\n\n[[/COMUNICADO]]')).toEqual({ kind: 'text', text: '' });
  });

  it('a question with no block is text', () => {
    expect(parseReply('¿Para qué curso es la reunión?')).toEqual({ kind: 'text', text: '¿Para qué curso es la reunión?' });
  });
});

describe('the canonical history text', () => {
  it('rebuilds each kind so that parsing it again gives the same reply', () => {
    for (const raw of [
      'Intro\n[[TITULOS]]\n1. Uno\n2. Dos\n[[/TITULOS]]',
      '[[COMUNICADO]]\nHola.\n[[EN]]\nHello.\n[[/COMUNICADO]] fin',
      '[[COMUNICADO]]\nSolo español.\n[[/COMUNICADO]]',
      'Una pregunta.',
    ]) {
      const reply = parseReply(raw);
      expect(parseReply(serializeReply(reply))).toEqual(reply);
    }
    expect(serializeReply({ kind: 'titles', titles: ['Uno', 'Dos'] })).toBe('[[TITULOS]]\nA: Uno\nB: Dos\n[[/TITULOS]]');
  });
});

describe('placeholders', () => {
  it('lists every [COMPLETAR: ...] once, in order, and counts a bare one', () => {
    const text = 'El [COMPLETAR: día] a las [COMPLETAR:  hora ]. Lugar: [COMPLETAR]. Otra vez el [COMPLETAR: día].';
    expect(placeholders(text)).toEqual(['día', 'hora', '']);
  });

  it('does not match across lines or other brackets', () => {
    expect(placeholders('[COMPLETAR: algo\nque sigue] y [COMPLETO: no]')).toEqual([]);
  });
});
