/**
 * The testable core of prose-rewriter/evals/cli.ts: arguments, case and variant selection, the
 * dry run, and the live run with its records, gate and cost report. Everything with a side effect
 * outside the output folder and the ledger comes in through EvalCliDeps; only cli.ts reads
 * ANTHROPIC_API_KEY and builds the live gateway, and the tests pass the scripted one.
 *
 * - Without --live or --dry-run the CLI refuses: a run that silently did nothing would read as a
 *   run that passed.
 * - --dry-run builds no gateway and makes no call. It runs the pipelines over a probe that records
 *   each piece's first request and stops it, and adds up an estimate of the worst case: every
 *   model call the piece may make (design 4.10 step 1: S2, S3, S4, the extra round, the judge and
 *   its second verdict, then the judging rubrics; with strategy 'single', the one call in place of
 *   S2 to the extra round), with the retries rewrite() makes of a reply it cannot read (S2, S3, S4
 *   and the single call once more each, each verdict once more), each at the dearest input rate
 *   and its whole output budget. A later call's input is bounded by the first one's plus every output before it.
 *   That bound is an estimate, not a guarantee: the guarantee is the per-call reservation of the
 *   live run (spend.ts).
 * - --live spends from the monthly budget through the budgeted gateway, writes pieces, judge
 *   verdicts and code scores as JSONL row by row (evals' appendJsonl, so a run cut short keeps
 *   what it paid for), and prints the gate, the cost table and the month's spend.
 *
 * Exit codes (PROVISIONAL, like the rewriter CLI's): 0 the gate passed, 1 a cap or the budget
 * stopped the run, 2 the gate failed or a hard rubric blocked it, 3 bad usage, 4 could not run (no
 * key, or a ledger it cannot read), 5 the gate is inconclusive or could not run (no baseline,
 * too few cases). The gate is the full pipeline's when it ran (gateReport); a --dry-run exits 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { appendJsonl, decide, DEFAULT_MARGIN, differenceInterval, freshOutput, gate, gateMarkdown, GateRefusal, RUN_FORMAT, summarize, wilson, type StoredRun } from '../../evals/src/index.ts';
import { BUILT_IN_MODELS, CapError, estimateInputTokens, pricesInForce, type Gateway, type GatewayRequest, type Price } from '../../gateway/src/index.ts';
import type { PromptRefs } from '../src/prompt.ts';
import { judgeRuns as factJudgeRuns, rewriteRubric } from '../src/rubric.ts';
import { MAX_VERDICTS, VERDICT_ATTEMPTS } from '../src/stages/check.ts';
import { STAGE_ATTEMPTS, STAGE_MAX_TOKENS } from '../src/stages/model.ts';
import { TASK_CONFIGS } from '../src/tasks.ts';
import { defaultMode, Genre, Lang } from '../src/types.ts';
import type { LoadedCase } from './cases.ts';
import { BASELINE, JUDGE_MAX_TOKENS, JUDGE_RUBRICS, judgePieces, judgeRuns, type JudgeRecord } from './judges.ts';
import { runPipelines, VARIANTS, type PieceRecord, type PipelineVariant } from './pipeline.ts';
import { codeRuns, hardFailures, scorePieces, type CodeRecord } from './rubrics.ts';
import {
  budgetedGateway,
  costReport,
  costRows,
  defaultLedgerPath,
  MONTHLY_BUDGET_USD,
  openLedger,
  requestInputTokens,
  worstCaseUsd,
  type Clock,
  type MonthSpend,
  type SpendLedger,
} from './spend.ts';

export const EVAL_EXIT = { ok: 0, stopped: 1, blocked: 2, usage: 3, failed: 4, inconclusive: 5 } as const;

export const EVAL_USAGE =
  'usage: node prose-rewriter/evals/cli.ts (--dry-run | --live --out <dir>) [--variants id,...] [--cases genre|lang|id,...] [--limit N] [--margin F] ' +
  `[--monthly-cap USD (default ${MONTHLY_BUDGET_USD})] [--max-usd USD]`;

export interface EvalArgs {
  readonly dryRun: boolean;
  readonly live: boolean;
  readonly variants: readonly string[] | null;
  readonly cases: readonly string[] | null;
  readonly limit: number | null;
  readonly monthlyCap: number;
  /** Who set the cap in force: the default (MONTHLY_BUDGET_USD) or --monthly-cap, which may raise it. */
  readonly monthlyCapSetBy: 'default' | 'flag';
  readonly maxUsd: number | null;
  /** The margin gate() takes for same-voice and the ablations (D13). Default DEFAULT_MARGIN. */
  readonly margin: number;
  readonly out: string | null;
}

