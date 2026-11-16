// F6a step 3: the spend ledger, the budgeted gateway, the cost report and the eval CLI core,
// offline, over the scripted gateway. No key, no network; every ledger lives in a temp folder.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import type { LoadedCase } from '../evals/cases.ts';
import { EVAL_EXIT, runEvalCli, type EvalCliDeps } from '../evals/run.ts';
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
  input: RewriteInput.parse({ text, genre, lang: 'es', variety: 'rioplatense', profile: { cvMarkdown: CV_ES } }),
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
    expect(text).toMatch(/Spend this month \(2026-11\): US\$0\.0000 of US\$20/);
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

  it('refuses a monthly cap above the budget and bad numbers', async () => {
    for (const argv of [['--monthly-cap', '25'], ['--max-usd', '-1'], ['--limit', '0'], ['--variants', 'nope']]) {
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
    expect(await runEvalCli(['--live', '--variants', 'full', '--out', outDir], h.deps)).toBe(EVAL_EXIT.ok);
    scripted.assertDone();
    expect(h.built).toEqual([20]);
    expect(readdirSync(outDir).sort()).toEqual(['code.jsonl', 'judges.jsonl', 'pieces.jsonl', 'report.md']);
    const text = h.out.join('');
    expect(text).toContain('### Cost per rewrite');
    expect(text).toContain('| full | whatsapp | minimo | 1 | 1 | 0.0000 | 0.0000 |');
    expect(text).toMatch(/no baseline among the variants/);
    expect(text).toMatch(/Spend this month \(2026-11\): US\$0\.0060 of US\$20/);
    expect(text).toMatch(/This run: US\$0\.0060 over 2 calls/);
    expect(readFileSync(join(outDir, 'report.md'), 'utf8')).toContain('### Cost per rewrite');
    expect(openLedger({ path: h.ledgerPath, monthlyCapUsd: 20, clock: fixed }).month().spentUsd).toBe(0.006);
    expect(h.out.join('') + h.err.join('')).not.toContain(SECRET);
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
