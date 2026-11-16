// The output schemas of the model stages S2 to S4 (design 4.4): what a plan, an edit reply and a
// style reply may hold, checked the way the gateway checks a structured reply. Offline.
import { describe, expect, it } from 'vitest';
import { ResponseError, structuredFormat } from '../../gateway/src/index.ts';
import { EditOutput, PLAN_ACTIONS, PlanOutput, STYLE_MAX_EDITS, styleOutput } from '../src/outputs.ts';
import { scriptedGateway, USER } from './scripted-gateway.ts';

const edit = { sentenceId: 0, before: 'Me encantaría', after: 'Quiero', reason: 'quita la fórmula' };
const ok = <T>(schema: Parameters<typeof structuredFormat>[0], data: T) => structuredFormat(schema).validate(JSON.stringify(data));

describe('the plan output (S2)', () => {
  it('holds an action and a reason per sentence, and no text', () => {
    const plan = { items: [{ sentenceId: 0, action: 'cut', reason: 'repite el saludo' }, { sentenceId: 1, action: 'keep', reason: 'ya es concreta' }] };
    expect(ok(PlanOutput, plan)).toEqual({ ok: true, data: plan });
    // No field carries rewritten text: an item with one is refused.
    expect(ok(PlanOutput, { items: [{ ...plan.items[0], after: 'Hola.' }] }).ok).toBe(false);
    expect(PLAN_ACTIONS).toEqual(['cut', 'make-specific', 'remove-formula', 'keep']);
  });

  it('asks for a missing fact only with a labelled [COMPLETAR: ...]', () => {
    const item = { sentenceId: 2, action: 'make-specific', reason: 'falta la fecha de la propuesta' };
    expect(ok(PlanOutput, { items: [{ ...item, request: '[COMPLETAR: fecha de la propuesta]' }] }).ok).toBe(true);
    for (const request of ['[COMPLETAR]', '[COMPLETAR: ]', '[COMPLETAR:]', 'fecha de la propuesta', '[COMPLETAR: fecha] y algo más', '[COMPLETAR:\u200B]', '[COMPLETAR:\u00AD]', '[COMPLETAR: ...]', '[COMPLETAR: fe\u200Bcha]']) {
      expect(ok(PlanOutput, { items: [{ ...item, request }] }).ok, request).toBe(false);
    }
  });
});

describe('the edit output (S3)', () => {
  it('is an array of the existing Edit schema', () => {
    expect(ok(EditOutput, { edits: [edit] })).toEqual({ ok: true, data: { edits: [edit] } });
    expect(ok(EditOutput, { edits: [{ ...edit, after: 'Quiero sumarme el [COMPLETAR: fecha de inicio].' }] }).ok).toBe(true);
  });

  it('refuses a bare [COMPLETAR] in a scripted edit reply', async () => {
    const bare = { edits: [{ ...edit, after: 'Quiero sumarme el [COMPLETAR].' }] };
    const fake = scriptedGateway({ 'rewrite.edit': [{ data: bare }] });
    const call = fake.gateway.structured(EditOutput, {
      task: 'rewrite.edit',
      userId: USER,
      promptVersion: 'rewrite-edit@test',
      maxTokens: 1000,
      system: ['Edit.'],
      messages: [{ role: 'user', content: 'Edit the text.' }],
    });
    const error: unknown = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseError);
    // The problem names the field, never the text: edits.0.after failed its refinement.
    expect((error as ResponseError).problems).toEqual([{ path: 'edits.0.after', code: 'custom' }]);
    expect(fake.calls[0]?.sent).not.toBeNull();
    expect(ok(EditOutput, bare).ok).toBe(false);
  });
});