// No flag names the ledger: a run pointed at another file would start the month at zero (D14).
const VALUE_FLAGS = ['variants', 'cases', 'limit', 'monthly-cap', 'max-usd', 'margin', 'out'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const BOOLEAN_FLAGS = ['dry-run', 'live', 'help'] as const;

const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s !== '');

function positive(name: string, v: string | undefined): number | null | string {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : `--${name} needs a positive number, got ${JSON.stringify(v)}`;
}

/** The arguments, 'help', or a message saying what is wrong. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs | 'help' | string {
  const values: Partial<Record<ValueFlag, string>> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) return `unexpected argument ${JSON.stringify(arg)}`;
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (eq !== -1) return `--${name} takes no value`;
      flags.add(name);
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) return `unknown option --${name}`;
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    // A value that starts with "--" is the next flag, not this one's value ("--out --dry-run").
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) return `--${name} needs a value`;
    if (values[name as ValueFlag] !== undefined) return `--${name} is given twice`;
    values[name as ValueFlag] = value;
  }
  if (flags.has('help')) return 'help';
  const dryRun = flags.has('dry-run');
  const live = flags.has('live');
  if (dryRun && live) return '--dry-run and --live exclude each other';
  if (!dryRun && !live) return 'refusing to run: add --dry-run for the worst-case estimate, or --live to call the model (it spends from the monthly budget)';
  if (live && values.out === undefined) return '--live needs --out <dir> for the records';
  const cap = positive('monthly-cap', values['monthly-cap']);
  const maxUsd = positive('max-usd', values['max-usd']);
  if (typeof cap === 'string') return cap;
  if (typeof maxUsd === 'string') return maxUsd;
  let margin = DEFAULT_MARGIN;
  if (values.margin !== undefined) {
    margin = Number(values.margin);
    if (!(Number.isFinite(margin) && margin >= 0 && margin < 1)) return `--margin needs a fraction from 0 to below 1, got ${JSON.stringify(values.margin)}`;
  }
  const variants = values.variants === undefined ? null : list(values.variants);
  const cases = values.cases === undefined ? null : list(values.cases);
  if (variants?.length === 0) return '--variants needs at least one variant id';
  if (cases?.length === 0) return '--cases needs at least one genre, language or case id';
  let limit: number | null = null;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isSafeInteger(limit) || limit < 1) return `--limit needs a whole number from 1 up, got ${JSON.stringify(values.limit)}`;
  }
  return {
    dryRun,
    live,
    variants,
    cases,
    limit,
    monthlyCap: cap ?? MONTHLY_BUDGET_USD,
    monthlyCapSetBy: cap === null ? 'default' : 'flag',
    maxUsd,
    margin,
    out: values.out ?? null,
  };
}

/**
 * The cases a filter picks: each token is a genre, a language or a case id. Tokens of one kind
 * widen (email,whatsapp), kinds narrow each other (email,es). An unknown token is an error.
 */
export function selectCases(all: readonly LoadedCase[], tokens: readonly string[] | null, limit: number | null): LoadedCase[] | string {
  let picked = [...all];
  if (tokens !== null) {
    const genres = tokens.filter((t) => (Genre.options as readonly string[]).includes(t));
    const langs = tokens.filter((t) => (Lang.options as readonly string[]).includes(t));
    const ids = tokens.filter((t) => !genres.includes(t) && !langs.includes(t));
    const unknown = ids.filter((id) => !all.some((c) => c.id === id));
    if (unknown.length > 0) return `--cases: no genre, language or case named ${unknown.join(', ')}`;
    picked = picked.filter(
      (c) => (genres.length === 0 || genres.includes(c.input.genre)) && (langs.length === 0 || langs.includes(c.input.lang)) && (ids.length === 0 || ids.includes(c.id)),
    );
  }
  if (limit !== null) picked = picked.slice(0, limit);
  return picked.length === 0 ? '--cases and --limit leave no case to run' : picked;
}

