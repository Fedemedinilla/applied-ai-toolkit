/**
 * The prompt-variant eval runner.
 *
 * For each sample, case, language and variant it builds the exact system blocks
 * the product sends (the target's own builder, not a copy), applies the
 * variant's edits, and calls the model with the target's own call settings.
 * Each finished piece is handed to `onRow` as soon as it exists, so a run cut
 * short keeps everything it already paid for.
 */
import type { CallSettings, ModelClient, ModelUsage, SystemBlock } from './model.ts';
import { applyEdits, type Variant } from './variants.ts';

/** What the runner needs from the thing under test. */
export interface WriterTarget<C extends { id: string }, L extends string> {
  /** The production call settings, imported from where the product reads them. */
  call: CallSettings;
  /**
   * The production system blocks for this case. `now` is passed in, never read
   * from a clock inside the target, so a run, a dump and a judge can all name
   * the date they mean.
   */
  system(c: C, lang: L, now: Date): SystemBlock[];
  /** The user message: the brief for this piece. */
  brief(c: C, lang: L): string;
  /**
   * Everything the writer is allowed to state, as the judge will read it,
   * including the date the writer was given. Variants edit rules, never facts:
   * a fixture fix goes into the target and applies to every variant, or the
   * judge would need a different sheet per variant and would learn which one
   * it is reading.
   */
  factSheet(c: C, lang: L, now: Date): string;
}

export type Job<C, L> = { variant: string; lang: L; c: C; sample: number };

export type EvalRow<L extends string = string> = {
  variant: string;
  lang: L;
  case: string;
  sample: number;
  /** The date every prompt of the run was built with, ISO 8601. One per run. */
  now: string;
  brief: string;
  text: string;
  words: number;
  stop: string | null;
  ms: number;
  usage: ModelUsage;
};

/**
 * A call that failed after its retries. It is written to the same JSONL as the
 * rows, so blinding and aggregation know a piece is missing and from which
 * variant. Failures are not random across variants (a variant that writes
 * longer pieces times out more), so a silent gap would bias the comparison.
 */
export type EvalFailure = { variant: string; lang: string; case: string; sample: number; error: string };

export const isFailure = (r: EvalRow | EvalFailure): r is EvalFailure => 'error' in r;

/**
 * Jobs in the order they run: sample-major, variant-minor. A run that stops
 * halfway has every variant covered equally for the samples it finished,
 * instead of all of V0 and none of V4.
 */
export function planJobs<C extends { id: string }, L extends string>(
  cases: readonly C[],
  variants: readonly string[],
  langs: readonly L[],
  samples: number,
): Job<C, L>[] {
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`samples must be a positive integer, got ${samples}`);
  const jobs: Job<C, L>[] = [];
  for (let sample = 1; sample <= samples; sample++)
    for (const c of cases)
      for (const lang of langs)
        for (const variant of variants) jobs.push({ variant, lang, c, sample });
  return jobs;
}

function variantById<L extends string>(variants: readonly Variant<L>[], id: string): Variant<L> {
  const v = variants.find((x) => x.id === id);
  if (!v) throw new Error(`unknown variant ${id}`);
  return v;
}

/** The system blocks one job sends. */
export function systemFor<C extends { id: string }, L extends string>(
  target: WriterTarget<C, L>,
  variants: readonly Variant<L>[],
  job: Job<C, L>,
  now: Date,
): SystemBlock[] {
  return applyEdits(target.system(job.c, job.lang, now), variantById(variants, job.variant).edits(job.lang));
}

/**
 * Builds every job's prompt without calling anything. Throws on the first edit
 * that misses or is ambiguous, which is the point: it runs before the first
 * paid call.
 */
export function preflight<C extends { id: string }, L extends string>(
  target: WriterTarget<C, L>,
  variants: readonly Variant<L>[],
  jobs: readonly Job<C, L>[],
  now: Date = new Date(),
): void {
  for (const j of jobs) systemFor(target, variants, j, now);
}