describe('what an edit may write', () => {
  const style = styleOutput(['es-lead-with-the-point']);
  const both = (after: string, before = edit.before) => [
    ok(EditOutput, { edits: [{ ...edit, before, after }] }).ok,
    ok(style, { edits: [{ ...edit, before, after, principleId: 'es-lead-with-the-point' }] }).ok,
  ];

  it('refuses a bare or unlabelled marker hidden with an invisible character', () => {
    for (const after of ['Quiero el [COMPLETAR\u200B].', 'Quiero el [\u200BCOMPLETAR].', 'Quiero el [COMPLETAR: ...].', 'Quiero el [COMPLETAR:\u00AD].']) {
      expect(both(after), after).toEqual([false, false]);
    }
    expect(both('Quiero sumarme el [COMPLETAR: fecha de inicio].')).toEqual([true, true]);
  });

  it('refuses a placeholder slop-lint reports as FMT-04, unless the quoted text already had it', () => {
    for (const after of ['Quiero sumarme a [Nombre de la empresa].', 'Hablamos el {{fecha}}.', 'Hablamos el [Fecha de la llamada].']) {
      expect(both(after), after).toEqual([false, false]);
    }
    expect(both('Quiero sumarme a [Nombre de la empresa].', 'Me encantaría sumarme a [Nombre de la empresa].')).toEqual([true, true]);
  });

  it('stays within its sentence: at most one sentence more than the text it replaces', () => {
    expect(both('Estimado equipo. Escribo para postularme. Tengo cinco años con Astro. Saludos.', 'Hola.')).toEqual([false, false]);
    expect(both('Gracias. Quiero sumarme.', 'Me encantaría sumarme.')).toEqual([true, true]);
    expect(both('Uno. Dos. Tres.', 'Uno y dos. Tres.')).toEqual([true, true]);
  });

  it('counts sentences with no space after the period, or on lines that start in lowercase', () => {
    const before = 'Quería comentarte que me apasiona potenciar sinergias.';
    expect(both('quería contarte que el sitio está listo.te aviso cuando esté online.te mando el link mañana.te escribo pronto.', before)).toEqual([false, false]);
    expect(both('quería contarte que el sitio está listo\nte aviso cuando esté online\nte mando el link mañana', before)).toEqual([false, false]);
    // A decimal and a domain the quote already has are no new sentence.
    expect(both('El sitio carga en 1.6 s en panaderia.ar.', 'El sitio de panaderia.ar carga en 1.6 s.')).toEqual([true, true]);
  });

  it('names the field and never the text when it refuses one', () => {
    const result = ok(EditOutput, { edits: [{ ...edit, before: 'Hola.', after: 'Estimado equipo. Escribo para postularme. Tengo cinco años con Astro.' }] });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Astro');
  });
});

describe('the style output (S4)', () => {
  const ids = ['es-lead-with-the-point', 'es-verb-not-abstract-noun'];

  it('cites one of the principles the prompt showed', () => {
    const reply = { edits: [{ ...edit, principleId: 'es-lead-with-the-point' }] };
    expect(ok(styleOutput(ids), reply)).toEqual({ ok: true, data: reply });
    expect(ok(styleOutput(ids), { edits: [edit] }).ok).toBe(false);
    expect(ok(styleOutput(ids), { edits: [{ ...edit, principleId: 'es-made-up' }] }).ok).toBe(false);
  });

  it('caps the edits per text', () => {
    const one = { ...edit, principleId: ids[0] };
    expect(ok(styleOutput(ids), { edits: Array.from({ length: STYLE_MAX_EDITS }, (_, i) => ({ ...one, sentenceId: i })) }).ok).toBe(true);
    expect(ok(styleOutput(ids), { edits: Array.from({ length: STYLE_MAX_EDITS + 1 }, (_, i) => ({ ...one, sentenceId: i })) }).ok).toBe(false);
  });

  it('allows no edit when no principle applies', () => {
    expect(ok(styleOutput([]), { edits: [] }).ok).toBe(true);
    expect(ok(styleOutput([]), { edits: [{ ...edit, principleId: 'es-lead-with-the-point' }] }).ok).toBe(false);
  });

  it('every schema converts to a format the gateway accepts', () => {
    for (const schema of [PlanOutput, EditOutput, styleOutput(ids), styleOutput([])]) expect(() => structuredFormat(schema)).not.toThrow();
  });
});