export function selectVariants(ids: readonly string[] | null): PipelineVariant[] | string {
  if (ids === null) return [...VARIANTS];
  const unknown = ids.filter((id) => !VARIANTS.some((v) => v.id === id));
  if (unknown.length > 0) return `--variants: no variant ${unknown.join(', ')}; the variants are ${VARIANTS.map((v) => v.id).join(', ')}`;
  return VARIANTS.filter((v) => ids.includes(v.id));
}

export const builtInPrices = (at: Date): ReadonlyMap<string, Price> => pricesInForce(BUILT_IN_MODELS.map(({ id, price }) => ({ model: id, ...price })), at);

/** Stops a piece at its first call in a dry run. Not a CapError, so the run goes on to the next piece. */
class DryRunProbe extends Error {}

export interface RunEstimate {
  readonly pieces: number;
  readonly calls: number;
  readonly worstUsd: number;
}

const utf8 = (s: string): number => new TextEncoder().encode(s).length;

/** The dry run's worst case: see the header. Throws if a model on the way has no price. */
export async function estimateRun(cases: readonly LoadedCase[], variants: readonly PipelineVariant[], refs: PromptRefs, prices: ReadonlyMap<string, Price>): Promise<RunEstimate> {
  let first: number | null = null;
  const probe = (request: GatewayRequest<string>, schema: z.ZodType | null): never => {
    first ??= requestInputTokens(request, schema);
    throw new DryRunProbe('dry run');
  };
  const gateway: Gateway<string> = {
    structured: async (schema, request) => probe(request, schema),
    structuredStream: (schema, request) => {
      const final = (async () => probe(request, schema))();
      final.catch(() => undefined);
      return { started: Promise.resolve(), final };
    },
    text: async (request) => probe(request, null),
  };
  const byCase = new Map(cases.map((c) => [c.id, c]));
  const hasBaseline = variants.some((v) => v.id === BASELINE);
  let calls = 0;
  let worst = 0;
  const price = (model: string, input: number, maxTokens: number): number => {
    const usd = worstCaseUsd(model, input, maxTokens, prices);
    if (usd === null) throw new Error(`no price for ${model}; the dry run cannot bound the run`);
    return usd;
  };
  const record = (piece: PieceRecord): void => {
    const c = byCase.get(piece.case)!;
    const v = variants.find((x) => x.id === piece.variant)!;
    const base = first ?? estimateInputTokens({ messages: [{ role: 'user', content: JSON.stringify(c.input) }] });
    const early = first === null;
    first = null;
    const model = (task: 'rewrite.plan' | 'rewrite.edit' | 'rewrite.style'): string => v.tasks?.[task]?.model ?? TASK_CONFIGS[task].model;
    const seq: Array<{ model: string; maxTokens: number; extra?: number }> = [];
    const times = (n: number, call: { model: string; maxTokens: number }): void => {
      for (let i = 0; i < n; i++) seq.push(call);
    };
    // rewrite() asks a stage once more when its reply cannot be read; the extra round is not retried.
    const stage = (task: 'rewrite.plan' | 'rewrite.edit' | 'rewrite.style', attempts = STAGE_ATTEMPTS): void => times(attempts, { model: model(task), maxTokens: STAGE_MAX_TOKENS[task] });
    // The fact judge's two verdicts, each asked for once more when it cannot be read.
    const factJudge = (): void => {
      if (factJudgeRuns(c.input)) times(MAX_VERDICTS * VERDICT_ATTEMPTS, { model: TASK_CONFIGS['rewrite.judge'].model, maxTokens: rewriteRubric.call.max_tokens });
    };
    // The single-call baseline is not rewrite(): one call, no retry.
    if (!early && v.kind === 'single-call') stage('rewrite.edit', 1);
    if (!early && v.kind === 'pipeline' && v.strategy === 'single') {
      // One call that plans and edits, then the fact judge: no S4, no extra round.
      stage('rewrite.edit');
      factJudge();
    } else if (!early && v.kind === 'pipeline') {
      stage('rewrite.plan');
      stage('rewrite.edit');
      if (v.skipStyle !== true && (c.input.mode ?? defaultMode(c.input.genre)) !== 'minimo') stage('rewrite.style');
      stage('rewrite.edit', 1);
      factJudge();
    }
    for (const rubric of JUDGE_RUBRICS) {
      if (rubric.name === 'pairwise-baseline' && (v.id === BASELINE || !hasBaseline)) continue;
      seq.push({ model: TASK_CONFIGS['rewrite.judge'].model, maxTokens: JUDGE_MAX_TOKENS, extra: utf8(rubric.instructions) });
    }
    let carried = 0;
    for (const call of seq) {
      worst += price(call.model, base + carried + (call.extra ?? 0), call.maxTokens);
      carried += call.maxTokens;
    }
    calls += seq.length;
  };
  const pieces = await runPipelines(cases, variants, { gateway, refs, record });
  return { pieces: pieces.length, calls, worstUsd: Math.round(worst * 1e6) / 1e6 };
}