/**
 * The date every dump is rendered at. A dump made on Monday and one made on
 * Friday have to compare equal when the prompt has not changed, so the dump
 * never reads the clock. The date block's template is still compared; only
 * the date in it is fixed.
 */
export const DUMP_NOW = new Date('2000-01-05T15:00:00Z');

/**
 * The prompts a set of jobs would send, keyed by language and case and NOT by
 * variant. That is what makes the ship check possible: dump the winning
 * variant before changing the product, dump V0 after, and the two files must
 * be identical. Only then is the shipped prompt the one that was measured.
 * Every prompt is rendered at DUMP_NOW, so the two dumps can be days apart.
 */
export function dumpPrompts<C extends { id: string }, L extends string>(
  target: WriterTarget<C, L>,
  variants: readonly Variant<L>[],
  jobs: readonly Job<C, L>[],
  now: Date = DUMP_NOW,
): Record<string, SystemBlock[]> {
  const out: Record<string, SystemBlock[]> = {};
  const seen = new Set<string>();
  for (const j of jobs) {
    if (seen.has(j.variant + '\0' + j.lang + '\0' + j.c.id)) continue;
    seen.add(j.variant + '\0' + j.lang + '\0' + j.c.id);
    const key = `${j.lang} ${j.c.id}`;
    const blocks = systemFor(target, variants, j, now);
    const prev = out[key];
    if (prev && JSON.stringify(prev) !== JSON.stringify(blocks)) {
      throw new Error(`dump: two variants in one dump give different prompts for "${key}"; dump one variant at a time`);
    }
    out[key] = blocks;
  }
  return out;
}

export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export type RunOptions<C extends { id: string }, L extends string> = {
  client: ModelClient;
  target: WriterTarget<C, L>;
  variants: readonly Variant<L>[];
  jobs: readonly Job<C, L>[];
  concurrency?: number;
  /**
   * The date for every prompt of the run, read once. A run that crosses
   * midnight keeps one date, so every variant answers the same "next
   * Thursday" and the judge checks all of them against the same TODAY line.
   */
  now?: Date;
  onRow?: (row: EvalRow<L>) => void;
  onFailure?: (failure: EvalFailure) => void;
};

export async function runEval<C extends { id: string }, L extends string>(
  opts: RunOptions<C, L>,
): Promise<{ rows: EvalRow<L>[]; failures: EvalFailure[] }> {
  const { client, target, variants, jobs } = opts;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 3));
  const now = opts.now ?? new Date();
  preflight(target, variants, jobs, now);

  const rows: EvalRow<L>[] = [];
  const failures: EvalFailure[] = [];
  let next = 0;

  async function runOne(j: Job<C, L>) {
    const brief = target.brief(j.c, j.lang);
    const t0 = performance.now();
    const reply = await client.create({
      ...target.call,
      system: systemFor(target, variants, j, now),
      messages: [{ role: 'user', content: brief }],
    });
    const row: EvalRow<L> = {
      variant: j.variant,
      lang: j.lang,
      case: j.c.id,
      sample: j.sample,
      now: now.toISOString(),
      brief,
      text: reply.text,
      words: wordCount(reply.text),
      stop: reply.stopReason,
      ms: Math.round(performance.now() - t0),
      usage: reply.usage,
    };
    rows.push(row);
    opts.onRow?.(row);
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++]!;
        try {
          await runOne(j);
        } catch (e) {
          const status = (e as { status?: unknown })?.status;
          const failure: EvalFailure = {
            variant: j.variant,
            lang: j.lang,
            case: j.c.id,
            sample: j.sample,
            error: `${typeof status === 'number' ? status + ' ' : ''}${String((e as Error)?.message ?? e).slice(0, 200)}`,
          };
          failures.push(failure);
          opts.onFailure?.(failure);
        }
      }
    }),
  );
  return { rows, failures };
}
