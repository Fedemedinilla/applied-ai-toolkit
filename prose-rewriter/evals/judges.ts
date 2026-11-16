/**
 * The judge rubrics of design section 5, each one a pass per piece so its pass rate goes into
 * evals' gate() and decide() unchanged:
 *
 * - pairwise-original: original against rewrite, "which one would you send?"; passes when the
 *   judge picks the rewrite;
 * - pairwise-baseline: the single-call baseline against a pipeline variant, the same question;
 *   passes when the judge picks the pipeline. The same verdicts give the baseline's side too
 *   (judgeRuns), so gate(baseline side, pipeline side) is a comparison of two stored runs;
 * - same-voice: "does it sound like the same person?", original and rewrite;
 * - register-fit: is the rewrite's register right for the genre, language and variety;
 * - literary-contamination: archaism, ornament or a storyteller's tone in the rewrite; passes
 *   when there is none.
 *
 * Blinding: each rubric is one judging run. Its pieces go through evals' blind(), which gives each
 * a random id, shuffles them and keeps which variant wrote what in a key the judge never sees; the
 * judge reads only the brief (genre, language, register) and the text, through rubricRequest().
 * A pairwise piece shows VERSION A and VERSION B in an order derived from the case id alone
 * (caseOrder), so the order is random across cases, the same on every run, and the same for
 * every variant of a case, which keeps the variants' comparison paired.
 *
 * Every judge call goes through the gateway with task rewrite.judge (gatewayModelClient), under the
 * same caps and ledger as the pipeline. A comparison of a text with itself (the rewrite changed
 * nothing) is not paid for: it is recorded as no-output. A piece that failed is recorded as failed
 * on every rubric, so a gate sees the gap instead of a better rate.
 */
import { z } from 'zod';
import { blind, type EvalRow, judgeWith, type JudgeRubric, RUN_FORMAT, type StoredRun } from '../../evals/src/index.ts';
import { CapError, type Gateway } from '../../gateway/src/index.ts';
import { gatewayModelClient } from '../src/model-client.ts';
import { callSettings } from '../src/tasks.ts';
import { defaultRegister, type RewriteInput } from '../src/types.ts';
import { measuredGateway, newMeter, type EvalCase, type Meter, type PieceRecord } from './pipeline.ts';

/** The id of the single-call baseline among the variants (pipeline.ts). */
export const BASELINE = 'single-call';

/** PROVISIONAL output budget of one judge call, thinking included: a starting value, measured in F6b. */
export const JUDGE_MAX_TOKENS = 2000;

const CALL = callSettings('rewrite.judge', JUDGE_MAX_TOKENS);

const JSON_ONLY = 'Answer with one JSON object and nothing else, no code fence.';

const Pick = z.strictObject({ choice: z.enum(['A', 'B']), note: z.string() });
type Pick = z.infer<typeof Pick>;

/** "Pass" in a pairwise verdict alone means B; judgePieces() maps the letter to a side through the order. */
function pairwise(name: 'pairwise-original' | 'pairwise-baseline'): JudgeRubric<Pick> {
  return {
    kind: 'judge',
    name,
    version: '1',
    instructions: [
      'You read two versions of the same message a person wrote while looking for work. You do not know who or what wrote either version, and it does not matter.',
      'Which one would you send, as that person, to that recipient? Judge what is written: clarity, specificity, tone for the genre and register in the brief. Do not reward length.',
      'Pick exactly one, A or B, even when they are close. In the note, say in one sentence what decided it.',
      `${JSON_ONLY} Shape: {"choice": "A" or "B", "note": string}.`,
    ].join('\n'),
    call: CALL,
    verdict: Pick,
    prompt: (piece) => ['BRIEF', piece.brief, '', piece.text].join('\n'),
    reduce: (v) => ({ pass: v.choice === 'B', metrics: {} }),
  };
}

const Same = z.strictObject({ same: z.boolean(), note: z.string() });
const Fits = z.strictObject({ fits: z.boolean(), note: z.string() });
const Contaminated = z.strictObject({ contaminated: z.boolean(), note: z.string() });

/** A yes or no rubric over one key of its verdict; `pass` reads the answer. */
function binary<V extends { note: string }>(name: string, verdict: z.ZodType<V>, key: keyof V & string, instructions: readonly string[], pass: (v: V) => boolean): JudgeRubric<V> {
  return {
    kind: 'judge',
    name,
    version: '1',
    instructions: [...instructions, `${JSON_ONLY} Shape: {"${key}": true or false, "note": string}.`].join('\n'),
    call: CALL,
    verdict,
    prompt: (piece) => ['BRIEF', piece.brief, '', piece.text].join('\n'),
    reduce: (v) => ({ pass: pass(v), metrics: {} }),
  };
}

const SAME_VOICE = binary(
  'same-voice',
  Same,
  'same',
  [
    'You read two versions of the same message. You do not know who or what wrote either version, and it does not matter.',
    'Does the second sound like the same person as the first? Look at the form of address, the length and rhythm of the sentences, the greeting and the sign-off, the punctuation habits, emoji and set phrases. A fix of a cliché does not change the voice; a new tone, a new form of address or a new habit does.',
    'In the note, name what differs, or say that nothing does.',
  ],
  (v) => v.same,
);