export interface EvalCliDeps {
  /** ANTHROPIC_API_KEY, read by cli.ts only. Never printed. */
  readonly apiKey: string | undefined;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly clock: Clock;
  /** The folder the ledger is under (the user's home); the tests pass a temp folder. */
  readonly home: string;
  readonly cases: () => readonly LoadedCase[];
  readonly refs: () => PromptRefs;
  /** Builds the live gateway, with the run's monthly cap as its own monthly cap. Called only with --live and a key. */
  readonly gateway: (apiKey: string, monthlyCapUsd: number) => Gateway<string>;
  /** The prices in force at a date. Default: the gateway's built-in prices. */
  readonly prices?: (at: Date) => ReadonlyMap<string, Price>;
}

const usd4 = (x: number): string => x.toFixed(4);
const capBy = (setBy: EvalArgs['monthlyCapSetBy']): string =>
  setBy === 'default' ? 'the default monthly budget' : `set by --monthly-cap; the default is US$${MONTHLY_BUDGET_USD}`;
const spendLine = (m: MonthSpend, setBy: EvalArgs['monthlyCapSetBy']): string =>
  `Spend this month (${m.month}): US$${usd4(m.spentUsd)} of US$${m.capUsd} (${capBy(setBy)}), US$${usd4(m.openUsd)} of it in open reservations, US$${usd4(m.remainingUsd)} left.`;

/** The verdict of a run: a variant's gate, or the run's (from the full pipeline when it ran). */
export type GateVerdict = 'pass' | 'fail' | 'blocked' | 'inconclusive';

/** The pipeline the gate decides on; the other pipeline variants are its ablations. */
export const SHIPPED = 'full';

const WORST: readonly GateVerdict[] = ['blocked', 'fail', 'inconclusive', 'pass'];
const worstOf = (states: readonly GateVerdict[]): GateVerdict => WORST.find((s) => states.includes(s)) ?? 'inconclusive';
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * "Beats the baseline" on pairwise-baseline. The baseline's side of each verdict is the pipeline's
 * loss, so the two sides are one sample split as p and 1 - p, not two runs gate() could compare.
 * The test is one-sided on the pipeline's win rate over the pieces with something to judge: pass
 * when its 95% Wilson interval lies above one half, fail when it lies below, inconclusive otherwise
 * (a tie included).
 */
function beatsBaseline(run: StoredRun, variant: string): { state: Exclude<GateVerdict, 'blocked'>; markdown: string } {
  const s = summarize(run);
  if (s.scored === 0) return { state: 'inconclusive', markdown: 'Not gated: no comparison with something to judge.' };
  const [lo, hi] = wilson(s.passes, s.scored);
  const state = lo > 0.5 ? 'pass' : hi < 0.5 ? 'fail' : 'inconclusive';
  const why = state === 'pass' ? 'the whole interval is above one half' : state === 'fail' ? 'the whole interval is below one half' : 'the interval includes one half';
  return {
    state,
    markdown: `### Eval gate: ${state}\n\n${variant} wins ${s.passes} of ${s.scored} comparisons with ${BASELINE} (${pct(s.rate)}, 95% CI ${pct(lo)} to ${pct(hi)}): ${why}. Not scored: ${s.failed} failed, ${s.noOutput} with the same text on both sides.`,
  };
}

/** The smallest margin, rounded up to three decimals, at which n of n against n of n passes decide(). */
const smallestMargin = (n: number): string => (Math.ceil(-differenceInterval(n, n, n, n).lower * 1000) / 1000).toFixed(3);

