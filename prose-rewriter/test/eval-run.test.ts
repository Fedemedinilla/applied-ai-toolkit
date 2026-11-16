// F6a step 3: the spend ledger, the budgeted gateway, the cost report and the eval CLI core,
// offline, over the scripted gateway. No key, no network; every ledger lives in a temp folder.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_MODELS, CapError, pricesInForce, RequestError, type Gateway, type Price } from '../../gateway/src/index.ts';
import type { PieceRecord } from '../evals/pipeline.ts';
import {
  budgetedGateway,
  costReport,
  costRows,
  MONTHLY_BUDGET_USD,
  openLedger,
  SpendRefusal,
  spendMonth,
  type Clock,
} from '../evals/spend.ts';
import { NOW, scriptedGateway } from './scripted-gateway.ts';

const PRICES = pricesInForce(
  BUILT_IN_MODELS.map(({ id, price }) => ({ model: id, ...price })),
  NOW,
);
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const fixed: Clock = { now: () => NOW };
const tempLedger = (): string => join(mkdtempSync(join(tmpdir(), 'eval-spend-')), 'nested', 'eval-spend.json');

/** A judge-task text call with a short fictional prompt. */
const judgeRequest = (maxTokens = 1000) => ({
  task: 'rewrite.judge',
  userId: null,
  promptVersion: 'test@1',
  maxTokens,
  system: ['You answer with one word.'],
  messages: [{ role: 'user' as const, content: 'Is this fictional sentence clear? "La panadería abre a las 8."' }] as const,
});
/** Sonnet 5.5 (the judge): 1000 input at 2, 100 output at 10 per million = US$0.003. */
const REPLY = { text: 'yes', usage: { input: 1000, output: 100 } };

describe('spendMonth', () => {
  it('keys the month by the calendar in Buenos Aires, not UTC', () => {
    expect(spendMonth(new Date('2026-12-01T02:59:59.000Z'))).toBe('2026-11');
    expect(spendMonth(new Date('2026-12-01T03:00:00.000Z'))).toBe('2026-12');
  });
});