const REGISTER_FIT = binary(
  'register-fit',
  Fits,
  'fits',
  [
    'You read one message a person wrote while looking for work. You do not know who or what wrote it, and it does not matter.',
    'Is its register right for the genre, the language, the variety and the register in the brief? A message too stiff or too loose for them does not fit.',
    'In the note, name the line that decides it.',
  ],
  (v) => v.fits,
);

const LITERARY = binary(
  'literary-contamination',
  Contaminated,
  'contaminated',
  [
    'You read one message a person wrote while looking for work. You do not know who or what wrote it, and it does not matter.',
    'Does it read like literature instead of a working message: archaic words or forms (an enclitic pronoun such as "díjole" in Spanish), ornament, figures of speech, or the tone of a story?',
    'In the note, quote the words that decide it, or say that there are none.',
  ],
  (v) => !v.contaminated,
);

/** The rubrics, in the order judgePieces() runs them. */
export const JUDGE_RUBRICS: readonly JudgeRubric<object>[] = [pairwise('pairwise-original'), pairwise('pairwise-baseline'), SAME_VOICE, REGISTER_FIT, LITERARY];

const PAIRWISE: ReadonlySet<string> = new Set(['pairwise-original', 'pairwise-baseline']);
/** The rubrics that read two texts, and so have nothing to judge when the two are the same. */
const TWO_TEXTS: ReadonlySet<string> = new Set([...PAIRWISE, 'same-voice']);

/** FNV-1a over UTF-16 code units: small, stable, enough to spread case ids. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** AB: A is the reference side (the original or the baseline) and B the candidate; BA the other way. */
export function caseOrder(caseId: string, rubric: string): 'AB' | 'BA' {
  return hash(`${caseId}\0${rubric}`) % 2 === 0 ? 'AB' : 'BA';
}

export interface JudgeRecord {
  readonly rubric: string;
  readonly version: string;
  readonly case: string;
  /** The variant judged; for pairwise-baseline, the pipeline variant set against the baseline. */
  readonly variant: string;
  /** "no-output": nothing to judge (the two texts are the same). "failed": the piece or the judge call failed. */
  readonly status: 'scored' | 'no-output' | 'failed';
  readonly pass: boolean | null;
  readonly order?: 'AB' | 'BA';
  readonly verdict?: object;
  readonly detail?: string;
  readonly error?: string;
  readonly usage: { readonly calls: number; readonly costUsd: number | null; readonly tokens: Meter['tokens'] };
}

export interface JudgeOptions {
  readonly gateway: Gateway<string>;
  /** The run's date, one for every piece (evals' blind pieces carry it). */
  readonly now: Date;
  /** Seed of the blinding; by default derived from the case ids, so a run can be rebuilt. */
  readonly seed?: number;
  readonly userId?: string | null;
  readonly record?: (r: JudgeRecord) => void;
}

interface Item {
  readonly rubric: JudgeRubric<object>;
  readonly case: string;
  readonly variant: string;
  readonly lang: string;
  readonly brief: string;
  /** The reference side (the original or the baseline) first; one text for the one-text rubrics. */
  readonly texts: readonly [string, string] | readonly [string];
  readonly order?: 'AB' | 'BA';
  readonly skip?: { readonly status: 'no-output' | 'failed'; readonly detail: string };
}

function brief(input: RewriteInput): string {
  const language = input.lang === 'es' ? `Spanish${input.variety === undefined ? '' : `, ${input.variety} variety`}` : 'English';
  return `Genre: ${input.genre}. Language: ${language}. Register: ${input.register ?? defaultRegister(input.genre)}.`;
}

function pieceText(item: Item): string {
  if (item.texts.length === 1) return `MESSAGE\n${item.texts[0]}`;
  const [reference, candidate] = item.texts;
  if (!PAIRWISE.has(item.rubric.name)) return `FIRST\n${reference}\n\nSECOND\n${candidate}`;
  const [a, b] = item.order === 'BA' ? [candidate, reference] : [reference, candidate];
  return `VERSION A\n${a}\n\nVERSION B\n${b}`;
}

function items(cases: readonly EvalCase[], pieces: readonly PieceRecord[]): Item[] {
  const byCase = new Map(cases.map((c) => [c.id, c.input]));
  const out: Item[] = [];
  for (const rubric of JUDGE_RUBRICS) {
    for (const p of pieces) {
      const input = byCase.get(p.case);
      if (input === undefined) throw new Error(`piece of case ${p.case}, which is not among the cases`);
      const base = { rubric, case: p.case, variant: p.variant, lang: p.lang, brief: brief(input) };
      let reference = input.text;
      if (rubric.name === 'pairwise-baseline') {
        if (p.variant === BASELINE) continue;
        const baseline = pieces.find((q) => q.case === p.case && q.variant === BASELINE);
        if (baseline === undefined) continue;
        if (baseline.status !== 'done') {
          out.push({ ...base, texts: [''], skip: { status: 'failed', detail: 'the baseline piece failed' } });
          continue;
        }
        reference = baseline.rewritten;
      }
      if (p.status !== 'done') {
        out.push({ ...base, texts: [''], skip: { status: 'failed', detail: 'the piece failed' } });
        continue;
      }
      if (!TWO_TEXTS.has(rubric.name)) {
        out.push({ ...base, texts: [p.rewritten] });
        continue;
      }
      const order = PAIRWISE.has(rubric.name) ? { order: caseOrder(p.case, rubric.name) } : {};
      if (p.rewritten === reference) out.push({ ...base, texts: [reference, p.rewritten], ...order, skip: { status: 'no-output', detail: 'the two texts are the same' } });
      else out.push({ ...base, texts: [reference, p.rewritten], ...order });
    }
  }
  return out;
}