/** gate() over the pieces with something to judge: a text equal to its reference, or a failed judge call, is left out and counted. */
function notWorse(baseline: StoredRun | undefined, candidate: StoredRun | undefined, margin: number): { state: Exclude<GateVerdict, 'blocked'>; markdown: string } {
  if (baseline === undefined || candidate === undefined) return { state: 'inconclusive', markdown: 'Not gated: no judged pieces on one side.' };
  let result;
  try {
    result = gate(baseline, candidate, { allowMissing: true, margin });
  } catch (error) {
    if (!(error instanceof GateRefusal)) throw error;
    return { state: 'inconclusive', markdown: `Not gated: ${error.message}.` };
  }
  const n = Math.min(result.baseline.scored, result.candidate.scored);
  const small =
    result.state === 'inconclusive' && decide(n, n, n, n, result.margin) !== 'pass'
      ? `\n\nThis gate cannot pass with ${n} scored cases at a margin of ${result.margin}, even at 100% on both sides; the smallest margin that could pass is ${smallestMargin(n)}: grow the case set (D3) or pass --margin (D13).`
      : '';
  return { state: result.state, markdown: `${gateMarkdown(result)}${small}` };
}

/**
 * The gate of design 5, per pipeline variant against the single-call baseline: hard failures on
 * any of its rows block it; else it must beat the baseline on pairwise-baseline and not lose on
 * same-voice. Each other pipeline variant is also gated against full on pairwise-original, which
 * tells whether the stage it leaves out contributes. The run's state is full's when full ran,
 * else the worst of the variants'.
 */
export function gateReport(
  judges: readonly JudgeRecord[],
  code: readonly CodeRecord[],
  variants: readonly PipelineVariant[],
  options: { readonly margin?: number } = {},
): { markdown: string; state: GateVerdict } {
  if (!variants.some((v) => v.id === BASELINE)) return { markdown: '### Eval gate\n\nNo gate: no baseline among the variants (add single-call to --variants).', state: 'inconclusive' };
  const margin = options.margin ?? DEFAULT_MARGIN;
  const runs = judgeRuns(judges);
  const hard = hardFailures(code);
  const sections: string[] = [];
  const states = new Map<string, GateVerdict>();
  for (const v of variants) {
    if (v.id === BASELINE) continue;
    const blocking = hard.filter((r) => r.variant === v.id).length;
    const beats = beatsBaseline(runs.get(`pairwise-baseline/${v.id}`) ?? { format: RUN_FORMAT, rubric: { name: 'pairwise-baseline', version: '1' }, label: v.id, results: [], tables: [] }, v.id);
    const voice = notWorse(runs.get(`same-voice/${BASELINE}`), runs.get(`same-voice/${v.id}`), margin);
    const state: GateVerdict = blocking > 0 ? 'blocked' : worstOf([beats.state, voice.state]);
    states.set(v.id, state);
    const head = blocking > 0 ? `blocked by ${blocking} hard failure${blocking === 1 ? '' : 's'} (listed below)` : state;
    sections.push(`## ${v.id} against ${BASELINE}: ${head}`, `#### pairwise-baseline: ${v.id} against ${BASELINE}\n\n${beats.markdown}`, `#### same-voice: ${v.id} against ${BASELINE}\n\n${voice.markdown}`);
  }
  if (variants.some((v) => v.id === SHIPPED)) {
    for (const v of variants) {
      if (v.id === BASELINE || v.id === SHIPPED) continue;
      const ablation = notWorse(runs.get(`pairwise-original/${SHIPPED}`), runs.get(`pairwise-original/${v.id}`), margin);
      const reading =
        ablation.state === 'fail'
          ? `${v.id} is worse than ${SHIPPED}: the stage ${v.id} leaves out contributes.`
          : `No evidence that the stage ${v.id} leaves out contributes (${ablation.state}).`;
      sections.push(`### Ablation: ${v.id} against ${SHIPPED}\n\n${reading}\n\n${ablation.markdown}`);
    }
  }
  const state = states.get(SHIPPED) ?? worstOf([...states.values()]);
  return { markdown: [`# Eval gate: ${state}`, ...sections].join('\n\n'), state };
}

