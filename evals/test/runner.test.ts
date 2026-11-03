import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCK, createWriterTarget, todayLine, WRITER_CALL, writerSystem, type Lang } from '../example/business.ts';
import { PROBES } from '../example/cases.ts';
import { recordingClient, reply } from '../example/fake-models.ts';
import { VARIANTS } from '../example/variants.ts';
import { applyEdits, type Variant } from '../src/variants.ts';
import { DUMP_NOW, dumpPrompts, planJobs, runEval, type WriterTarget } from '../src/runner.ts';

const target = createWriterTarget();
const now = new Date('2026-03-04T12:00:00Z');
const ids = VARIANTS.map((v) => v.id);

describe('planJobs', () => {
  it('interleaves variants so a run cut short covers them equally', () => {
    const jobs = planJobs(PROBES, ids, ['en', 'es'], 3);
    expect(jobs).toHaveLength(PROBES.length * ids.length * 2 * 3);
    const firstSample = jobs.slice(0, PROBES.length * 2 * ids.length);
    for (const id of ids) expect(firstSample.filter((j) => j.variant === id)).toHaveLength(PROBES.length * 2);
    expect(firstSample.every((j) => j.sample === 1)).toBe(true);
  });

  it('rejects a sample count that is not a positive integer', () => {
    expect(() => planJobs(PROBES, ids, ['en'], 0)).toThrow();
    expect(() => planJobs(PROBES, ids, ['en'], 1.5)).toThrow();
  });
});

describe('runEval', () => {
  it('sends the production call settings and the edited prompt', async () => {
    const client = recordingClient(() => reply('Piece text here.'));
    const jobs = planJobs(PROBES.slice(0, 1), ['V0', 'V4'], ['en'], 1);
    const { rows } = await runEval({ client, target, variants: VARIANTS, jobs, now });

    expect(client.requests).toHaveLength(2);
    for (const r of client.requests) {
      expect(r.model).toBe(WRITER_CALL.model);
      expect(r.max_tokens).toBe(WRITER_CALL.max_tokens);
      expect(r.output_config).toEqual(WRITER_CALL.output_config);
      expect(r.messages).toEqual([{ role: 'user', content: PROBES[0]!.brief.en }]);
    }
    const [v0, v4] = client.requests;
    expect(v0!.system).toEqual(target.system(PROBES[0]!, 'en', now));
    expect(v0!.system[BLOCK.date]!.text).toBe(todayLine(now, 'en'));
    expect(v4!.system[0]!.text).toContain('A procedure is a fact too');
    expect(rows.map((r) => [r.variant, r.words, r.stop, r.now])).toEqual([
      ['V0', 3, 'end_turn', now.toISOString()],
      ['V4', 3, 'end_turn', now.toISOString()],
    ]);
  });

  it('stops before the first call when an edit misses', async () => {
    const client = recordingClient(() => reply('x'));
    const broken: Variant<Lang>[] = [...VARIANTS, { id: 'VX', what: 'stale', edits: () => [{ block: 0, find: 'text that is gone', replace: 'y' }] }];
    const jobs = planJobs(PROBES, ['V0', 'VX'], ['en'], 1);
    await expect(runEval({ client, target, variants: broken, jobs })).rejects.toThrow(/0 matches/);
    expect(client.requests).toHaveLength(0);
  });

  it('records a failed call and keeps going', async () => {
    let n = 0;
    const client = recordingClient(() => {
      if (++n === 2) throw Object.assign(new Error('overloaded'), { status: 529 });
      return reply('ok');
    });
    const failures: unknown[] = [];
    const jobs = planJobs(PROBES.slice(0, 3), ['V0'], ['en'], 1);
    const res = await runEval({ client, target, variants: VARIANTS, jobs, concurrency: 1, onFailure: (f) => failures.push(f) });
    expect(res.rows).toHaveLength(2);
    expect(res.failures).toEqual([{ variant: 'V0', lang: 'en', case: PROBES[1]!.id, sample: 1, error: '529 overloaded' }]);
    expect(failures).toHaveLength(1);
  });

  it('never runs more calls at once than the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const client = recordingClient(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return reply('ok');
    });
    const jobs = planJobs(PROBES, ids, ['en'], 1);
    await runEval({ client, target, variants: VARIANTS, jobs, concurrency: 3 });
    expect(peak).toBe(3);
    expect(client.requests).toHaveLength(jobs.length);
  });
});

describe('dumpPrompts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not depend on the day it runs', () => {
    const jobs = planJobs(PROBES, ['V4'], ['en', 'es'], 1);
    vi.useFakeTimers({ now: new Date('2026-11-02T10:00:00Z') });
    const monday = dumpPrompts(target, VARIANTS, jobs);
    vi.setSystemTime(new Date('2026-11-06T23:30:00Z'));
    const friday = dumpPrompts(target, VARIANTS, jobs);
    expect(friday).toEqual(monday);
    expect(monday[`en ${PROBES[0]!.id}`]![BLOCK.date]!.text).toBe(todayLine(DUMP_NOW, 'en'));
  });

  it('a dump of the winning variant equals a dump of V0 after the product ships it', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T10:00:00Z') });
    const before = dumpPrompts(target, VARIANTS, planJobs(PROBES, ['V4'], ['en', 'es'], 1));

    // Shipping changes the product, not the variant list: the target's own
    // builder now produces what V4 produced, and V0 has no edits.
    const v4 = VARIANTS.find((v) => v.id === 'V4')!;
    const shippedTarget: WriterTarget<(typeof PROBES)[number], Lang> = {
      ...target,
      system: (c, lang, at) => applyEdits(writerSystem(c, lang, at), v4.edits(lang)),
    };
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    const after = dumpPrompts(shippedTarget, [VARIANTS[0]!], planJobs(PROBES, ['V0'], ['en', 'es'], 1));
    expect(after).toEqual(before);

    // And a product that shipped something else does not pass.
    const v3 = VARIANTS.find((v) => v.id === 'V3')!;
    const wrongTarget: WriterTarget<(typeof PROBES)[number], Lang> = {
      ...target,
      system: (c, lang, at) => applyEdits(writerSystem(c, lang, at), v3.edits(lang)),
    };
    expect(dumpPrompts(wrongTarget, [VARIANTS[0]!], planJobs(PROBES, ['V0'], ['en', 'es'], 1))).not.toEqual(before);
  });

  it('refuses a dump that mixes variants with different prompts', () => {
    expect(() => dumpPrompts(target, VARIANTS, planJobs(PROBES, ['V0', 'V4'], ['en'], 1))).toThrow(/one variant at a time/);
  });
});
