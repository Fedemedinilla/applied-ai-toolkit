// The writer's eval case: the target gives the runner the product's own prompt, the NC variant
// removes exactly the [COMPLETAR] rule, the deterministic score reads specifics correctly, and a
// whole run with scripted models lands each invention on the right variant. No key, no network.

import { describe, expect, it } from 'vitest';
import type { ModelClient, ModelRequest } from '../../../evals/src/index.ts';
import { dumpPrompts, planJobs, preflight, runEval, systemFor } from '../../../evals/src/index.ts';
import { CASE_SETS, COMPLETE, GAPS } from '../evals/cases.ts';
import { gatewayModelClient } from '../evals/model-client.ts';
import { scoreRows, toMarkdown } from '../evals/score.ts';
import { scoreDraft, specifics, supported } from '../evals/specifics.ts';
import { createWriterTarget, factSheet, LANGS, lookup, userMessage, WRITER_CALL, type WriterEvalCase } from '../evals/target.ts';
import { VARIANTS } from '../evals/variants.ts';
import { createWriterModel, EFFORT, MAX_TOKENS, MODEL } from '../server/model.ts';
import { BLOCK, buildSystem, COMPLETAR_RULE, PROMPT_VERSION } from '../server/prompt.ts';
import { fakeAnthropic, streamed } from './fake-anthropic.ts';
import { realConfig } from './raw-config.ts';

const config = realConfig();
const target = createWriterTarget(config);
const NOW = new Date('2026-11-04T13:30:00Z');
const ALL = CASE_SETS['all']!;
const byId = (id: string): WriterEvalCase => ALL.find((c) => c.id === id) ?? (() => { throw new Error(id); })();