export async function runEvalCli(argv: readonly string[], deps: EvalCliDeps): Promise<number> {
  const usage = (message: string): number => {
    deps.stderr(`${message}\n${EVAL_USAGE}\n`);
    return EVAL_EXIT.usage;
  };
  const args = parseEvalArgs(argv);
  if (args === 'help') {
    deps.stdout(`${EVAL_USAGE}\n`);
    return EVAL_EXIT.ok;
  }
  if (typeof args === 'string') return usage(args);
  const cases = selectCases(deps.cases(), args.cases, args.limit);
  if (typeof cases === 'string') return usage(cases);
  const variants = selectVariants(args.variants);
  if (typeof variants === 'string') return usage(variants);
  const prices = deps.prices ?? builtInPrices;

  let ledger: SpendLedger;
  let month: MonthSpend;
  try {
    ledger = openLedger({ path: defaultLedgerPath(deps.home), monthlyCapUsd: args.monthlyCap, raised: args.monthlyCapSetBy === 'flag', clock: deps.clock });
  } catch (error) {
    return usage((error as Error).message);
  }
  try {
    month = ledger.month();
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n`);
    return EVAL_EXIT.failed;
  }

  if (args.dryRun) {
    const estimate = await estimateRun(cases, variants, deps.refs(), prices(deps.clock.now()));
    const lines = [
      `Dry run: ${estimate.pieces} pieces (${cases.length} cases x ${variants.length} variants), no model call made.`,
      `Worst case of the whole run: US$${usd4(estimate.worstUsd)} over at most ${estimate.calls} calls (an upper estimate; each live call reserves its own worst case).`,
      spendLine(month, args.monthlyCapSetBy),
    ];
    if (estimate.worstUsd > month.remainingUsd) lines.push('The worst case is more than what is left this month: the live run may stop on the budget. Try --limit or fewer --variants.');
    if (args.maxUsd !== null && estimate.worstUsd > args.maxUsd) lines.push(`The worst case is more than --max-usd ${args.maxUsd}: the live run may stop on it.`);
    deps.stdout(`${lines.join('\n')}\n`);
    return EVAL_EXIT.ok;
  }

  if (deps.apiKey === undefined || deps.apiKey === '') {
    deps.stderr('ANTHROPIC_API_KEY is not set: the live run needs it in the environment.\n');
    return EVAL_EXIT.failed;
  }
  const dir = args.out!;
  const paths = { pieces: join(dir, 'pieces.jsonl'), judges: join(dir, 'judges.jsonl'), code: join(dir, 'code.jsonl'), report: join(dir, 'report.md') };
  try {
    mkdirSync(dir, { recursive: true });
    for (const p of Object.values(paths)) freshOutput(p);
  } catch (error) {
    return usage((error as Error).message);
  }

  const budget = budgetedGateway(deps.gateway(deps.apiKey, args.monthlyCap), { ledger, prices, maxRunUsd: args.maxUsd });
  deps.stdout(`${spendLine(month, args.monthlyCapSetBy)}\nLive run: ${cases.length} cases x ${variants.length} variants, records in ${dir}\n`);
  const pieces: PieceRecord[] = [];
  const judges: JudgeRecord[] = [];
  let stopped: CapError | null = null;
  try {
    await runPipelines(cases, variants, {
      gateway: budget.gateway,
      refs: deps.refs(),
      record: (r) => {
        pieces.push(r);
        appendJsonl(paths.pieces, r);
      },
    });
    await judgePieces(cases, pieces, {
      gateway: budget.gateway,
      now: deps.clock.now(),
      record: (r) => {
        judges.push(r);
        appendJsonl(paths.judges, r);
      },
    });
  } catch (error) {
    if (!(error instanceof CapError)) throw error;
    stopped = error;
  }
  const code = scorePieces(cases, pieces);
  for (const r of code) appendJsonl(paths.code, r);
  const hard = hardFailures(code);
  const run = budget.run();
  const verdict = gateReport(judges, code, variants, { margin: args.margin });
  const report = [
    stopped === null ? null : `Stopped: ${stopped.message}. The records hold what ran before it.`,
    verdict.markdown,
    `### Hard failures\n\n${hard.length === 0 ? 'None.' : hard.slice(0, 20).map((r) => `- ${r.rubric} on ${r.case} (${r.variant})${r.detail === undefined ? '' : `: ${r.detail}`}`).join('\n')}`,
    `Code rubric runs: ${codeRuns(code).size}.`,
    costReport(costRows(pieces)),
    `This run: US$${usd4(run.spentUsd)} over ${run.calls} calls, judges included.`,
    spendLine(ledger.month(), args.monthlyCapSetBy),
  ]
    .filter((s) => s !== null)
    .join('\n\n');
  writeFileSync(paths.report, `${report}\n`);
  deps.stdout(`${report}\n`);
  if (stopped !== null) return EVAL_EXIT.stopped;
  return verdict.state === 'pass' ? EVAL_EXIT.ok : verdict.state === 'inconclusive' ? EVAL_EXIT.inconclusive : EVAL_EXIT.blocked;
}
