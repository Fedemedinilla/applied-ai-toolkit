/**
 * The multi-stage pipeline runner of design section 5 ("F6 suma"). evals' runner is built for a
 * target of one call whose variants only edit system blocks (evals/src/runner.ts,
 * evals/src/variants.ts), so it cannot express "without S4", "one call" or "another model on
 * rewrite.edit". Here a variant is a configuration of rewrite() instead:
 *
 * - full: the pipeline as shipped;
 * - no-style: without S4 (RewriteOptions.skipStyle);
 * - no-examples: style-refs' examples left out of the prompt (an empty `examples` in the refs);
 * - single-call: the cost and quality baseline of design 4.10, plan and edit in one call
 *   (singleCall() below, a minimal target over the stage's call and outputs.ts, not a copy of
 *   rewrite()), with none of the checks;
 * - single-guarded: rewrite() with strategy 'single', the same one call followed by the same S5,
 *   judge, S6 and S7 as the pipeline (decided 16/11/2026 after run 3, where single-call matched the
 *   pipeline in the blind judge but lost a real name);
 * - edit-sonnet-5-5: rewrite.edit on another model, sent as the gateway request's own `config`
 *   (the gateway's way to try a model "without touching production", gateway/src/config.ts), so
 *   every variant shares one gateway, one ledger and one set of caps.
 *
 * "Without excerpts", the fifth ablation of design 5, is not a variant: the prompt shows no
 * excerpt today (PromptRefs has principles, sources and examples only), so it would be the full
 * pipeline under another name and would pay for the same calls twice.
 *
 * runPipelines() runs cases x variants, case-major and variant-minor, so a run cut short has every
 * variant on the cases it finished. Each piece is handed to `record` as soon as it exists (the CLI
 * passes evals' appendJsonl), with its usage measured on the gateway: calls, tokens, cache reads,
 * whether S3 ran an extra round, and the cost. A piece that fails is recorded and the run goes on;
 * a cap reached is recorded and stops the run, since every later call would meet the same cap.
 */
import { randomUUID } from 'node:crypto';
import {
  CapError,
  ResponseError,
  type CallMeta,
  type Effort,
  type Gateway,
  type GatewayRequest,
  type SupportedModel,
  type TokenTotals,
} from '../../gateway/src/index.ts';
import { applyEdits, renderEdits, tidyDeletions } from '../src/edits.ts';
import { restoreData } from '../src/injection.ts';
import { editProblem } from '../src/outputs.ts';
import type { PromptRefs } from '../src/prompt.ts';
import { rewrite } from '../src/rewrite.ts';
import { analyse, earlyExit, prepare } from '../src/stages/analyse.ts';
import { paragraphUnits } from '../src/stages/check.ts';
import { EXTRA_SUFFIX, metered, singleStage, type Usage } from '../src/stages/model.ts';
import { defaultMode, RewriteInput, type Edit, type Genre, type Lang, type Mode, type RewriteResult, type Strategy } from '../src/types.ts';

/** The writing tasks a variant may move to another model. The judge stays put (see pipelineVariant). */
export const OVERRIDABLE_TASKS = ['rewrite.plan', 'rewrite.edit', 'rewrite.style'] as const;
export type OverridableTask = (typeof OVERRIDABLE_TASKS)[number];

export interface PipelineVariant {
  readonly id: string;
  readonly kind: 'pipeline' | 'single-call';
  /** Without S4. */
  readonly skipStyle?: boolean;
  /**
   * rewrite()'s strategy, for a pipeline variant. Default 'staged', passed to rewrite() explicitly:
   * rewrite()'s own default is 'single', and the 'full' variant measures the staged pipeline.
   */
  readonly strategy?: Strategy;
  /** Without style-refs' examples in the prompt. */
  readonly withoutExamples?: boolean;
  /** Model and effort per writing task, sent as the request's config instead of the task config. */
  readonly tasks?: Partial<Record<OverridableTask, { readonly model: SupportedModel; readonly effort: Effort }>>;
}

/**
 * Checks a variant. The fact judge is not overridable: its client checks its call settings
 * against the static task config (model-client.ts), so a judge on another model would be measured
 * under the wrong label. Nor is a pipeline knob on the single-call target or on the 'single'
 * strategy, which have no plan or S4, nor a strategy on the single-call target, which is not rewrite().
 */