describe('the spend ledger', () => {
  it('starts empty, creates its folder, and writes atomically with no temp file left', () => {
    const path = tempLedger();
    const ledger = openLedger({ path, monthlyCapUsd: MONTHLY_BUDGET_USD, clock: fixed });
    expect(ledger.month()).toMatchObject({ month: '2026-11', spentUsd: 0, openUsd: 0, calls: 0 });
    const r = ledger.reserve(1.5);
    expect(ledger.month()).toMatchObject({ spentUsd: 1.5, openUsd: 1.5 });
    ledger.settle(r, 0.25);
    expect(ledger.month()).toMatchObject({ spentUsd: 0.25, openUsd: 0, calls: 1 });
    expect(readdirSync(join(path, '..'))).toEqual(['eval-spend.json']);
  });

  it('refuses a reservation that would cross the monthly cap, and writes nothing then', () => {
    const path = tempLedger();
    const ledger = openLedger({ path, monthlyCapUsd: 20, clock: fixed });
    ledger.settle(ledger.reserve(19.99), 19.99);
    const before = readFileSync(path, 'utf8');
    expect(() => ledger.reserve(0.02)).toThrow(SpendRefusal);
    expect(() => ledger.reserve(0.02)).toThrow(/monthly budget/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(() => ledger.reserve(0.01)).not.toThrow();
  });

  it('refuses a cap above the budget Federico fixed, and a cap that is not a positive number', () => {
    const path = tempLedger();
    expect(() => openLedger({ path, monthlyCapUsd: 20.01, clock: fixed })).toThrow(/at most US\$20/);
    expect(() => openLedger({ path, monthlyCapUsd: 0, clock: fixed })).toThrow(/positive/);
    expect(() => openLedger({ path, monthlyCapUsd: 5, clock: fixed })).not.toThrow();
  });

  it('persists across two runs: a second ledger on the same file sees the first one spend', () => {
    const path = tempLedger();
    const first = openLedger({ path, monthlyCapUsd: 20, clock: fixed });
    first.settle(first.reserve(12), 11);
    const second = openLedger({ path, monthlyCapUsd: 20, clock: fixed });
    expect(second.month().spentUsd).toBe(11);
    expect(() => second.reserve(9.5)).toThrow(SpendRefusal);
    second.settle(second.reserve(8), 8);
    expect(openLedger({ path, monthlyCapUsd: 20, clock: fixed }).month()).toMatchObject({ spentUsd: 19, calls: 2 });
  });

  it('keeps an open reservation at its worst case, so a run that died still counts', () => {
    const path = tempLedger();
    openLedger({ path, monthlyCapUsd: 20, clock: fixed }).reserve(3);
    expect(openLedger({ path, monthlyCapUsd: 20, clock: fixed }).month()).toMatchObject({ spentUsd: 3, openUsd: 3, calls: 0 });
  });

  it('rolls over at midnight in Buenos Aires and settles a reservation into the month it was made in', () => {
    const path = tempLedger();
    let now = new Date('2026-12-01T02:59:00.000Z');
    const ledger = openLedger({ path, monthlyCapUsd: 20, clock: { now: () => now } });
    ledger.settle(ledger.reserve(19), 19);
    const late = ledger.reserve(0.5);
    now = new Date('2026-12-01T03:00:00.000Z');
    expect(ledger.month()).toMatchObject({ month: '2026-12', spentUsd: 0 });
    ledger.settle(late, 0.5);
    expect(ledger.month()).toMatchObject({ month: '2026-12', spentUsd: 0 });
    expect(ledger.month(new Date('2026-11-30T12:00:00.000Z'))).toMatchObject({ month: '2026-11', spentUsd: 19.5, calls: 2 });
    expect(() => ledger.reserve(19.9)).not.toThrow();
  });

  it('fails closed on a file it cannot read, and never overwrites it', () => {
    const path = tempLedger();
    openLedger({ path, monthlyCapUsd: 20, clock: fixed }).reserve(0);
    writeFileSync(path, '{"format":"something else"}');
    expect(() => openLedger({ path, monthlyCapUsd: 20, clock: fixed }).month()).toThrow(/ledger/);
    expect(readFileSync(path, 'utf8')).toBe('{"format":"something else"}');
  });
});

describe('the budgeted gateway', () => {
  const setup = (script: Parameters<typeof scriptedGateway>[0], options: { cap?: number; maxRunUsd?: number | null; prices?: ReadonlyMap<string, Price>; path?: string } = {}) => {
    const scripted = scriptedGateway(script);
    const path = options.path ?? tempLedger();
    const ledger = openLedger({ path, monthlyCapUsd: options.cap ?? 20, clock: fixed });
    const budget = budgetedGateway(scripted.gateway as Gateway<string>, { ledger, prices: () => options.prices ?? PRICES, maxRunUsd: options.maxRunUsd ?? null });
    return { scripted, ledger, budget, path };
  };

  it('reserves the worst case before the call and settles to the real cost after it', async () => {
    const { scripted, ledger, budget } = setup({ 'rewrite.judge': [REPLY] });
    const result = await budget.gateway.text(judgeRequest());
    scripted.assertDone();
    expect(result.meta.costUsd).toBe(0.003);
    expect(ledger.month()).toMatchObject({ spentUsd: 0.003, openUsd: 0, calls: 1 });
    expect(budget.run()).toMatchObject({ spentUsd: 0.003, calls: 1 });
  });

  it('refuses a call whose worst case would cross the monthly cap: the API is never called', async () => {
    const path = tempLedger();
    const seed = openLedger({ path, monthlyCapUsd: 20, clock: fixed });
    seed.settle(seed.reserve(19.995), 19.995);
    // Worst case of a 1000-token judge reply alone is US$0.01 at Sonnet 5.5's output price.
    const { scripted, budget, ledger } = setup({ 'rewrite.judge': [REPLY] }, { path });
    const refused = budget.gateway.text(judgeRequest());
    await expect(refused).rejects.toThrow(SpendRefusal);
    await expect(refused).rejects.toBeInstanceOf(CapError);
    expect(scripted.calls).toHaveLength(0);
    expect(ledger.month()).toMatchObject({ spentUsd: 19.995, openUsd: 0 });
  });

  it('refuses a call over the per-run cap, apart from the month', async () => {
    const { scripted, budget } = setup({ 'rewrite.judge': [REPLY, REPLY] }, { maxRunUsd: 0.012 });
    await budget.gateway.text(judgeRequest());
    await expect(budget.gateway.text(judgeRequest())).rejects.toThrow(/per-run cap/);
    expect(scripted.calls).toHaveLength(1);
  });

  it('refuses a model without a price, failing closed', async () => {
    const prices = new Map([...PRICES].filter(([model]) => model !== 'claude-sonnet-5-5'));
    const { scripted, budget, ledger } = setup({ 'rewrite.judge': [REPLY] }, { prices });
    await expect(budget.gateway.text(judgeRequest())).rejects.toThrow(/no price for claude-sonnet-5-5/);
    expect(scripted.calls).toHaveLength(0);
    expect(ledger.month().spentUsd).toBe(0);
  });

  it('prices the model a request overrides, not the task config', async () => {
    const prices = new Map([...PRICES].filter(([model]) => model !== 'claude-opus-5-5'));
    const { scripted, budget } = setup({ 'rewrite.judge': [REPLY] }, { prices });
    await expect(budget.gateway.text({ ...judgeRequest(), config: { model: 'claude-opus-5-5', effort: 'medium' } })).rejects.toThrow(/no price for claude-opus-5-5/);
    expect(scripted.calls).toHaveLength(0);
  });

  it('refuses a task it has no model for', async () => {
    const { budget } = setup({});
    await expect(budget.gateway.text({ ...judgeRequest(), task: 'summary' })).rejects.toThrow(/no model for task summary/);
  });

  it('releases the reservation of a call the gateway refused before sending', async () => {
    // A userId that is not a UUID: the gateway refuses the request before the API.
    const { scripted, budget, ledger } = setup({ 'rewrite.judge': [REPLY] });
    await expect(budget.gateway.text({ ...judgeRequest(), userId: 'not-a-uuid' })).rejects.toThrow(RequestError);
    expect(scripted.calls[0]?.sent).toBeNull();
    expect(ledger.month()).toMatchObject({ spentUsd: 0, openUsd: 0 });
  });
});

const piece = (over: Partial<PieceRecord> & { usage: PieceRecord['usage'] }): PieceRecord =>
  ({ case: 'c', genre: 'email', lang: 'es', mode: 'pulido', variant: 'full', status: 'failed', error: 'x', ...over }) as PieceRecord;
const tokens = (input: number, cacheRead: number) => ({ input, output: 0, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 });

describe('the cost report', () => {
  it('gives median and p90 cost, cache hit rate, calls and extra-round share per variant, genre and mode', () => {
    const rows = costRows([
      piece({ case: 'a', usage: { calls: 3, costUsd: 0.1, tokens: tokens(800, 200), extraRound: false } }),
      piece({ case: 'b', usage: { calls: 4, costUsd: 0.3, tokens: tokens(400, 600), extraRound: true } }),
      piece({ case: 'c', usage: { calls: 5, costUsd: 0.2, tokens: tokens(0, 0), extraRound: false } }),
      piece({ case: 'd', usage: { calls: 3, costUsd: null, tokens: tokens(0, 0), extraRound: false } }),
      piece({ case: 'e', genre: 'whatsapp', mode: 'minimo', usage: { calls: 0, costUsd: 0, tokens: tokens(0, 0), extraRound: false } }),
    ]);
    expect(rows).toEqual([
      { variant: 'full', genre: 'email', mode: 'pulido', pieces: 4, priced: 3, medianUsd: 0.2, p90Usd: 0.3, cacheHitRate: 0.4, callsPerRewrite: 3.75, extraRoundShare: 0.25 },
      { variant: 'full', genre: 'whatsapp', mode: 'minimo', pieces: 1, priced: 1, medianUsd: 0, p90Usd: 0, cacheHitRate: null, callsPerRewrite: 0, extraRoundShare: 0 },
    ]);
    const md = costReport(rows);
    expect(md).toContain('| variant | genre | mode | pieces | priced | median US$ | p90 US$ | cache hit | calls per rewrite | extra round |');
    expect(md).toContain('| full | email | pulido | 4 | 3 | 0.2000 | 0.3000 | 40% | 3.75 | 25% |');
    expect(md).toContain('| full | whatsapp | minimo | 1 | 1 | 0.0000 | 0.0000 | n/a | 0.00 | 0% |');
  });

  it('says so when no piece has a price', () => {
    const rows = costRows([piece({ usage: { calls: 1, costUsd: null, tokens: tokens(0, 0), extraRound: false } })]);
    expect(rows[0]).toMatchObject({ priced: 0, medianUsd: null, p90Usd: null });
    expect(costReport(rows)).toContain('| full | email | pulido | 1 | 0 | n/a | n/a |');
  });
});

