// The range rules for generated content, and the pass-rate arithmetic of the reports.
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCatalog } from '../src/catalog.ts';
import { loadCatalog, reportsDir } from '../src/files.ts';
import { batchSchema, instructions, PROMPT_VERSIONS } from '../src/prompt.ts';
import { formatStats, loadReports, RunReport, summarize, wilson } from '../src/report.ts';
import { cardSpend, checkRules, curveBudget, RULES } from '../src/rules.ts';
import { Card, ENTITY_NAMES } from '../src/schemas.ts';
import { copyCatalog, EXAMPLE, writeJson } from './helpers/catalog-dir.ts';

const checked = checkCatalog((await loadCatalog(EXAMPLE)).raw);
if (!checked.ok) throw new Error('the example catalogue must be valid');
const context = { index: checked.index, pending: new Set<string>() };

const card = (extra: Record<string, unknown>) =>
  Card.parse({ id: 'probe', name: 'Probe', set: 'core', faction: null, rarity: 'common', cost: 3, keywords: [], text: '', body: { type: 'unit', power: 3, health: 4 }, ...extra });

describe('range rules', () => {
  it('prices each card type against the same budget', () => {
    expect(curveBudget(0)).toBe(1);
    expect(curveBudget(3)).toBe(7);
    expect(cardSpend(card({}))).toBe(7);
    expect(cardSpend(card({ body: { type: 'relic', charges: 3 } }))).toBe(6);
    expect(
      cardSpend(card({ body: { type: 'spell', target: 'unit', effects: [{ kind: 'damage', amount: 2 }, { kind: 'draw', count: 1 }, { kind: 'summon', card: 'shell-spawn', count: 2 }] } })),
    ).toBe(2 + 2 + 4);
  });

  it('accepts a card on the curve and flags one point over it', () => {
    expect(checkRules('card', card({}), context)).toEqual([]);
    expect(checkRules('card', card({ body: { type: 'unit', power: 4, health: 4 } }), context)).toEqual([{ rule: 'cost-curve', message: 'spends 8 and its budget at cost 3 is 7' }]);
  });

  it('exempts tokens from the curve, but not from the other rules', () => {
    const token = card({ cost: 0, body: { type: 'unit', power: 3, health: 3, token: true }, handwritten: true });
    expect(checkRules('card', token, context).map((f) => f.rule)).toEqual(['not-handwritten']);
  });

  it('allows hand-written content to break a range rule that the catalogue accepts', () => {
    // The Drowned Queen is legendary: valid in the catalogue, never accepted from the model.
    const queen = checked.index.card.get('drowned-queen');
    expect(queen && checkRules('card', queen, context).map((f) => f.rule)).toEqual(['not-handwritten', 'no-legendary']);
  });

  it('puts a set after the last release and keeps keyword counts low', () => {
    const set = { id: 'tidal-rift', name: 'Tidal Rift', code: 'TDR', releaseOrder: 2, size: 10, handwritten: false };
    expect(checkRules('set', set, context)).toEqual([{ rule: 'next-release', message: 'release order 2 is not after the last set (2)' }]);
    expect(checkRules('set', { ...set, releaseOrder: 3 }, context)).toEqual([]);
    const busy = card({ keywords: ['guard', 'swift', 'bloom'].map((k) => ({ keyword: k, value: k === 'bloom' ? 1 : null })) });
    expect(checkRules('card', busy, context).map((f) => f.rule)).toEqual(['few-keywords']);
  });

  it('shows the model the text of every rule, in the prompt of its entity type', () => {
    for (const entity of ENTITY_NAMES) for (const rule of RULES[entity]) expect(instructions(entity)).toContain(rule.text);
    expect(new Set(ENTITY_NAMES.flatMap((e) => RULES[e].map((r) => `${e}:${r.id}`))).size).toBe(ENTITY_NAMES.reduce((n, e) => n + RULES[e].length, 0));
  });
});

describe('the output schema', () => {
  it('accepts any element on the zod side, so one bad candidate cannot void the batch', () => {
    const schema = batchSchema('card', 2);
    expect(schema.safeParse({ candidates: [{ cost: 99 }, 'not even an object'] }).success).toBe(true);
    expect(schema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('pass rate', () => {
  const report = (promptVersion: string, requested: number, accepted: number, extra: Partial<RunReport> = {}): RunReport =>
    RunReport.parse({
      run: `r-${promptVersion}-${requested}-${accepted}`,
      jobId: '00000000-0000-4000-8000-000000000000',
      entity: 'card',
      promptVersion,
      createdAt: '2026-11-04T15:00:00.000Z',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      costUsd: 0.01,
      usageId: 'u',
      failure: null,
      requested,
      returned: requested,
      ignored: 0,
      accepted: Array.from({ length: accepted }, (_, i) => `ok-${i}`),
      passRate: accepted / requested,
      rejections: Array.from({ length: requested - accepted }, (_, i) => ({ index: accepted + i, id: null, problems: [{ stage: 'rules', where: 'x', path: '', message: 'm', rule: 'cost-curve' }] })),
      ...extra,
    });

  it('gives the textbook Wilson interval', () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.4902, 4);
    expect(hi).toBeCloseTo(0.9433, 4);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('pools runs of one prompt version and never mixes versions', () => {
    const stats = summarize([report('card@1', 8, 2), report('card@1', 8, 4), report('card@2', 8, 7)]);
    expect(stats.map((s) => [s.promptVersion, s.runs, s.accepted, s.requested])).toEqual([
      ['card@1', 2, 6, 16],
      ['card@2', 1, 7, 8],
    ]);
    expect(stats[0]?.byStage).toEqual({ schema: 0, rules: 10, references: 0 });
    expect(stats[0]?.topRules).toEqual([['cost-curve', 10]]);
    expect(formatStats(stats)[0]).toBe('card card@1: 6/16 = 38% (95% CI 18% to 61%) over 2 run(s), 0 unusable; rejected at schema 0, rules 10, references 0; rules broken: cost-curve 10');
  });

  it('counts an unusable run as all failures, and an unknown cost as an unknown total', () => {
    const failed = report('card@1', 4, 0, { failure: 'truncated', returned: 0, rejections: [], costUsd: null });
    const [s] = summarize([report('card@1', 4, 4), failed]);
    expect(s).toMatchObject({ requested: 8, accepted: 4, passRate: 0.5, failedRuns: 1, costUsd: null });
  });

  it('refuses a report whose numbers do not add up', () => {
    expect(() => report('card@1', 4, 2, { passRate: 0.75 })).toThrow();
    expect(() => report('card@1', 4, 2, { rejections: [] })).toThrow();
  });

  describe('on disk', () => {
    let dir: string;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      ({ dir, cleanup } = await copyCatalog());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('reads valid reports and lists the rest without counting them', async () => {
      await writeJson(`${reportsDir(dir)}/a.json`, report(PROMPT_VERSIONS.card, 2, 1));
      await writeJson(`${reportsDir(dir)}/b.json`, { ...report(PROMPT_VERSIONS.card, 2, 1), passRate: 1 });
      await mkdir(reportsDir(dir), { recursive: true });
      await writeFile(`${reportsDir(dir)}/c.json`, 'not json');
      const loaded = await loadReports(dir);
      expect(loaded.reports).toHaveLength(1);
      expect(loaded.invalid).toEqual(['b.json', 'c.json']);
    });
  });
});