describe('the target', () => {
  it('has ten cases, each for a role that writes its category', () => {
    expect(COMPLETE).toHaveLength(4);
    expect(GAPS).toHaveLength(6);
    expect(new Set(ALL.map((c) => c.id)).size).toBe(ALL.length);
    for (const c of ALL) expect(() => lookup(config, c)).not.toThrow();
  });

  it('uses no relative date in a brief or a title, so every day of the month must come from the brief', () => {
    // A weekday counts as relative unless a day number follows it ("el lunes 16" is absolute).
    const RELATIVE =
      /\b(?:hoy|ayer|mañana|pasado mañana|la semana (?:que viene|próxima|pasada)|el (?:mes|año) que viene|el próximo|la próxima)\b|\b(?:el|este) (?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b(?! \d)/iu;
    expect(RELATIVE.test('El viernes hubo un incidente.')).toBe(true);
    expect(RELATIVE.test('va al planetario la semana que viene')).toBe(true);
    expect(RELATIVE.test('El lunes 16 de noviembre no hay clases.')).toBe(false);
    for (const c of ALL) expect(`${c.brief} ${c.title}`, c.id).not.toMatch(RELATIVE);
  });

  it('V0 sends the product prompt at the draft step, with the product call settings', () => {
    expect(WRITER_CALL).toEqual({ model: MODEL, max_tokens: MAX_TOKENS, output_config: { effort: EFFORT } });
    for (const c of ALL) {
      const { role, category } = lookup(config, c);
      const v0 = systemFor(target, VARIANTS, { variant: 'V0', lang: 'es', c, sample: 1 }, NOW);
      expect(v0.map((b) => b.text)).toEqual(buildSystem(config, role, category, 'draft', NOW));
    }
  });

  it('sends the brief and the chosen title in one user message, in the product tags', () => {
    expect(userMessage(byId('reunion-campamento'))).toBe(
      '<brief>\nReunión con las familias de 2.º grado para hablar del campamento.\n</brief>\n\n<message>\nTítulo elegido: Reunión de familias por el campamento\n</message>',
    );
  });

  it('the fact sheet holds the school facts, the brief, the title, the signature and the date, and no example', () => {
    const sheet = factSheet(config, byId('reunion-campamento'), NOW);
    expect(sheet).toContain(config.school.facts[0]);
    expect(sheet).toContain('2.º grado');
    expect(sheet).toContain('Equipo docente de [COMPLETAR: grado o curso]');
    expect(sheet).toContain('TODAY: miércoles, 4 de noviembre de 2026');
    expect(sheet).not.toContain(config.examples[0]!.es.slice(0, 40));
  });
});

describe('the NC variant', () => {
  it('applies to every case, and removes the rule and the call-to-action clause only', () => {
    const jobs = planJobs(ALL, VARIANTS.map((v) => v.id), LANGS, 1);
    expect(() => preflight(target, VARIANTS, jobs, NOW)).not.toThrow();
    for (const c of ALL) {
      const v0 = systemFor(target, VARIANTS, { variant: 'V0', lang: 'es', c, sample: 1 }, NOW);
      const nc = systemFor(target, VARIANTS, { variant: 'NC', lang: 'es', c, sample: 1 }, NOW);
      expect(nc[BLOCK.rules]?.text).toBe(v0[BLOCK.rules]?.text.replace(`${COMPLETAR_RULE}\n\n`, ''));
      expect(nc[BLOCK.rules]?.text).not.toContain('# 3. Missing facts');
      expect(nc[BLOCK.school]).toEqual(v0[BLOCK.school]);
      expect(nc[BLOCK.turn]).toEqual(v0[BLOCK.turn]);
      expect(nc[BLOCK.category]?.text).not.toContain('write [COMPLETAR: enlace]');
    }
  });

  it('a dump of NC differs from a dump of V0, and each dump is one variant', () => {
    const one = (id: string) => dumpPrompts(target, VARIANTS, planJobs(GAPS, [id], LANGS, 1));
    expect(one('NC')).not.toEqual(one('V0'));
    expect(() => dumpPrompts(target, VARIANTS, planJobs(GAPS, ['V0', 'NC'], LANGS, 1))).toThrow(/dump one variant at a time/u);
  });
});

describe('specifics', () => {
  it('reads times, numbers, emails and links, and skips the gaps', () => {
    expect(specifics('El 12 a las 8:30 y a las 18.00, [COMPLETAR: lugar 3], escribir a a@b.example o www.x.test. Cuota: 1.200.')).toEqual([
      { kind: 'url', text: 'www.x.test' },
      { kind: 'email', text: 'a@b.example' },
      { kind: 'time', text: '8:30' },
      { kind: 'time', text: '18.00' },
      { kind: 'number', text: '12' },
      { kind: 'number', text: '1.200' },
    ]);
  });

  it('a time is supported by itself or by its bare hour; a number by the same digits', () => {
    const sheet = 'Reunión el 24 de noviembre a las 18 en el salón. Recargo del 5%. Atiende de 8:00 a 15:00. Cuota 1200.';
    const ok = (kind: 'time' | 'number', text: string) => supported({ kind, text }, sheet);
    expect(ok('time', '18:00')).toBe(true);
    expect(ok('time', '18:30')).toBe(false);
    expect(ok('time', '08:00')).toBe(true);
    expect(ok('number', '24')).toBe(true);
    expect(ok('number', '5')).toBe(true);
    expect(ok('number', '8')).toBe(true);
    expect(ok('number', '1.200')).toBe(true);
    expect(ok('number', '25')).toBe(false);
    expect(supported({ kind: 'email', text: 'secretaria@montelirio.example' }, config.school.facts.join('\n'))).toBe(true);
  });

  it('scores a draft: protocol, gaps and each unsupported specific once', () => {
    const sheet = factSheet(config, byId('reunion-campamento'), NOW);
    const invented = '[[COMUNICADO]]\nEstimadas familias:\n\nLas esperamos el **jueves 12 de noviembre a las 18:30** en el aula de 2.º grado. Duración: 45 minutos. El jueves 12 hablamos del campamento.\n\nEquipo docente de 2.º grado\n[[/COMUNICADO]]';
    expect(scoreDraft(invented, sheet)).toEqual({
      protocol: true,
      gaps: 0,
      unsupported: [
        { kind: 'time', text: '18:30' },
        { kind: 'number', text: '12' },
        { kind: 'number', text: '45' },
      ],
    });
    const marked = '[[COMUNICADO]]\nLas esperamos el [COMPLETAR: día] a las [COMPLETAR: hora] para hablar del campamento de 2.º grado.\n[[/COMUNICADO]]';
    expect(scoreDraft(marked, sheet)).toEqual({ protocol: true, gaps: 2, unsupported: [] });
    expect(scoreDraft('Sin bloque, el 3 de mayo.', sheet).protocol).toBe(false);
  });
});

describe('a whole run with scripted models', () => {
  /** V0 marks the gap; NC invents a time. Complete briefs get a clean draft from both. */
  function scripted(failNcOnce: boolean): ModelClient & { seen: ModelRequest[] } {
    const seen: ModelRequest[] = [];
    let failed = !failNcOnce;
    return {
      seen,
      async create(request) {
        seen.push(request);
        const isNc = !request.system[BLOCK.rules]?.text.includes(COMPLETAR_RULE);
        const gaps = request.messages[0]?.content.includes('campamento') ?? false;
        if (isNc && !failed) {
          failed = true;
          throw Object.assign(new Error('overloaded'), { status: 529 });
        }
        const body = !gaps ? 'Texto sin cifras nuevas.' : isNc ? 'Reunión a las 18:30 en el aula.' : 'Reunión el [COMPLETAR: día] a las [COMPLETAR: hora].';
        return {
          text: `[[COMUNICADO]]\n${body}\n[[/COMUNICADO]]`,
          stopReason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    };
  }

  it('puts the invention on NC, the gaps on V0, and counts the failed call', async () => {
    const cases = [byId('reunion-campamento'), byId('horario-secretaria')];
    const client = scripted(true);
    const { rows, failures } = await runEval({ client, target, variants: VARIANTS, jobs: planJobs(cases, ['V0', 'NC'], LANGS, 2), now: NOW, concurrency: 1 });
    expect(client.seen.every((r) => r.model === MODEL && r.max_tokens === MAX_TOKENS)).toBe(true);
    expect(failures).toHaveLength(1);
    const table = scoreRows(config, [...rows, ...failures]);
    const row = (variant: string, probe: string) => table.find((r) => r.variant === variant && r.probe === probe);
    expect(row('V0', 'gaps')).toMatchObject({ pieces: 2, failed: 0, invented: 0, withGaps: 2 });
    expect(row('NC', 'gaps')).toMatchObject({ pieces: 1, failed: 1, invented: 1, withGaps: 0 });
    expect(row('NC', 'gaps')?.examples).toEqual(['reunion-campamento: 18:30']);
    expect(row('V0', 'complete')).toMatchObject({ pieces: 2, invented: 0, withGaps: 0 });
    const md = toMarkdown(table);
    expect(md).toContain('| NC | gaps | 1 | 1 | 0 | 1/1 (100%, 21-100%) | 0/1 (0%, 0-79%) |');
  });
});

describe('the gateway as the eval client', () => {
  it('sends the eval prompt through the gateway, labelled in the ledger', async () => {
    const api = fakeAnthropic([streamed('[[COMUNICADO]]\nHola.\n[[/COMUNICADO]]')]);
    const { gateway, stores } = createWriterModel({ apiKey: 'sk-fake', fetch: api.fetch, clock: { now: () => NOW, monotonicMs: () => 0 }, log: () => undefined });
    const c = byId('aumento-cuota');
    const request = { ...WRITER_CALL, system: target.system(c, 'es', NOW), messages: [{ role: 'user' as const, content: userMessage(c) }] };
    const reply = await gatewayModelClient(gateway).create(request);
    expect(reply.text).toBe('[[COMUNICADO]]\nHola.\n[[/COMUNICADO]]');
    expect(reply.usage.input_tokens).toBe(3000);
    expect((api.requests[0]?.body['system'] as Array<{ text: string }>).map((b) => b.text)).toEqual(request.system.map((b) => b.text));
    expect(stores.usage.calls.map((r) => r.promptVersion)).toEqual([`${PROMPT_VERSION}+eval`]);
  });

  it('refuses call settings that differ from the gateway task, before any call', async () => {
    const api = fakeAnthropic([]);
    const { gateway } = createWriterModel({ apiKey: 'sk-fake', fetch: api.fetch, log: () => undefined });
    const c = byId('aumento-cuota');
    const base = { system: target.system(c, 'es', NOW), messages: [{ role: 'user' as const, content: 'x' }] };
    await expect(gatewayModelClient(gateway).create({ ...WRITER_CALL, ...base, model: 'claude-opus-5-5' })).rejects.toThrow(/differ from the gateway task/u);
    await expect(gatewayModelClient(gateway).create({ ...WRITER_CALL, ...base, output_config: { effort: 'high' } })).rejects.toThrow(/differ/u);
    expect(api.requests).toHaveLength(0);
  });
});
