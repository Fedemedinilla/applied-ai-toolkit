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
    for (const request of ['[COMPLETAR]', '[COMPLETAR: ]', '[COMPLETAR:]', 'fecha de la propuesta', '[COMPLETAR: fecha] y algo más']) {
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
