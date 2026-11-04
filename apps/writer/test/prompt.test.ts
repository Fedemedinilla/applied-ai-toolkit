// The system prompt is assembled from config/ in a fixed order. These tests pin the order, the
// sensitivity block, the step the code decides, and the bytes that must not change between turns.

import { describe, expect, it } from 'vitest';
import type { Category, Role } from '../src/config-schema.ts';
import { BLOCK, buildSystem, categoryBlock, COMPLETAR_RULE, RULES, schoolBlock, stepFor, todayLine } from '../server/prompt.ts';
import { realConfig } from './raw-config.ts';

const config = realConfig();
const role = (id: string): Role => config.catalog.roles.find((r) => r.id === id) ?? (() => { throw new Error(id); })();
const cat = (id: string): Category => config.catalog.categories.find((c) => c.id === id) ?? (() => { throw new Error(id); })();
// 10:30 in Buenos Aires on Wednesday 4 November 2026.
const NOW = new Date('2026-11-04T13:30:00Z');

/** Index of each needle in the text; fails if one is missing. */
function positions(text: string, needles: readonly string[]): number[] {
  return needles.map((n) => {
    const i = text.indexOf(n);
    if (i === -1) throw new Error(`missing: ${n}`);
    return i;
  });
}
const increasing = (xs: readonly number[]) => xs.every((x, i) => i === 0 || x > (xs[i - 1] ?? -1));

describe('block order', () => {
  it('is rules, school, category, turn', () => {
    const blocks = buildSystem(config, role('coordinacion'), cat('evento'), 'titles', NOW);
    expect(blocks).toHaveLength(4);
    expect(blocks[BLOCK.rules]).toBe(RULES);
    expect(blocks[BLOCK.school]?.startsWith('SCHOOL: Colegio Bilingüe Monte Lirio.')).toBe(true);
    expect(blocks[BLOCK.category]?.startsWith('AUTHOR: Coordinación de nivel.')).toBe(true);
    expect(blocks[BLOCK.turn]).toBe('TURN: titles. Read the brief and propose three titles.\nTODAY: miércoles, 4 de noviembre de 2026');
  });

  it('keeps blocks 0 to 2 byte for byte across steps and days, so the cached prefix holds', () => {
    const a = buildSystem(config, role('docente'), cat('salida-educativa'), 'titles', NOW);
    const b = buildSystem(config, role('docente'), cat('salida-educativa'), 'revise', new Date('2026-12-01T12:00:00Z'));
    expect(b.slice(0, 3)).toEqual(a.slice(0, 3));
    expect(b[3]).not.toEqual(a[3]);
  });

  it('holds the [COMPLETAR] rule once, in the rules block', () => {
    const all = buildSystem(config, role('direccion'), cat('aviso-general'), 'draft', NOW).join('\n');
    expect(all.split(COMPLETAR_RULE)).toHaveLength(2);
    expect(RULES).toContain(COMPLETAR_RULE);
  });
});

describe('school block', () => {
  it('lists facts, style guide, vocabulary and the four examples in that order', () => {
    const text = schoolBlock(config);
    expect(increasing(positions(text, ['FACTS:', config.school.facts[0]!, 'STYLE GUIDE:', config.school.style[0]!, 'VOCABULARY', '- estudiantes, not chicos, alumnitos, nenes', 'EXAMPLES:']))).toBe(true);
    expect(increasing(positions(text, config.examples.map((e) => `title="${e.title}"`)))).toBe(true);
    expect(text.match(/<example /gu)).toHaveLength(4);
    expect(text).toContain('<example category="Salud y prevención" title="Casos de pediculosis en Nivel Inicial">');
  });
});

describe('category block', () => {
  it('lists author, signature and every configured attribute in a fixed order', () => {
    const text = categoryBlock(config, role('coordinacion'), cat('evento'));
    expect(
      increasing(
        positions(text, [
          'AUTHOR: Coordinación de nivel.',
          'Signature, on its own last line: "Coordinación de [COMPLETAR: nivel]"',
          'CATEGORY: Invitación a un evento',
          'Purpose: ',
          'Audience: ',
          'Tone: Cálido y concreto.',
          'Length: between 450 and 1100 characters for each language.',
          'Languages: Spanish, then the English version after a [[EN]] line.',
          'Emoji: at most one, only if it fits.',
          'Call to action: required. Ask the reader to use el formulario de confirmación de asistencia',
          'Attachments: never.',
        ]),
      ),
    ).toBe(true);
    expect(text).not.toContain('SENSITIVITY');
  });

  it('adds the sensitivity block last, so it overrides tone and emoji, and signs as the committee', () => {
    const high = categoryBlock(config, role('coordinacion'), cat('salud'));
    expect(high).toContain('Emoji: none.');
    expect(high).toContain('Signature, on its own last line: "Equipo Directivo"');
    expect(high.split('\n').at(-1)).toMatch(/^SENSITIVITY: HIGH\. .*No emoji, no exclamation marks, no rallying phrases .*Sign as "Equipo Directivo"\.$/u);

    const critical = categoryBlock(config, role('direccion'), cat('situacion-sensible'));
    expect(critical.split('\n').at(-1)).toMatch(/^SENSITIVITY: CRITICAL\. .*only the facts in the brief: no causes, no names of students.*No emoji/u);
    expect(critical).not.toContain('SENSITIVITY: HIGH');
  });

  it('says the language and call-to-action rules for a Spanish-only category without one', () => {
    const text = categoryBlock(config, role('direccion'), cat('cambio-horario'));
    expect(text).toContain('Call to action: none.');
    const spanish = categoryBlock(config, role('administracion'), cat('pagos'));
    expect(spanish).toContain('Languages: Spanish only.');
    expect(spanish).toContain('Call to action: only if the brief needs one (el enlace de pago de la plataforma escolar).');
  });
});

describe('turn block', () => {
  it('names the step decided in code and the date in the school zone', () => {
    // 02:00 UTC on the 5th is still the 4th in Buenos Aires.
    expect(todayLine(new Date('2026-11-05T02:00:00Z'), config.school.timeZone)).toBe('TODAY: miércoles, 4 de noviembre de 2026');
    expect(buildSystem(config, role('direccion'), cat('aviso-general'), 'draft', NOW)[3]).toMatch(/^TURN: draft\. /u);
    expect(buildSystem(config, role('direccion'), cat('aviso-general'), 'revise', NOW)[3]).toMatch(/^TURN: revise\. .*\[COMPLETAR: \.\.\.\]/u);
  });

  it('stepFor reads the history: a brief, a chosen title, a draft already there', () => {
    const u = (content: string) => ({ role: 'user' as const, content });
    const a = (content: string) => ({ role: 'assistant' as const, content });
    expect(stepFor([u('brief')])).toBe('titles');
    expect(stepFor([u('brief'), a('[[TITULOS]]\nA: x\nB: y\n[[/TITULOS]]'), u('Título elegido: x')])).toBe('draft');
    expect(stepFor([u('brief'), a('t'), u('x'), a('[[COMUNICADO]]\nTexto\n[[/COMUNICADO]]'), u('más corto')])).toBe('revise');
    // An unclosed draft in the history is not a draft.
    expect(stepFor([u('brief'), a('[[COMUNICADO]] sin cerrar'), u('x')])).toBe('draft');
  });
});
