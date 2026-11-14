/**
 * What a rubric is, so the same pipeline can measure any task.
 *
 * A rubric names itself and its version, says what a verdict looks like (a zod
 * schema), and reduces one verdict to pass or fail plus named numbers. There
 * are two kinds, and they differ only in where the verdict comes from:
 *
 * - A judge rubric asks a model. It carries the instructions, the call
 *   settings and the function that lays out the user message.
 * - A code rubric computes the verdict from the output and a labelled
 *   expected value. No model is called, so there is nothing to blind and
 *   nothing to pay.
 *
 * Both may carry a completeness check: the rule that a verdict has to account
 * for every unit of what it judged (every line of a piece, every field of a
 * record). A verdict that skips a unit is refused, when it is produced and
 * again when it is read back from a file.
 *
 * Blinding is not left to each rubric. A judge rubric never receives the row
 * of the run. `rubricRequest` hands it the five blind fields and nothing
 * else, copied one by one, so a rubric that serializes everything it was
 * given still cannot send the variant, the sample number or the token counts.
 */
import type { z } from 'zod';
import type { BlindPiece } from './blind.ts';
import type { CallSettings, ModelClient, ModelRequest } from './model.ts';

/** One verdict, reduced. `pass` feeds the pass rate; `metrics` are averaged in reports. */
export type Outcome = { pass: boolean; metrics: Record<string, number> };

/** A summary table a rubric computes over all its verdicts (a confusion matrix, per-field accuracy). */
export type Table = { title: string; columns: string[]; rows: (string | number)[][]; note?: string | undefined };

type RubricBase<V> = {
  /** With `version`, the identity of the rubric. Two runs are comparable only when both match. */
  name: string;
  /** Changes whenever the instructions, the labels or the scoring change. */
  version: string;
  /** The shape of one verdict. Checked when a verdict is produced and when it is read back. */
  verdict: z.ZodType<V>;
  /** Pass or fail, plus named numbers. Pure: the same verdict always reduces the same way. */
  reduce(verdict: V): Outcome;
  /** One line a person reads next to a failing case. */
  describe?(verdict: V): string;
  /** Summary tables over every verdict of a run. */
  tables?(verdicts: readonly V[]): Table[];
};

/** What a judge is allowed to read of a piece: no id, no variant, no run metadata. */
export type BlindContent = Pick<BlindPiece, 'case' | 'lang' | 'now' | 'brief' | 'text'>;

export type JudgeRubric<V extends object> = RubricBase<V> & {
  kind: 'judge';
  /** The system prompt of the judge. */
  instructions: string;
  /** Model, output ceiling and the structured-output schema of the verdict. */
  call: CallSettings;
  /** The user message for one piece. `reference` is what the piece is judged against. */
  prompt(piece: BlindContent, reference: string): string;
  /** Throws when the verdict does not account for every unit of the piece. */
  complete?(verdict: V, piece: BlindContent): void;
};

export type CodeRubric<V extends object, E> = RubricBase<V> & {
  kind: 'code';
  /** The shape of the labelled expected value of one item. */
  expected: z.ZodType<E>;
  /** Computes the verdict. Deterministic, and never calls a model. */
  score(output: string, expected: E): V;
  /** Throws when the verdict does not account for every unit of the expected value. */
  complete?(verdict: V, expected: E): void;
};

export type Rubric<V extends object, E = never> = JudgeRubric<V> | CodeRubric<V, E>;

export class JudgeError extends Error {
  override name = 'JudgeError';
}

export class RubricError extends Error {
  override name = 'RubricError';
}

const blindContent = (p: BlindContent): BlindContent => ({ case: p.case, lang: p.lang, now: p.now, brief: p.brief, text: p.text });

/** The request one judge call sends. `call` can replace the rubric's settings, for a different judge model. */
export function rubricRequest<V extends object>(
  rubric: JudgeRubric<V>,
  piece: BlindPiece,
  reference: string,
  call: CallSettings = rubric.call,
): ModelRequest {
  const body = rubric.prompt(blindContent(piece), reference);
  return { ...call, system: [{ type: 'text', text: rubric.instructions }], messages: [{ role: 'user', content: body }] };
}

/** Parses one judge reply: JSON, then the rubric's schema, then its completeness check. */
export function parseJudgeReply<V extends object>(rubric: JudgeRubric<V>, raw: string, piece: BlindPiece): V {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new JudgeError('judge reply is not JSON');
  }
  const parsed = rubric.verdict.safeParse(json);
  if (!parsed.success) throw new JudgeError(`judge reply has the wrong shape: ${parsed.error.issues[0]?.message}`);
  rubric.complete?.(parsed.data, blindContent(piece));
  return parsed.data;
}

/** A verdict as stored in a verdicts file: the piece it is about and which judge gave it. */
export type Judged<V extends object> = { id: string; judge: number } & V;

/**
 * One judge call for one blind piece. A cut reply or a refusal is an error,
 * not a verdict: half a JSON object must not be parsed, and a refusal whose
 * text happens to parse must not count.
 */
export async function judgeWith<V extends object>(
  rubric: JudgeRubric<V>,
  client: ModelClient,
  piece: BlindPiece,
  reference: string,
  judge = 1,
  call: CallSettings = rubric.call,
): Promise<Judged<V>> {
  const reply = await client.create(rubricRequest(rubric, piece, reference, call));
  if (reply.stopReason === 'max_tokens' || reply.stopReason === 'refusal') {
    throw new JudgeError(`judge stopped with ${reply.stopReason} on ${piece.id}`);
  }
  return { id: piece.id, judge, ...parseJudgeReply(rubric, reply.text, piece) };
}

/**
 * Reads one stored verdict of a judge rubric back from a verdicts file. The
 * verdict's own fields are checked first and the id and judge number after, so
 * the message names the same problem the judge's reply would have been
 * refused for.
 */
export function readJudged<V extends object>(rubric: JudgeRubric<V>, raw: unknown): Judged<V> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RubricError('expected an object');
  const { id, judge, ...rest } = raw as Record<string, unknown>;
  const parsed = rubric.verdict.safeParse(rest);
  if (!parsed.success) throw new RubricError(String(parsed.error.issues[0]?.message));
  if (typeof id !== 'string' || id === '') throw new RubricError('id must be a non-empty string');
  if (typeof judge !== 'number' || !Number.isInteger(judge) || judge < 1) throw new RubricError('judge must be a positive integer');
  return { id, judge, ...parsed.data };
}