/** Pass for the candidate side: in a pairwise verdict, the letter the order gave the candidate. */
function candidatePass(item: Item, verdict: object): boolean {
  if (PAIRWISE.has(item.rubric.name)) return (verdict as Pick).choice === (item.order === 'BA' ? 'A' : 'B');
  return item.rubric.reduce(verdict).pass;
}

/**
 * Judges the pieces of a pipeline run with every rubric, one blinded run per rubric, and hands
 * each judge record to `record` as soon as it exists. A cap reached stops the run, as in
 * runPipelines().
 */
export async function judgePieces(cases: readonly EvalCase[], pieces: readonly PieceRecord[], options: JudgeOptions): Promise<JudgeRecord[]> {
  const all = items(cases, pieces);
  const seed = options.seed ?? hash(cases.map((c) => c.id).join('\0'));
  const records: JudgeRecord[] = [];
  const emit = (r: JudgeRecord): void => {
    records.push(r);
    options.record?.(r);
  };
  const zero = (): JudgeRecord['usage'] => ({ calls: 0, costUsd: 0, tokens: newMeter().tokens });
  const now = options.now.toISOString();
  for (const rubric of JUDGE_RUBRICS) {
    const mine = all.filter((i) => i.rubric === rubric);
    const head = (i: Item) => ({ rubric: rubric.name, version: rubric.version, case: i.case, variant: i.variant, ...(i.order === undefined ? {} : { order: i.order }) });
    for (const i of mine) if (i.skip !== undefined) emit({ ...head(i), status: i.skip.status, pass: null, detail: i.skip.detail, usage: zero() });
    const judged = mine.filter((i) => i.skip === undefined);
    // evals' blind() keeps the item's index as its "variant" in the key: the judge never sees it.
    const rows: EvalRow[] = judged.map((i, n) => ({
      variant: String(n),
      lang: i.lang,
      case: i.case,
      sample: 1,
      now,
      brief: i.brief,
      text: pieceText(i),
      words: 0,
      stop: 'end_turn',
      ms: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
    const { pieces: blinded, key } = blind(rows, seed);
    for (const piece of blinded) {
      const item = judged[Number(key[piece.id]?.variant)];
      if (item === undefined) throw new Error(`blind key has no item for ${piece.id}`);
      const meter = newMeter();
      const client = gatewayModelClient(measuredGateway(options.gateway, meter), { task: 'rewrite.judge', userId: options.userId ?? null, promptVersion: `rewrite-${rubric.name}@${rubric.version}` });
      const usage = (): JudgeRecord['usage'] => ({ calls: meter.calls, costUsd: meter.costUsd, tokens: { ...meter.tokens } });
      try {
        const { id: _id, judge: _judge, ...verdict } = await judgeWith(rubric, client, piece, '', 1, CALL);
        emit({ ...head(item), status: 'scored', pass: candidatePass(item, verdict), verdict, usage: usage() });
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        emit({ ...head(item), status: 'failed', pass: null, error: `${e.name}: ${e.message}`, usage: usage() });
        if (error instanceof CapError) throw error;
      }
    }
  }
  return records;
}

/**
 * The judge records as evals stored runs, one per rubric and variant, keyed "<rubric>/<label>".
 * pairwise-baseline also gets the baseline's side of each comparison, labelled
 * "single-call vs <variant>", whose pass is the pipeline's loss: gate(that, "<variant>") compares
 * the two sides of the same verdicts.
 */
export function judgeRuns(records: readonly JudgeRecord[]): Map<string, StoredRun> {
  const runs = new Map<string, StoredRun>();
  const add = (r: JudgeRecord, label: string, pass: boolean | null): void => {
    const k = `${r.rubric}/${label}`;
    const run = runs.get(k) ?? { format: RUN_FORMAT, rubric: { name: r.rubric, version: r.version }, label, results: [], tables: [] };
    run.results.push({ case: r.case, sample: 1, status: r.status, pass, metrics: {}, ...(r.detail === undefined ? {} : { detail: r.detail }) });
    runs.set(k, run);
  };
  for (const r of records) {
    add(r, r.variant, r.pass);
    if (r.rubric === 'pairwise-baseline') add(r, `${BASELINE} vs ${r.variant}`, r.pass === null ? null : !r.pass);
  }
  return runs;
}