export function pipelineVariant(v: PipelineVariant): PipelineVariant {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(v.id)) throw new Error(`variant id ${JSON.stringify(v.id)} is not kebab-case`);
  for (const task of Object.keys(v.tasks ?? {})) {
    if (!(OVERRIDABLE_TASKS as readonly string[]).includes(task)) throw new Error(`variant ${v.id} overrides ${task}; only ${OVERRIDABLE_TASKS.join(', ')} may move to another model`);
  }
  if (v.kind === 'single-call' && v.strategy !== undefined) throw new Error(`variant ${v.id}: the single-call target is not rewrite() and takes no strategy`);
  const oneCall = v.kind === 'single-call' || v.strategy === 'single';
  if (oneCall && (v.skipStyle === true || v.tasks?.['rewrite.plan'] !== undefined || v.tasks?.['rewrite.style'] !== undefined)) {
    throw new Error(`variant ${v.id}: a single call has no plan or style stage`);
  }
  return v;
}

/**
 * The variants of design 5. The other model on rewrite.edit is claude-sonnet-5-5, the judge's
 * model and the other candidate D2 names, at the same effort as the edit task.
 */
export const VARIANTS: readonly PipelineVariant[] = (
  [
    { id: 'full', kind: 'pipeline' },
    { id: 'no-style', kind: 'pipeline', skipStyle: true },
    { id: 'no-examples', kind: 'pipeline', withoutExamples: true },
    { id: 'single-call', kind: 'single-call' },
    { id: 'single-guarded', kind: 'pipeline', strategy: 'single' },
    { id: 'edit-sonnet-5-5', kind: 'pipeline', tasks: { 'rewrite.edit': { model: 'claude-sonnet-5-5', effort: 'medium' } } },
  ] satisfies PipelineVariant[]
).map(pipelineVariant);

/** One eval case: a fictional input and a stable id. */
export interface EvalCase {
  readonly id: string;
  readonly input: RewriteInput;
}

/** What the single-call baseline returns. */
export interface SingleCallResult {
  readonly kind: 'single-call';
  readonly rewritten: string;
  /** Edits placed in the text, and edits refused (schema, quote not found, overlap, keep). */
  readonly applied: number;
  readonly refused: number;
  readonly usage: Usage;
  readonly message?: string;
}

export interface SingleCallOptions {
  readonly gateway: Gateway<string>;
  readonly refs: PromptRefs;
  readonly userId?: string | null;
  readonly jobId?: string | null;
}

/**
 * The single-call baseline: S0, S1 and S1b as in rewrite(), then one call that plans and edits,
 * and the edits that pass the model-edit checks placed by applyEdits(). No S5, S6, extra round or
 * judge: it is the "one prompt" the pipeline has to beat, so it gets nothing the stages add. Its
 * call is the one rewrite() makes with strategy 'single' (singleStage), so the two variants differ
 * only in the guards.
 */
export async function singleCall(raw: RewriteInput, options: SingleCallOptions): Promise<SingleCallResult> {
  const a = analyse(prepare(RewriteInput.parse(raw)));
  const early = earlyExit(a);
  if (early !== null) return { kind: 'single-call', rewritten: early.rewritten, applied: 0, refused: 0, usage: { calls: 0, costUsd: 0 }, ...(early.message === undefined ? {} : { message: early.message }) };
  const usage: Usage = { calls: 0, costUsd: 0 };
  const gateway = metered(options.gateway, usage);
  const prompt = { input: a.input, register: a.register, refs: options.refs };
  const reply = await singleStage({ gateway, prompt, userId: options.userId ?? null, jobId: options.jobId ?? null }, a.lint.findings);
  const edits: Edit[] = reply.map((e) => ({ ...e, before: restoreData(e.before), after: restoreData(e.after) }));
  const valid = edits.filter((e) => editProblem(e) === null);
  const units = a.mode === 'reescritura' ? paragraphUnits(a.text, a.sentences) : a.sentences;
  const placed = applyEdits(a.text, units, valid, { keep: a.input.keep ?? [] });
  // S7 of rewrite() takes the space a deleted sentence leaves behind; the baseline does the same,
  // so the variants still differ only in the guards.
  const rewritten = renderEdits(a.text, tidyDeletions(a.text, placed.accepted));
  return { kind: 'single-call', rewritten, applied: placed.accepted.length, refused: edits.length - placed.accepted.length, usage };
}

/** What one piece cost, measured on the gateway. */
export interface PieceUsage {
  readonly calls: number;
  /** Null once any call has no price: never an invented number. */
  readonly costUsd: number | null;
  /** Summed over the calls that returned; a reply the schema refused reports its cost but not its tokens. */
  readonly tokens: TokenTotals;
  /** S3 ran its second round (design 4.4 S6); a retry of a stage reply is not one. Always false for the single-call target and the 'single' strategy. */
  readonly extraRound: boolean;
}

interface PieceBase {
  readonly case: string;
  readonly genre: Genre;
  readonly lang: Lang;
  readonly mode: Mode;
  readonly variant: string;
  readonly usage: PieceUsage;
}

