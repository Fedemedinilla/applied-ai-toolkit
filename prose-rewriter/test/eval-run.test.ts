// F6a step 3: the spend ledger, the budgeted gateway, the cost report and the eval CLI core,
// offline, over the scripted gateway. No key, no network; every ledger lives in a temp folder.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, BUILT_IN_MODELS, CapError, pricesInForce, RequestError, ResponseError, type Gateway, type Price } from '../../gateway/src/index.ts';
import { DEFAULT_MARGIN } from '../../evals/src/index.ts';
import type { PieceRecord } from '../evals/pipeline.ts';
import {
  budgetedGateway,
  costReport,
  costRows,
  LOCK_STALE_MS,
  MONTHLY_BUDGET_USD,
  MONTHLY_CAP_CEILING_USD,
  openLedger,
  requestInputTokens,
  SpendRefusal,
  spendMonth,
  worstCaseUsd,
  type Clock,
} from '../evals/spend.ts';
import { Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import type { LoadedCase } from '../evals/cases.ts';
import { EVAL_EXIT, estimateRun, gateReport, parseEvalArgs, runEvalCli, type EvalCliDeps } from '../evals/run.ts';
import type { JudgeRecord } from '../evals/judges.ts';
import type { CodeRecord } from '../evals/rubrics.ts';
import { JUDGE_MAX_TOKENS, JUDGE_RUBRICS } from '../evals/judges.ts';
import { VARIANTS } from '../evals/pipeline.ts';
import { judgeLines, rewriteRubric } from '../src/rubric.ts';
import { STAGE_MAX_TOKENS } from '../src/stages/model.ts';
import { TASK_CONFIGS } from '../src/tasks.ts';
import { estimateInputTokens } from '../../gateway/src/index.ts';
import type { PromptRefs } from '../src/prompt.ts';
import { RewriteInput } from '../src/types.ts';
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

  it('refuses a cap above the default budget unless it was raised on purpose, and a cap that is not a positive number', () => {
    const path = tempLedger();
    expect(MONTHLY_BUDGET_USD).toBe(20);
    expect(() => openLedger({ path, monthlyCapUsd: 20.01, clock: fixed })).toThrow(/above the default of US\$20.*--monthly-cap/);
    expect(() => openLedger({ path, monthlyCapUsd: 0, clock: fixed })).toThrow(/positive/);
    expect(() => openLedger({ path, monthlyCapUsd: 0, clock: fixed, raised: true })).toThrow(/positive/);
    expect(() => openLedger({ path, monthlyCapUsd: 5, clock: fixed })).not.toThrow();
    // A flag raises the cap only up to MONTHLY_CAP_CEILING_USD, so a typo (500 for 50) cannot multiply the budget.
    expect(MONTHLY_CAP_CEILING_USD).toBe(80);
    expect(() => openLedger({ path, monthlyCapUsd: 80.01, clock: fixed, raised: true })).toThrow(/ceiling of US\$80/);
    expect(() => openLedger({ path, monthlyCapUsd: 1e303, clock: fixed, raised: true })).toThrow(/ceiling of US\$80/);
    // November 2026: 50 (Federico, 16/11/2026), then 80 (17/11/2026), set with the flag; the ledger then holds that cap.
    const raised = openLedger({ path, monthlyCapUsd: 50, clock: fixed, raised: true });
    raised.settle(raised.reserve(45), 45);
    expect(raised.month()).toMatchObject({ capUsd: 50, spentUsd: 45, remainingUsd: 5 });
    expect(() => raised.reserve(5.01)).toThrow(SpendRefusal);
    // The next run at the default sees the same spend against 20 and refuses any call.
    expect(() => openLedger({ path, monthlyCapUsd: 20, clock: fixed }).reserve(0.01)).toThrow(SpendRefusal);
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

  it('holds the cap and loses no spend when several processes share the file at once', async () => {
    // Each child reserves and settles US$0.05 until the US$1 cap refuses it, then prints how many
    // reservations it got. Without a lock the children read the same totals, pass the cap together
    // and overwrite each other's writes.
    const path = tempLedger();
    const spend = fileURLToPath(new URL('../evals/spend.ts', import.meta.url));
    const child = [
      `import { openLedger, SpendRefusal } from ${JSON.stringify(spend)};`,
      `const l = openLedger({ path: ${JSON.stringify(path)}, monthlyCapUsd: 1, clock: { now: () => new Date(${JSON.stringify(NOW.toISOString())}) } });`,
      'let n = 0;',
      'for (;;) { let r; try { r = l.reserve(0.05); } catch (e) { if (e instanceof SpendRefusal) break; throw e; } n++; l.settle(r, 0.05); }',
      'process.stdout.write(String(n));',
    ].join('\n');
    const run = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        p.stdout.on('data', (d: Buffer) => (out += d.toString()));
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(Number(out)) : reject(new Error(`child exited ${code}`))));
      });
    const granted = (await Promise.all([run(), run(), run(), run(), run(), run()])).reduce((a, b) => a + b, 0);
    expect(granted).toBe(20);
    expect(openLedger({ path, monthlyCapUsd: 20, clock: fixed }).month()).toMatchObject({ spentUsd: 1, openUsd: 0, calls: 20 });
    expect(readdirSync(dirname(path))).toEqual(['eval-spend.json']);
  });

  it('takes over a lock left by a run that died holding it', () => {
    const path = tempLedger();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.lock`, '1\n');
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    utimesSync(`${path}.lock`, old, old);
    const ledger = openLedger({ path, monthlyCapUsd: 20, clock: fixed });
    ledger.settle(ledger.reserve(1), 1);
    expect(ledger.month()).toMatchObject({ spentUsd: 1, calls: 1 });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('fails closed on a file it cannot read, and never overwrites it', () => {
    const path = tempLedger();
    openLedger({ path, monthlyCapUsd: 20, clock: fixed }).reserve(0);
    writeFileSync(path, '{"format":"something else"}');
    expect(() => openLedger({ path, monthlyCapUsd: 20, clock: fixed }).month()).toThrow(/ledger/);
    expect(readFileSync(path, 'utf8')).toBe('{"format":"something else"}');
  });
});

describe('the worst case of one call', () => {
  it('prices every input token at the dearest input rate and the output at the dearest output rate of every model in force, since a server-side fallback can answer', () => {
    // Fable 5.1 has the highest rates of the registry: cache write 1 h at 20 and output at 50 per million.
    expect(worstCaseUsd('claude-sonnet-5-5', 1000, 100, PRICES)).toBe(0.025);
    expect(worstCaseUsd('claude-fable-5-2', 1_000_000, 0, PRICES)).toBe(20);
    expect(worstCaseUsd('claude-opus-5-5', 0, 1_000_000, PRICES)).toBe(50);
  });

  it('is null when the requested model has no price, whatever the others cost', () => {
    const prices = new Map([...PRICES].filter(([model]) => model !== 'claude-sonnet-5-5'));
    expect(worstCaseUsd('claude-sonnet-5-5', 1000, 100, prices)).toBeNull();
  });

  it('bounds the input by the request, its output schema and its attachment bound', () => {
    const plain = requestInputTokens(judgeRequest(), null);
    expect(plain).toBeGreaterThan(0);
    expect(requestInputTokens({ ...judgeRequest(), attachmentTokenBound: 500 }, null)).toBe(plain + 500);
    expect(requestInputTokens(judgeRequest(), z.object({ verdict: z.boolean(), note: z.string() }))).toBeGreaterThan(plain);
  });
});

/** A gateway that answers text calls with `answer`, and records the month's open reservations during the call. */
function fakeInner(answer: () => Promise<{ text: string; meta: { costUsd: number | null } }>, seen: (() => void) | null = null): Gateway<string> {
  return {
    structured: () => Promise.reject(new Error('not scripted')),
    structuredStream: () => ({ started: Promise.resolve(), final: Promise.reject(new Error('not scripted')) }),
    text: async () => {
      seen?.();
      return answer();
    },
  } as unknown as Gateway<string>;
}

describe('the budgeted gateway', () => {
  const worst = (maxTokens = 1000): number => worstCaseUsd('claude-sonnet-5-5', requestInputTokens(judgeRequest(maxTokens), null), maxTokens, PRICES)!;
  const over = (inner: Gateway<string>) => {
    const ledger = openLedger({ path: tempLedger(), monthlyCapUsd: 20, clock: fixed });
    return { ledger, budget: budgetedGateway(inner, { ledger, prices: () => PRICES, maxRunUsd: null }) };
  };

  it('reserves enough for a fallback to the dearest model: the reservation covers what the call then costs', async () => {
    let open = -1;
    const box: { ledger?: ReturnType<typeof openLedger> } = {};
    // The same tokens answered by Fable 5.1 after a fallback, at its prices.
    const fallbackCost = Math.round((requestInputTokens(judgeRequest(), null) * 10 + 1000 * 50)) / 1e6;
    const { ledger, budget } = over(fakeInner(async () => ({ text: 'yes', meta: { costUsd: fallbackCost } }), () => (open = box.ledger!.month().openUsd)));
    box.ledger = ledger;
    await budget.gateway.text(judgeRequest());
    expect(open).toBe(worst());
    expect(open).toBeGreaterThanOrEqual(fallbackCost);
    expect(ledger.month()).toMatchObject({ spentUsd: fallbackCost, openUsd: 0, calls: 1 });
  });

  it('bills a success the gateway could not price at its worst case, never at zero', async () => {
    const { ledger, budget } = over(fakeInner(async () => ({ text: 'yes', meta: { costUsd: null } })));
    await budget.gateway.text(judgeRequest());
    expect(ledger.month()).toMatchObject({ spentUsd: worst(), calls: 1 });
  });

  it('bills a call cut after it reached the API at its worst case, and one that never left at zero', async () => {
    const failure = { code: 'timeout' as const, status: null, apiType: null, retryAfterSec: null, requestId: null };
    const reached = over(fakeInner(() => Promise.reject(new ApiError(failure, 'usage-row-1'))));
    await expect(reached.budget.gateway.text(judgeRequest())).rejects.toBeInstanceOf(ApiError);
    expect(reached.ledger.month()).toMatchObject({ spentUsd: worst(), openUsd: 0, calls: 1 });
    const never = over(fakeInner(() => Promise.reject(new ApiError(failure, null))));
    await expect(never.budget.gateway.text(judgeRequest())).rejects.toBeInstanceOf(ApiError);
    expect(never.ledger.month()).toMatchObject({ spentUsd: 0, calls: 1 });
  });

  it('bills a billed response that failed (a refusal) at its measured cost, or at its worst case when unpriced', async () => {
    const response = { usageId: 'usage-row-2', requestId: null, modelResponded: 'claude-sonnet-5-5', stopReason: 'refusal' };
    const priced = over(fakeInner(() => Promise.reject(new ResponseError('refusal', 'refused', { ...response, costUsd: 0.0042 }))));
    await expect(priced.budget.gateway.text(judgeRequest())).rejects.toBeInstanceOf(ResponseError);
    expect(priced.ledger.month()).toMatchObject({ spentUsd: 0.0042, calls: 1 });
    const unpriced = over(fakeInner(() => Promise.reject(new ResponseError('refusal', 'refused', { ...response, costUsd: null }))));
    await expect(unpriced.budget.gateway.text(judgeRequest())).rejects.toBeInstanceOf(ResponseError);
    expect(unpriced.ledger.month()).toMatchObject({ spentUsd: worst(), calls: 1 });
  });

  it('bills a failure it cannot place at its worst case, and a cap the gateway hit before sending at zero', async () => {
    const unknown = over(fakeInner(() => Promise.reject(new Error('socket hang up'))));
    await expect(unknown.budget.gateway.text(judgeRequest())).rejects.toThrow(/socket hang up/);
    expect(unknown.ledger.month()).toMatchObject({ spentUsd: worst(), openUsd: 0, calls: 1 });
    expect(unknown.budget.run()).toMatchObject({ spentUsd: worst(), openUsd: 0, calls: 1 });
    const capped = over(fakeInner(() => Promise.reject(new CapError('cap_monthly_global', 1, 1))));
    await expect(capped.budget.gateway.text(judgeRequest())).rejects.toBeInstanceOf(CapError);
    expect(capped.ledger.month()).toMatchObject({ spentUsd: 0, openUsd: 0, calls: 1 });
  });

  /** A gateway whose structured calls (plain and streamed) answer with `answer`, recording the month's open reservation during the call. */
  const structuredInner = (answer: () => Promise<{ meta: { costUsd: number | null } }>, seen: () => void = () => undefined): Gateway<string> =>
    ({
      structured: async () => {
        seen();
        return answer();
      },
      structuredStream: () => {
        seen();
        const final = answer();
        final.catch(() => undefined);
        return { started: Promise.resolve(), final };
      },
      text: () => Promise.reject(new Error('not scripted')),
    }) as unknown as Gateway<string>;
  const Verdict = z.object({ verdict: z.boolean(), note: z.string() });

  it('reserves a structured call with its output schema and attachment bound in the input', async () => {
    const request = { ...judgeRequest(), attachmentTokenBound: 5000 };
    const expected = worstCaseUsd('claude-sonnet-5-5', requestInputTokens(request, Verdict), 1000, PRICES)!;
    expect(expected).toBeGreaterThan(worstCaseUsd('claude-sonnet-5-5', requestInputTokens(judgeRequest(), null), 1000, PRICES)!);
    for (const streamed of [false, true]) {
      let open = -1;
      const box: { ledger?: ReturnType<typeof openLedger> } = {};
      const { ledger, budget } = over(structuredInner(async () => ({ meta: { costUsd: 0.001 } }), () => (open = box.ledger!.month().openUsd)));
      box.ledger = ledger;
      await (streamed ? budget.gateway.structuredStream(Verdict, request).final : budget.gateway.structured(Verdict, request));
      expect(open, streamed ? 'streamed' : 'plain').toBe(expected);
      expect(ledger.month()).toMatchObject({ spentUsd: 0.001, openUsd: 0, calls: 1 });
    }
  });

  it('bills a streamed call like a plain one: unpriced success and a failure after the API at the worst case, a failure before it at zero', async () => {
    const w = worstCaseUsd('claude-sonnet-5-5', requestInputTokens(judgeRequest(), Verdict), 1000, PRICES)!;
    const failure = { code: 'timeout' as const, status: null, apiType: null, retryAfterSec: null, requestId: null };
    const unpriced = over(structuredInner(async () => ({ meta: { costUsd: null } })));
    await unpriced.budget.gateway.structuredStream(Verdict, judgeRequest()).final;
    expect(unpriced.ledger.month()).toMatchObject({ spentUsd: w, openUsd: 0, calls: 1 });
    const reached = over(structuredInner(() => Promise.reject(new ApiError(failure, 'usage-row-3'))));
    await expect(reached.budget.gateway.structuredStream(Verdict, judgeRequest()).final).rejects.toBeInstanceOf(ApiError);
    expect(reached.ledger.month()).toMatchObject({ spentUsd: w, openUsd: 0, calls: 1 });
    const never = over(structuredInner(() => Promise.reject(new ApiError(failure, null))));
    await expect(never.budget.gateway.structuredStream(Verdict, judgeRequest()).final).rejects.toBeInstanceOf(ApiError);
    expect(never.ledger.month()).toMatchObject({ spentUsd: 0, openUsd: 0, calls: 1 });
  });


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
    // Worst case of a 1000-token judge reply alone is US$0.05 at the registry's dearest output price.
    const { scripted, budget, ledger } = setup({ 'rewrite.judge': [REPLY] }, { path });
    const refused = budget.gateway.text(judgeRequest());
    await expect(refused).rejects.toThrow(SpendRefusal);
    await expect(refused).rejects.toBeInstanceOf(CapError);
    expect(scripted.calls).toHaveLength(0);
    expect(ledger.month()).toMatchObject({ spentUsd: 19.995, openUsd: 0 });
  });

  it('refuses a call over the per-run cap, apart from the month', async () => {
    // Room for one worst case, and not for a second one after the first settles at US$0.003.
    const { scripted, budget } = setup({ 'rewrite.judge': [REPLY, REPLY] }, { maxRunUsd: worst() + 0.002 });
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

  it('refuses a call, as a CapError that stops the run, when the ledger cannot be read', async () => {
    const { scripted, budget, path } = setup({ 'rewrite.judge': [REPLY] });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');
    const refused = budget.gateway.text(judgeRequest());
    await expect(refused).rejects.toBeInstanceOf(CapError);
    await expect(refused).rejects.toThrow(/ledger .* is not readable/);
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


const ROOT = new URL('../../', import.meta.url);
const json = (file: string): unknown[] => JSON.parse(readFileSync(new URL(file, ROOT), 'utf8')) as unknown[];
const REFS: PromptRefs = {
  sources: json('style-refs/sources.json').map((s) => Source.parse(s)),
  principles: LANGS.flatMap((lang) => json(`style-refs/principles/${lang}.json`).map((p) => Principle.parse(p))),
  examples: LANGS.flatMap((lang) => json(`style-refs/examples/${lang}.json`).map((e) => Example.parse(e))),
};
const CV_ES = readFileSync(new URL('prose-rewriter/evals/cases/cv/es-rioplatense.md', ROOT), 'utf8');
const loaded = (id: string, text: string, genre: 'email' | 'whatsapp'): LoadedCase => ({
  id,
  kind: 'good',
  // A WhatsApp case names minimo, its default before 21/11/2026, so a clean one still exits early.
  input: RewriteInput.parse({ text, genre, lang: 'es', variety: 'rioplatense', ...(genre === 'whatsapp' ? { mode: 'minimo' } : {}), profile: { cvMarkdown: CV_ES } }),
  expect: { survive: [], acceptedDrops: [], placeholdersAllowed: false },
});
/** Fictional. Clean: S1b returns it unchanged, with no model call. */
const CLEAN = loaded('es-whatsapp-clean', 'Hola Marta, te paso el link del sitio nuevo de la panadería. Lo armé en Astro y carga en 1,6 s. Avisame si querés que lo veamos el jueves.', 'whatsapp');
/** Fictional, with slop: the pipeline would call the model. */
const SLOP = loaded('es-email-slop', 'Hola Marta,\nEspero que estés bien. Quería comentarte que me apasiona potenciar sinergias. El sitio de la panadería ya carga en 1,6 s. ¿Lo vemos el jueves?\nSaludos,\nValeria', 'email');
const SECRET = 'sk-test-not-a-real-key';

interface Harness {
  readonly deps: EvalCliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly built: number[];
  readonly ledgerPath: string;
  readonly dir: string;
}

function harness(gateway: () => Gateway<string>, over: Partial<EvalCliDeps> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const built: number[] = [];
  const deps: EvalCliDeps = {
    apiKey: SECRET,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    clock: fixed,
    home: dir,
    cases: () => [CLEAN, SLOP],
    refs: () => REFS,
    gateway: (_key, cap) => {
      built.push(cap);
      return gateway();
    },
    ...over,
  };
  return { deps, out, err, built, ledgerPath: join(dir, '.applied-ai-toolkit', 'eval-spend.json'), dir };
}
const never = (): Gateway<string> => {
  throw new Error('the live gateway must not be built');
};

describe('the dry run estimate', () => {
  const variant = (id: string) => VARIANTS.filter((v) => v.id === id);
  const bytes = (s: string): number => new TextEncoder().encode(s).length;
  const judgeModel = TASK_CONFIGS['rewrite.judge'].model;

  it('adds up every judging call of a piece that exits early, each input growing by the outputs before it', async () => {
    const est = await estimateRun([CLEAN], variant('full'), REFS, PRICES);
    // No baseline among the variants: no pairwise-baseline call.
    const rubrics = JUDGE_RUBRICS.filter((r) => r.name !== 'pairwise-baseline');
    const base = estimateInputTokens({ messages: [{ role: 'user', content: JSON.stringify(CLEAN.input) }] });
    // fact-check also reads the original a second time (next to the rewrite), on top of the fact sheet.
    const extra = (r: (typeof rubrics)[number]): number => bytes(r.instructions) + (r.name === 'fact-check' ? bytes(CLEAN.input.text) : 0);
    expect(rubrics.map((r) => r.name)).toContain('fact-check');
    const expected = rubrics.reduce((sum, r, i) => sum + worstCaseUsd(judgeModel, base + i * JUDGE_MAX_TOKENS + extra(r), JUDGE_MAX_TOKENS, PRICES)!, 0);
    expect(est).toEqual({ pieces: 1, calls: rubrics.length, worstUsd: Math.round(expected * 1e6) / 1e6 });
    expect(est.worstUsd).toBeGreaterThan(0);
  });

  it('counts pairwise-baseline once per pipeline variant and never for the baseline itself', async () => {
    const est = await estimateRun([CLEAN], VARIANTS.filter((v) => v.id === 'full' || v.id === 'single-call'), REFS, PRICES);
    expect(est.calls).toBe(JUDGE_RUBRICS.length + (JUDGE_RUBRICS.length - 1));
  });

  it('counts every call a piece may make: each stage and its retry, the extra round, and both fact verdicts with their retries', async () => {
    const est = await estimateRun([SLOP], variant('full'), REFS, PRICES);
    // S2, S3 and S4 twice each (a reply that cannot be read is asked for once more), the extra
    // round once, the fact judge's two verdicts twice each (judgeStage retries an unreadable one),
    // then the judging rubrics.
    expect(est.calls).toBe(2 + 2 + 2 + 1 + 4 + JUDGE_RUBRICS.length - 1);
    const judge = rewriteRubric.call.max_tokens;
    const stages = [
      ...[STAGE_MAX_TOKENS['rewrite.plan'], STAGE_MAX_TOKENS['rewrite.edit'], STAGE_MAX_TOKENS['rewrite.style']].flatMap((t) => [t, t]),
      STAGE_MAX_TOKENS['rewrite.edit'],
      judge,
      judge,
      judge,
      judge,
    ];
    // Every output budget is billed at least once at the dearest output rate in force.
    const outputs = (stages.reduce((a, b) => a + b, 0) + (JUDGE_RUBRICS.length - 1) * JUDGE_MAX_TOKENS) * 50 / 1e6;
    expect(est.worstUsd).toBeGreaterThan(outputs);
  });

  it('counts the call and its retry and both fact verdicts with their retries for single-guarded, and one call for single-call', async () => {
    const guarded = await estimateRun([SLOP], variant('single-guarded'), REFS, PRICES);
    // The single call twice, the fact judge's two verdicts twice each, then the judging rubrics
    // (no baseline: no pairwise-baseline).
    expect(guarded.calls).toBe(2 + 4 + JUDGE_RUBRICS.length - 1);
    const bare = await estimateRun([SLOP], variant('single-call'), REFS, PRICES);
    expect(bare.calls).toBe(1 + JUDGE_RUBRICS.length - 1);
    const full = await estimateRun([SLOP], variant('full'), REFS, PRICES);
    expect(bare.worstUsd).toBeLessThan(guarded.worstUsd);
    expect(guarded.worstUsd).toBeLessThan(full.worstUsd);
  });

  it('warns when the worst case is more than the month has left or more than --max-usd', async () => {
    const h = harness(never);
    const seed = openLedger({ path: h.ledgerPath, monthlyCapUsd: 20, clock: fixed });
    seed.settle(seed.reserve(19.99), 19.99);
    expect(await runEvalCli(['--dry-run', '--variants', 'full', '--max-usd', '0.001'], h.deps)).toBe(EVAL_EXIT.ok);
    expect(h.out.join('')).toMatch(/more than what is left this month/);
    expect(h.out.join('')).toMatch(/more than --max-usd 0\.001/);
    const roomy = harness(never);
    await runEvalCli(['--dry-run', '--variants', 'full', '--cases', 'es-whatsapp-clean'], roomy.deps);
    expect(roomy.out.join('')).not.toMatch(/more than/);
  });
});

describe('the gate report (design 5, "Puerta")', () => {
  const variants = (...ids: string[]) => VARIANTS.filter((v) => ids.includes(v.id));
  const zero = { calls: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
  /** `n` scored judge records of a rubric and variant, the first `passes` of them passing, then `none` with nothing to judge. */
  const judged = (rubric: string, variant: string, n: number, passes: number, none = 0): JudgeRecord[] => [
    ...Array.from({ length: n }, (_, i): JudgeRecord => ({ rubric, version: '1', case: `c${i}`, variant, status: 'scored', pass: i < passes, usage: zero })),
    ...Array.from({ length: none }, (_, i): JudgeRecord => ({ rubric, version: '1', case: `c${n + i}`, variant, status: 'no-output', pass: null, usage: zero })),
  ];
  /** The baseline's side of pairwise-baseline: the pipeline's losses, as judgeRuns derives it. */
  const versus = (variant: string, n: number, wins: number, none = 0) => judged('pairwise-baseline', variant, n, wins, none);
  const sameVoice = (n: number, none = 0) => [...judged('same-voice', 'single-call', n, n, none), ...judged('same-voice', 'full', n, n, none)];
  const hard = (variant: string): CodeRecord => ({ case: 'c0', variant, rubric: 'no-new-facts', version: '1', hard: true, status: 'scored', pass: false, metrics: {}, detail: 'extra: 40%' });

  it('gates the cases that have something to judge: a rewrite equal to its reference is left out, not a refusal', () => {
    const r = gateReport([...versus('full', 60, 50, 2), ...sameVoice(60, 2)], [], variants('full', 'single-call'));
    expect(r.markdown).not.toMatch(/Not gated/);
    expect(r.markdown).toMatch(/same-voice: full against single-call[\s\S]*### Eval gate: pass/);
    expect(r.state).toBe('pass');
  });

  it('passes pairwise-baseline only when the pipeline beats the baseline, not when it loses by a little', () => {
    expect(gateReport([...versus('full', 800, 392), ...sameVoice(60)], [], variants('full', 'single-call')).state).not.toBe('pass');
    expect(gateReport([...versus('full', 800, 400), ...sameVoice(60)], [], variants('full', 'single-call')).state).not.toBe('pass');
    expect(gateReport([...versus('full', 800, 300), ...sameVoice(60)], [], variants('full', 'single-call')).state).toBe('fail');
    const won = gateReport([...versus('full', 800, 480), ...sameVoice(60)], [], variants('full', 'single-call'));
    expect(won.state).toBe('pass');
    expect(won.markdown).toMatch(/full wins 480 of 800/);
  });

  it('blocks a variant with a hard failure, whatever its rates', () => {
    const r = gateReport([...versus('full', 800, 480), ...sameVoice(60)], [hard('full'), hard('single-call')], variants('full', 'single-call'));
    expect(r.state).toBe('blocked');
    expect(r.markdown).toMatch(/full against single-call: blocked by 1 hard failure/);
  });

  it('gates each ablation against the full pipeline, so a stage shows whether it contributes', () => {
    const judges = [...judged('pairwise-original', 'full', 60, 55), ...judged('pairwise-original', 'no-style', 60, 20), ...versus('full', 60, 50), ...versus('no-style', 60, 50), ...sameVoice(60), ...judged('same-voice', 'no-style', 60, 60)];
    const r = gateReport(judges, [], variants('full', 'no-style', 'single-call'));
    expect(r.markdown).toMatch(/### Ablation: no-style against full/);
    expect(r.markdown).toMatch(/the stage no-style leaves out contributes/);
    // The exit follows the shipped pipeline, full; the ablations inform the decision.
    expect(r.state).toBe('pass');
  });

  it('warns when the case set is too small for same-voice to pass at the margin, even at 100% on both sides', () => {
    const r = gateReport([...versus('full', 33, 30), ...sameVoice(33)], [], variants('full', 'single-call'));
    expect(r.markdown).toMatch(/cannot pass with 33 scored cases/);
    // The report names the smallest margin that could pass with these cases.
    expect(r.markdown).toMatch(/smallest margin that could pass is 0\.105/);
    expect(r.state).toBe('inconclusive');
  });

  it('passes same-voice on 33 cases at a margin given to gate(), and applies it to the ablations too', () => {
    const judges = [...versus('full', 33, 30), ...sameVoice(33), ...judged('pairwise-original', 'full', 33, 33), ...judged('pairwise-original', 'no-style', 33, 33), ...versus('no-style', 33, 30), ...judged('same-voice', 'no-style', 33, 33)];
    const r = gateReport(judges, [], variants('full', 'no-style', 'single-call'), { margin: 0.11 });
    expect(r.state).toBe('pass');
    expect(r.markdown).not.toMatch(/cannot pass/);
    expect(r.markdown).toMatch(/Ablation: no-style against full\n\nNo evidence that the stage no-style leaves out contributes \(pass\)/);
    expect(r.markdown).toMatch(/Margin: 11\.0 points/);
  });

  it('is inconclusive with no baseline among the variants', () => {
    expect(gateReport([], [], variants('full')).state).toBe('inconclusive');
  });

  it('is inconclusive, not passing, when one side has no same-voice records', () => {
    const r = gateReport([...versus('full', 800, 480), ...judged('same-voice', 'single-call', 60, 60)], [], variants('full', 'single-call'));
    expect(r.markdown).toMatch(/same-voice: full against single-call\n\nNot gated: no judged pieces on one side/);
    expect(r.state).toBe('inconclusive');
  });

  it('is inconclusive, not failing, when no pairwise-baseline comparison was scored', () => {
    // Every comparison had nothing to judge, or every judge call failed: no evidence either way.
    const failed: JudgeRecord[] = judged('pairwise-baseline', 'full', 0, 0, 4).map((r, i) => (i < 2 ? r : { ...r, status: 'failed' }));
    const r = gateReport([...failed, ...sameVoice(60)], [], variants('full', 'single-call'));
    expect(r.markdown).toMatch(/pairwise-baseline: full against single-call\n\nNot gated: no comparison with something to judge/);
    expect(r.state).toBe('inconclusive');
  });

  it('is inconclusive on pairwise-baseline when the interval includes one half, and fail only when it lies below', () => {
    // 392 and 400 of 800: the interval includes one half, so neither beats nor loses (exit 5, not 2).
    expect(gateReport([...versus('full', 800, 392), ...sameVoice(60)], [], variants('full', 'single-call')).state).toBe('inconclusive');
    expect(gateReport([...versus('full', 800, 400), ...sameVoice(60)], [], variants('full', 'single-call')).state).toBe('inconclusive');
    expect(gateReport([...versus('full', 800, 360), ...sameVoice(60)], [], variants('full', 'single-call')).state).toBe('fail');
  });

  it('takes the worse of the two sub-gates: a fail beats an inconclusive', () => {
    // pairwise-baseline fails; same-voice on 33 cases is inconclusive at the default margin.
    const r = gateReport([...versus('full', 800, 300), ...sameVoice(33)], [], variants('full', 'single-call'));
    expect(r.markdown).toMatch(/pairwise-baseline: full against single-call\n\n### Eval gate: fail/);
    expect(r.markdown).toMatch(/same-voice: full against single-call\n\n### Eval gate: inconclusive/);
    expect(r.state).toBe('fail');
  });

  it('without full among the variants, takes the worst of the variants', () => {
    const judges = [...versus('no-style', 800, 480), ...judged('same-voice', 'single-call', 60, 60), ...judged('same-voice', 'no-style', 60, 60)];
    expect(gateReport(judges, [], variants('no-style', 'single-call')).state).toBe('pass');
    expect(gateReport(judges, [hard('no-style')], variants('no-style', 'single-call')).state).toBe('blocked');
    const close = [...versus('no-style', 800, 400), ...judged('same-voice', 'single-call', 60, 60), ...judged('same-voice', 'no-style', 60, 60)];
    expect(gateReport(close, [], variants('no-style', 'single-call')).state).toBe('inconclusive');
  });

  it('with full among the variants, follows full even when an ablation is blocked', () => {
    const judges = [...versus('full', 800, 480), ...versus('no-style', 800, 480), ...sameVoice(60), ...judged('same-voice', 'no-style', 60, 60)];
    const r = gateReport(judges, [hard('no-style')], variants('full', 'no-style', 'single-call'));
    expect(r.markdown).toMatch(/no-style against single-call: blocked by 1 hard failure/);
    expect(r.state).toBe('pass');
  });

  it('reads an inconclusive ablation as no evidence, not as a stage that contributes', () => {
    const judges = [...versus('full', 60, 50), ...sameVoice(60), ...judged('pairwise-original', 'full', 33, 33), ...judged('pairwise-original', 'no-style', 33, 33), ...versus('no-style', 60, 50), ...judged('same-voice', 'no-style', 60, 60)];
    const r = gateReport(judges, [], variants('full', 'no-style', 'single-call'));
    expect(r.markdown).toMatch(/Ablation: no-style against full\n\nNo evidence that the stage no-style leaves out contributes \(inconclusive\)/);
    expect(r.markdown).not.toMatch(/the stage no-style leaves out contributes\./);
  });

  it('names the smaller scored count in the small-set warning when the sides differ', () => {
    // Baseline 40 scored; full 33 scored and 7 with nothing to judge, over the same 40 cases.
    const judges = [...versus('full', 60, 50), ...judged('same-voice', 'single-call', 40, 40), ...judged('same-voice', 'full', 33, 33, 7)];
    const r = gateReport(judges, [], variants('full', 'single-call'));
    expect(r.markdown).toMatch(/cannot pass with 33 scored cases/);
  });
});

describe('the eval CLI', () => {
  it('refuses to run without --live or --dry-run, building no gateway', async () => {
    const h = harness(never);
    expect(await runEvalCli([], h.deps)).toBe(EVAL_EXIT.usage);
    expect(h.err.join('')).toMatch(/--live/);
    expect(h.built).toEqual([]);
  });

  it('--dry-run prints the worst case of the whole run, makes zero calls and needs no key', async () => {
    const h = harness(never, { apiKey: undefined });
    expect(await runEvalCli(['--dry-run', '--variants', 'full,single-call'], h.deps)).toBe(EVAL_EXIT.ok);
    const text = h.out.join('');
    expect(text).toMatch(/Dry run: 4 pieces \(2 cases x 2 variants\), no model call made/);
    expect(text).toMatch(/Worst case of the whole run: US\$\d+\.\d{4} over at most \d+ calls/);
    expect(text).toMatch(/Spend this month \(2026-11\): US\$0\.0000 of US\$20 \(the default monthly budget\)/);
    expect(h.built).toEqual([]);
    expect(existsSync(h.ledgerPath)).toBe(false);
  });

  it('filters cases by genre, language and id, and applies --limit', async () => {
    const h = harness(never);
    await runEvalCli(['--dry-run', '--variants', 'full', '--cases', 'whatsapp,es'], h.deps);
    expect(h.out.join('')).toMatch(/1 pieces \(1 cases x 1 variants\)/);
    const h2 = harness(never);
    await runEvalCli(['--dry-run', '--variants', 'full', '--limit', '1'], h2.deps);
    expect(h2.out.join('')).toMatch(/1 pieces/);
    const h3 = harness(never);
    expect(await runEvalCli(['--dry-run', '--cases', 'no-such-case'], h3.deps)).toBe(EVAL_EXIT.usage);
    expect(h3.err.join('')).toMatch(/no-such-case/);
  });

  it('raises the monthly cap only with --monthly-cap, and says in the report who set it', async () => {
    const h = harness(never, { apiKey: undefined });
    expect(await runEvalCli(['--dry-run', '--variants', 'full', '--monthly-cap', '50'], h.deps)).toBe(EVAL_EXIT.ok);
    expect(h.out.join('')).toMatch(/of US\$50 \(set by --monthly-cap; the default is US\$20\)/);
    const seed = openLedger({ path: h.ledgerPath, monthlyCapUsd: 50, clock: fixed, raised: true });
    seed.settle(seed.reserve(30), 30);
    // At the default, a month that spent 30 has nothing left: the first call is refused.
    const scripted = scriptedGateway({});
    const h2 = harness(() => scripted.gateway as Gateway<string>, { cases: () => [CLEAN], home: h.deps.home });
    expect(await runEvalCli(['--live', '--variants', 'full', '--out', join(h2.dir, 'run')], h2.deps)).toBe(EVAL_EXIT.stopped);
    expect(scripted.calls).toHaveLength(0);
    expect(h2.built).toEqual([20]);
    expect(h2.out.join('')).toMatch(/US\$30\.0000 of US\$20 \(the default monthly budget\)/);
  });

  it('refuses bad numbers', async () => {
    for (const argv of [['--monthly-cap', '0'], ['--max-usd', '-1'], ['--limit', '0'], ['--variants', 'nope']]) {
      const h = harness(never);
      expect(await runEvalCli(['--dry-run', ...argv], h.deps)).toBe(EVAL_EXIT.usage);
    }
  });

  it('keeps the ledger at one path: no flag points a run at another file with a fresh budget', async () => {
    const h = harness(never);
    const seed = openLedger({ path: h.ledgerPath, monthlyCapUsd: 20, clock: fixed });
    seed.settle(seed.reserve(20), 20);
    expect(await runEvalCli(['--dry-run', '--ledger', join(h.dir, 'other.json')], h.deps)).toBe(EVAL_EXIT.usage);
    expect(h.err.join('')).toMatch(/unknown option --ledger/);
    expect(await runEvalCli(['--dry-run', '--variants', 'full'], h.deps)).toBe(EVAL_EXIT.ok);
    expect(h.out.join('')).toMatch(/US\$20\.0000 of US\$20 .* US\$0\.0000 left/);
  });

  it('asks for an unreadable ledger to be repaired, not moved: a moved ledger starts the month at zero', async () => {
    const h = harness(never);
    mkdirSync(dirname(h.ledgerPath), { recursive: true });
    writeFileSync(h.ledgerPath, '{bad');
    expect(await runEvalCli(['--dry-run'], h.deps)).toBe(EVAL_EXIT.failed);
    expect(h.err.join('')).toMatch(/repair it by hand/);
    expect(h.err.join('')).not.toMatch(/move it/);
  });

  it('refuses flags that clash, repeat, take a value they should not, or swallow the next flag as their value', () => {
    expect(parseEvalArgs(['--dry-run', '--live', '--out', 'x'])).toMatch(/exclude each other/);
    expect(parseEvalArgs(['--dry-run', '--limit', '1', '--limit', '2'])).toMatch(/--limit is given twice/);
    expect(parseEvalArgs(['--dry-run=yes'])).toMatch(/--dry-run takes no value/);
    expect(parseEvalArgs(['--live', '--max-usd', '1', '--out', '--dry-run'])).toMatch(/--out needs a value/);
    expect(parseEvalArgs(['--dry-run', '--variants', '--live'])).toMatch(/--variants needs a value/);
    expect(parseEvalArgs(['--dry-run'])).toMatchObject({ monthlyCap: 20, monthlyCapSetBy: 'default' });
    expect(parseEvalArgs(['--dry-run', '--monthly-cap', '50'])).toMatchObject({ monthlyCap: 50, monthlyCapSetBy: 'flag' });
    expect(parseEvalArgs(['--dry-run', '--monthly-cap', '5'])).toMatchObject({ monthlyCap: 5, monthlyCapSetBy: 'flag' });
    expect(parseEvalArgs(['--dry-run', '--margin', '1'])).toMatch(/--margin needs a fraction from 0 to below 1/);
    expect(parseEvalArgs(['--dry-run', '--margin', 'x'])).toMatch(/--margin needs a fraction/);
    expect(parseEvalArgs(['--dry-run', '--margin', '0.11'])).toMatchObject({ margin: 0.11 });
    expect(parseEvalArgs(['--dry-run'])).toMatchObject({ margin: DEFAULT_MARGIN });
  });

  it('refuses an empty list after --variants or --cases instead of running none or all', async () => {
    for (const argv of [['--variants', ','], ['--cases', ','], ['--variants', ' , ']]) {
      expect(parseEvalArgs(['--dry-run', ...argv])).toMatch(/needs at least one/);
      const h = harness(never);
      expect(await runEvalCli(['--dry-run', ...argv], h.deps)).toBe(EVAL_EXIT.usage);
    }
  });

  it('--live without a key refuses before building anything', async () => {
    const h = harness(never, { apiKey: undefined });
    expect(await runEvalCli(['--live', '--out', 'x'], h.deps)).toBe(EVAL_EXIT.failed);
    expect(h.err.join('')).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('--live runs, records, judges and reports the gate, the cost table and the month spend', async () => {
    const judge = (text: string) => ({ text, usage: { input: 1000, output: 100 } });
    const scripted = scriptedGateway({ 'rewrite.judge': [judge('{"fits": true, "note": ""}'), judge('{"contaminated": false, "note": ""}')] });
    const h = harness(() => scripted.gateway as Gateway<string>, { cases: () => [CLEAN] });
    const outDir = join(h.dir, 'run');
    // No baseline among the variants: the run finished, the gate could not run.
    expect(await runEvalCli(['--live', '--variants', 'full', '--out', outDir], h.deps)).toBe(EVAL_EXIT.inconclusive);
    scripted.assertDone();
    expect(h.built).toEqual([20]);
    expect(readdirSync(outDir).sort()).toEqual(['code.jsonl', 'judges.jsonl', 'pieces.jsonl', 'report.md']);
    const text = h.out.join('');
    expect(text).toContain('### Cost per rewrite');
    expect(text).toContain('| full | whatsapp | minimo | 1 | 1 | 0.0000 | 0.0000 |');
    expect(text).toMatch(/no baseline among the variants/);
    // The fact check is reported next to the code rubrics; the rewrite equal to the original was not paid for.
    expect(text).toContain('### Fact check (judge, soft)');
    expect(text).toContain('| full | 1 | 0 | 0 | n/a | 1 | 0 |');
    expect(text).toMatch(/Spend this month \(2026-11\): US\$0\.0060 of US\$20/);
    expect(text).toMatch(/This run: US\$0\.0060 over 2 calls/);
    expect(readFileSync(join(outDir, 'report.md'), 'utf8')).toContain('### Cost per rewrite');
    expect(openLedger({ path: h.ledgerPath, monthlyCapUsd: 20, clock: fixed }).month().spentUsd).toBe(0.006);
    expect(h.out.join('') + h.err.join('')).not.toContain(SECRET);
  });

  it('--live gates with the --margin it was given', async () => {
    const SINERGIAS = 'Quería comentarte que me apasiona potenciar sinergias.';
    const fixed = (after: string) => ({ data: { edits: [{ sentenceId: 2, before: SINERGIAS, after, reason: 'fix' }] } });
    const piped = SLOP.input.text.replace(SINERGIAS, 'Quería contarte que el sitio está listo.');
    const verdict = (v: object) => ({ text: JSON.stringify({ ...v, note: '' }) });
    const scripted = scriptedGateway({
      'rewrite.plan': [{ data: { items: [{ sentenceId: 2, action: 'remove-formula', reason: 'set phrase', ruleId: 'LEX-01' }] } }],
      // full's S3, then the single-call baseline's one call.
      'rewrite.edit': [fixed('Quería contarte que el sitio está listo.'), fixed('Quería avisarte que el sitio está listo.')],
      'rewrite.style': [{ data: { edits: [] } }],
      'rewrite.judge': [
        // full's fact judge, nothing invented.
        { text: JSON.stringify({ lines: judgeLines(piped, 'es').map((l) => ({ line: l.line, support: 'no-claim', note: '' })), note: '' }) },
        ...Array.from({ length: 3 }, () => verdict({ choice: 'A' })),
        ...Array.from({ length: 2 }, () => verdict({ same: true })),
        ...Array.from({ length: 2 }, () => verdict({ fits: true })),
        ...Array.from({ length: 2 }, () => verdict({ contaminated: false })),
      ],
    });
    const h = harness(() => scripted.gateway as Gateway<string>, { cases: () => [SLOP] });
    expect(await runEvalCli(['--live', '--variants', 'full,single-call', '--out', join(h.dir, 'run'), '--margin', '0.5'], h.deps)).not.toBe(EVAL_EXIT.usage);
    scripted.assertDone();
    expect(h.out.join('')).toMatch(/same-voice: full against single-call\n\n### Eval gate: \w+[\s\S]*?Margin: 50\.0 points/);
  });

  it('--live stops on the budget and says so, with what it recorded', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: '{"fits": true, "note": ""}' }] });
    const h = harness(() => scripted.gateway as Gateway<string>, { cases: () => [CLEAN] });
    const outDir = join(h.dir, 'run');
    expect(await runEvalCli(['--live', '--variants', 'full', '--out', outDir, '--max-usd', '0.000001'], h.deps)).toBe(EVAL_EXIT.stopped);
    expect(scripted.calls).toHaveLength(0);
    expect(h.out.join('')).toMatch(/Stopped: Refused: .*per-run cap/);
  });

  it('refuses an --out that already holds a run', async () => {
    const h = harness(() => scriptedGateway({}).gateway as Gateway<string>, { cases: () => [CLEAN] });
    const outDir = join(h.dir, 'run');
    await runEvalCli(['--live', '--variants', 'full', '--out', outDir, '--max-usd', '0.000001'], h.deps);
    expect(await runEvalCli(['--live', '--variants', 'full', '--out', outDir], h.deps)).toBe(EVAL_EXIT.usage);
    expect(h.err.join('')).toMatch(/already exists/);
  });
});
