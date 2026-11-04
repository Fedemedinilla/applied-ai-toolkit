// What code decides under each draft: the length of each language, the gaps, and the notes that
// follow from the category's configuration or from the text.

import { describe, expect, it } from 'vitest';
import { checkLength, containsWord, draftReport, emojiAllowed, lengthOf, signatureFor, type NoteCode } from '../src/checks.ts';
import type { Category } from '../src/config-schema.ts';
import { realConfig } from './raw-config.ts';

const config = realConfig();
const cat = (id: string): Category => {
  const c = config.catalog.categories.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};
const report = (id: string, es: string, en: string | null = null) => draftReport({ category: cat(id), catalog: config.catalog, school: config.school, es, en });
const codes = (r: ReturnType<typeof report>): NoteCode[] => r.notes.map((n) => n.code);
const words = (n: number) => Array.from({ length: n }, () => 'texto').join(' ');

describe('lengthOf', () => {
  it('counts what a reader sees: no bold markers, no list dashes, a gap as its label', () => {
    expect(lengthOf('**hola**')).toBe(4);
    expect(lengthOf('- uno\n- dos')).toBe(7);
    expect(lengthOf('A las [COMPLETAR: hora].')).toBe('A las hora.'.length);
    expect(lengthOf('  sobra  ')).toBe(5);
  });

  it('counts code points, so accents and emoji are one character each', () => {
    expect(lengthOf('canción')).toBe(7);
    expect(lengthOf('🎉')).toBe(1);
  });
});

describe('checkLength', () => {
  it('is ok at both ends of the range and short or long past them', () => {
    const range = { min: 10, max: 20 };
    expect(checkLength('es', 'x'.repeat(9), range).status).toBe('short');
    expect(checkLength('es', 'x'.repeat(10), range).status).toBe('ok');
    expect(checkLength('es', 'x'.repeat(20), range).status).toBe('ok');
    expect(checkLength('en', 'x'.repeat(21), range)).toEqual({ lang: 'en', chars: 21, min: 10, max: 20, status: 'long' });
  });
});

describe('signature and emoji', () => {
  it('signs sensitive texts as the committee, whoever writes', () => {
    expect(signatureFor(config.catalog, 'docente', 'normal')).toBe('Equipo docente de [COMPLETAR: grado o curso]');
    expect(signatureFor(config.catalog, 'coordinacion', 'high')).toBe('Equipo Directivo');
    expect(signatureFor(config.catalog, 'direccion', 'critical')).toBe('Equipo Directivo');
  });

  it('allows emoji only in a normal category that allows them', () => {
    expect(emojiAllowed(cat('logros'))).toBe(true);
    expect(emojiAllowed(cat('aviso-general'))).toBe(false);
    expect(emojiAllowed({ emoji: 'few', sensitivity: 'high' })).toBe(false);
  });
});

describe('containsWord', () => {
  it('matches whole words, ignoring accents and case', () => {
    expect(containsWord('La EXCURSION del martes', 'excursión')).toBe(true);
    expect(containsWord('Los chicos.', 'chicos')).toBe(true);
    expect(containsWord('compadres', 'padres')).toBe(false);
    expect(containsWord('chicosa', 'chicos')).toBe(false);
  });
});