export type PieceRecord =
  | (PieceBase & { readonly status: 'done'; readonly rewritten: string; readonly result: (RewriteResult & { readonly kind: 'pipeline' }) | SingleCallResult })
  /** `error` is the error's class and message; gateway and schema messages name fields, never the text. */
  | (PieceBase & { readonly status: 'failed'; readonly error: string });

/** Calls, cost and tokens of the calls made through measuredGateway(). */
export interface Meter {
  calls: number;
  costUsd: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
  /** Requests of S3's extra round, told apart by its promptVersion: a stage retry is not one. */
  extraRounds: number;
}

export const newMeter = (): Meter => ({ calls: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, extraRounds: 0 });

/**
 * The gateway with every call measured into `meter`, and the given task overrides sent in the
 * request's config. Streaming is passed through unmeasured: no stage and no judge streams.
 */
export function measuredGateway(gateway: Gateway<string>, meter: Meter, tasks: PipelineVariant['tasks'] = {}): Gateway<string> {
  const configured = <R extends GatewayRequest<string>>(request: R): R => {
    if (request.task === 'rewrite.edit' && request.promptVersion.endsWith(EXTRA_SUFFIX)) meter.extraRounds += 1;
    const override = tasks[request.task as OverridableTask];
    return override === undefined ? request : { ...request, config: override };
  };
  const cost = (c: number | null): void => {
    meter.calls += 1;
    meter.costUsd = meter.costUsd === null || c === null ? null : meter.costUsd + c;
  };
  const add = <R extends { readonly meta: CallMeta<string> }>(result: R): R => {
    cost(result.meta.costUsd);
    const t = result.meta.tokens;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) meter.tokens[k] += t[k];
    return result;
  };
  const paidFailure = (error: unknown): never => {
    // A reply the model sent and the schema refused was paid for.
    if (error instanceof ResponseError) cost(error.costUsd);
    throw error;
  };
  return {
    structured: (schema, request) => gateway.structured(schema, configured(request)).then(add, paidFailure),
    structuredStream: (schema, request) => gateway.structuredStream(schema, configured(request)),
    text: (request) => gateway.text(configured(request)).then(add, paidFailure),
  };
}

export interface PipelineRunOptions {
  readonly gateway: Gateway<string>;
  readonly refs: PromptRefs;
  /** Called with each piece as soon as it exists. */
  readonly record?: (r: PieceRecord) => void;
  /** The gateway's userId: a UUID or null. Default null, an eval run without a user. */
  readonly userId?: string | null;
}

function unique(what: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${what} ${id} is listed twice`);
    seen.add(id);
  }
}

export async function runPipelines(cases: readonly EvalCase[], variants: readonly PipelineVariant[], options: PipelineRunOptions): Promise<PieceRecord[]> {
  // A repeat would pay for the same piece twice and weigh one side more: refused before any call.
  unique('case', cases.map((c) => c.id));
  unique('variant', variants.map((v) => pipelineVariant(v).id));
  const parsed = cases.map((c) => ({ id: c.id, input: RewriteInput.parse(c.input) }));
  const records: PieceRecord[] = [];
  for (const c of parsed) {
    for (const v of variants) {
      const meter = newMeter();
      const gateway = measuredGateway(options.gateway, meter, v.tasks);
      const refs = v.withoutExamples === true ? { ...options.refs, examples: [] } : options.refs;
      // One job per piece, so the per-job cap applies to each piece. The gateway takes a UUID only.
      const common = { gateway, refs, userId: options.userId ?? null, jobId: randomUUID() };
      const base = { case: c.id, genre: c.input.genre, lang: c.input.lang, mode: c.input.mode ?? defaultMode(c.input.genre), variant: v.id };
      const usage = (): PieceUsage => ({
        calls: meter.calls,
        costUsd: meter.costUsd,
        tokens: { ...meter.tokens },
        // A second rewrite.edit call may be a retry of an unreadable reply (rewrite.ts readable()):
        // only the extra round's own promptVersion counts. The single strategy has no extra round.
        extraRound: meter.extraRounds > 0,
      });
      let record: PieceRecord;
      let stop: unknown = null;
      try {
        const result: (RewriteResult & { kind: 'pipeline' }) | SingleCallResult =
          v.kind === 'single-call' ? await singleCall(c.input, common) : { kind: 'pipeline', ...(await rewrite(c.input, { ...common, skipStyle: v.skipStyle === true, strategy: v.strategy ?? 'staged' })) };
        record = { ...base, status: 'done', rewritten: result.rewritten, result, usage: usage() };
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        record = { ...base, status: 'failed', error: `${e.name}: ${e.message}`, usage: usage() };
        if (error instanceof CapError) stop = error;
      }
      records.push(record);
      options.record?.(record);
      if (stop !== null) throw stop;
    }
  }
  return records;
}