describe('draftReport', () => {
  it('a clean text in range has only the configuration reminders', () => {
    const r = report('aviso-general', words(60));
    expect(r.lengths).toEqual([{ lang: 'es', chars: 359, min: 250, max: 700, status: 'ok' }]);
    expect(r.notes.every((n) => n.level === 'info')).toBe(true);
    expect(codes(r)).toEqual(['cta', 'attachments']);
  });

  it('the reminders follow each category: call to action, attachments, photos, graphics, reviewer, sensitivity', () => {
    const body = words(100);
    expect(codes(report('evento', body, body))).toEqual(['cta', 'photos', 'graphics', 'reviewer']);
    expect(codes(report('salida-educativa', words(150)))).toEqual(['cta', 'attachments', 'reviewer']);
    expect(codes(report('salud', body, body))).toEqual(['attachments', 'reviewer', 'sensitivity']);
    expect(codes(report('situacion-sensible', body))).toEqual(['reviewer', 'sensitivity']);
    const texts = report('evento', body, body).notes.map((n) => n.text);
    expect(texts).toContain('Agregar el formulario de confirmación de asistencia antes de enviar.');
    expect(texts).toContain('Antes de enviar, pedir una revisión a: Coordinación de nivel.');
    expect(report('situacion-sensible', body).notes.at(-1)?.text).toBe(
      'Sensibilidad crítica: firma Equipo Directivo y el texto necesita una segunda lectura antes del envío.',
    );
  });

  it('warns about length per language, with the numbers measured here', () => {
    const r = report('cambio-horario', words(20), words(200));
    expect(r.lengths.map((l) => l.status)).toEqual(['short', 'long']);
    expect(r.notes.filter((n) => n.code === 'length').map((n) => n.text)).toEqual([
      'El texto en español tiene 119 caracteres; esta categoría pide entre 200 y 600.',
      'El texto en inglés tiene 1.199 caracteres; esta categoría pide entre 200 y 600.',
    ]);
  });

  it('lists the gaps, singular and plural', () => {
    expect(report('aviso-general', `${words(60)} [COMPLETAR: hora]`).notes[0]?.text).toBe('Falta 1 dato antes de enviar: hora.');
    const two = report('aviso-general', `${words(60)} [COMPLETAR: hora] [COMPLETAR: lugar] [COMPLETAR: hora]`);
    expect(two.placeholders).toEqual(['hora', 'lugar']);
    expect(two.notes[0]?.text).toBe('Faltan 2 datos antes de enviar: hora; lugar.');
  });

  it('warns about a missing or an unexpected English version', () => {
    expect(codes(report('evento', words(100)))).toContain('missing_en');
    expect(codes(report('pagos', words(100), words(100)))).toContain('unexpected_en');
  });

  it('warns about emoji only where they are not allowed, and exclamation marks only in sensitive texts', () => {
    expect(codes(report('aviso-general', `${words(60)} 🎉`))).toContain('emoji');
    expect(codes(report('aviso-general', `${words(60)} Programa Lectores© y Ciencia® ™ ‼`))).not.toContain('emoji');
    expect(codes(report('aviso-general', `${words(60)} ❤`))).toContain('emoji');
    expect(codes(report('logros', `${words(60)} 🎉`, `${words(60)} 🎉`))).not.toContain('emoji');
    expect(codes(report('salud', `${words(80)} ¡Atención!`, words(80)))).toContain('exclamation');
    expect(codes(report('aviso-general', `${words(60)} ¡Gracias!`))).not.toContain('exclamation');
  });

  it('warns about each vocabulary entry the text breaks', () => {
    const notes = report('aviso-general', `${words(60)} Los chicos y los papis van de excursión.`).notes.filter((n) => n.code === 'vocabulary');
    expect(notes.map((n) => n.text)).toEqual([
      'Aparece «chicos»; la guía de estilo usa «estudiantes».',
      'Aparece «papis»; la guía de estilo usa «familias».',
      'Aparece «excursión»; la guía de estilo usa «salida educativa».',
    ]);
  });

  it('puts warnings before reminders', () => {
    const levels = report('evento', `${words(5)} [COMPLETAR: fecha]`).notes.map((n) => n.level);
    expect(levels.indexOf('info')).toBeGreaterThan(levels.lastIndexOf('warn'));
  });

  it('every example passes the checks it teaches', () => {
    for (const e of config.examples) {
      const r = report(e.category, e.es, e.en ?? null);
      expect(r.notes.filter((n) => n.level === 'warn'), e.title).toEqual([]);
    }
  });
});
