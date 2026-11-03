/**
 * Blind judging against the fact sheet, line by line, with a written rubric.
 *
 * The code splits each piece into numbered lines (one sentence each) before the
 * judge sees it, and refuses a verdict that does not account for every line
 * exactly once. "Does this piece invent anything?" asked of a whole piece gets
 * a skim; asked of line 3 against the sheet, it gets a lookup. The invented
 * claims that mattered in the case study were plausible ones (a school closed
 * on a staff day, a bakery with no gluten-free bread), and only a line-by-line
 * comparison with the sheet catches a claim that sounds like a fact.
 *
 * The output shape is enforced twice: by the API (structured output with the
 * JSON schema below) and by zod after parsing, because the second check is the
 * one that also runs against a fake client in tests.
 */
import { z } from 'zod';
import type { BlindPiece } from './blind.ts';
import type { CallSettings, ModelClient, ModelRequest } from './model.ts';

export const RUBRIC = `You judge short pieces of business writing against a fact sheet. You do not know who or what wrote each piece, and it does not matter.

For every numbered line, decide where its content comes from:
- "fact-sheet": every fact in the line (price, hour, date, name, address, phone, channel, rule, procedure) appears in the fact sheet, copied exactly.
- "brief": the fact comes from the brief the writer was given.
- "arithmetic": a sum of loaded figures, or a loaded unit figure times a quantity the brief gives, with the unit figure shown.
- "no-claim": the line states no fact (a greeting, a signature, a question to the reader, a sentence of tone).
- "invented": at least one fact in the line is in neither the sheet nor the brief. This includes things that are usually true of this kind of business, a procedure (how to book, who to ask, what happens to something already arranged, when someone will call), and a yes or no about whether the business has, sells or does something the sheet does not mention. Rounding or rewording a loaded number is invented too.

When you mark a line "invented", say in the note which claim is not loaded. A plausible claim is still invented.

Then judge the piece as a whole:
- voice: "on" if it follows the TONE lines of the sheet (greeting, signature, person, sentence length), "off" if it breaks one of them. Name the broken line in the note.
- robotic: true if the piece talks about its own data or limits instead of talking as the business ("I can't confirm that here", "I don't have that information", "according to my records").
- quality: 1 to 5. 5 is a piece the owner would send unchanged. 4 needs one small edit. 3 needs a rewrite of one sentence. 2 is wrong in a way a customer would notice. 1 is unusable. A piece with an invented fact is never above 2.

Judge only what is written. Do not reward length.`;

export const LineSupport = z.enum(['fact-sheet', 'brief', 'arithmetic', 'no-claim', 'invented']);

export const Verdict = z.strictObject({
  lines: z.array(z.strictObject({ line: z.number().int().min(1), support: LineSupport, note: z.string() })),
  voice: z.enum(['on', 'off']),
  robotic: z.boolean(),
  quality: z.number().int().min(1).max(5),
  note: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

/**
 * The same shape for the API's structured output, written by hand: the
 * structured-output schema does not take numeric bounds, so `quality` is an
 * enum here and a bounded integer in zod. A test checks that the two agree on
 * keys, required fields and labels.
 */
export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          support: { type: 'string', enum: LineSupport.options },
          note: { type: 'string' },
        },
        required: ['line', 'support', 'note'],
        additionalProperties: false,
      },
    },
    voice: { type: 'string', enum: ['on', 'off'] },
    robotic: { type: 'boolean' },
    quality: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    note: { type: 'string' },
  },
  required: ['lines', 'voice', 'robotic', 'quality', 'note'],
  additionalProperties: false,
} as const;

export const JUDGE_CALL: CallSettings = {
  model: 'claude-opus-5-5',
  max_tokens: 4000,
  output_config: { effort: 'medium', format: { type: 'json_schema', schema: VERDICT_JSON_SCHEMA } },
};

/** One sentence per line. A subject line or a signature stays a line of its own. */
export function numberedLines(text: string): string[] {
  return text
    .split('\n')
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=\S)/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function judgeRequest(piece: BlindPiece, factSheet: string, call: CallSettings = JUDGE_CALL): ModelRequest {
  const lines = numberedLines(piece.text);
  const body = [
    'FACT SHEET',
    factSheet,
    '',
    'BRIEF',
    piece.brief,
    '',
    `PIECE (${lines.length} lines)`,
    ...lines.map((l, i) => `${i + 1}. ${l}`),
  ].join('\n');
  return { ...call, system: [{ type: 'text', text: RUBRIC }], messages: [{ role: 'user', content: body }] };
}

export class JudgeError extends Error {
  override name = 'JudgeError';
}

/** Parses and checks one verdict. Every line from 1 to n, each exactly once. */
export function parseVerdict(raw: string, lineCount: number): Verdict {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new JudgeError('judge reply is not JSON');
  }
  const parsed = Verdict.safeParse(json);
  if (!parsed.success) throw new JudgeError(`judge reply has the wrong shape: ${parsed.error.issues[0]?.message}`);
  checkLineCoverage(parsed.data, lineCount);
  return parsed.data;
}

/** Every line from 1 to n, each exactly once. Also run on stored verdicts at aggregation. */
export function checkLineCoverage(v: Pick<Verdict, 'lines'>, lineCount: number): void {
  const seen = v.lines.map((l) => l.line).sort((a, b) => a - b);
  const expected = Array.from({ length: lineCount }, (_, i) => i + 1);
  if (seen.join(',') !== expected.join(',')) {
    throw new JudgeError(`judge covered lines [${seen.join(',')}], expected 1..${lineCount} once each`);
  }
}

/** A verdict as stored in verdicts.jsonl, checked again when it is read back. */
export const JudgedPiece = Verdict.extend({ id: z.string().min(1), judge: z.number().int().min(1) });
export type JudgedPiece = z.infer<typeof JudgedPiece>;

export async function judgePiece(
  client: ModelClient,
  piece: BlindPiece,
  factSheet: string,
  judge = 1,
  call: CallSettings = JUDGE_CALL,
): Promise<JudgedPiece> {
  const reply = await client.create(judgeRequest(piece, factSheet, call));
  if (reply.stopReason === 'max_tokens' || reply.stopReason === 'refusal') {
    throw new JudgeError(`judge stopped with ${reply.stopReason} on ${piece.id}`);
  }
  return { id: piece.id, judge, ...parseVerdict(reply.text, numberedLines(piece.text).length) };
}

export const inventedLines = (v: Verdict) => v.lines.filter((l) => l.support === 'invented');

export type Consensus = {
  id: string;
  judges: number;
  invented: boolean;
  robotic: boolean;
  offVoice: boolean;
  quality: number;
  /** All judges gave the same invented / not-invented call. */
  unanimous: boolean;
};

/**
 * Several judges per piece, combined. A flag needs a strict majority, so with
 * two judges it needs both; quality is the median. The unanimity bit is kept
 * because a split call is the piece a human should read.
 */
export function consensus(verdicts: readonly JudgedPiece[]): Consensus {
  const first = verdicts[0];
  if (!first) throw new Error('consensus of zero verdicts');
  if (verdicts.some((v) => v.id !== first.id)) throw new Error('consensus across different pieces');
  const n = verdicts.length;
  const majority = (flag: (v: JudgedPiece) => boolean) => verdicts.filter(flag).length * 2 > n;
  const inventedVotes = verdicts.filter((v) => inventedLines(v).length > 0).length;
  const q = verdicts.map((v) => v.quality).sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const quality = n % 2 ? q[mid]! : (q[mid - 1]! + q[mid]!) / 2;
  return {
    id: first.id,
    judges: n,
    invented: inventedVotes * 2 > n,
    robotic: majority((v) => v.robotic),
    offVoice: majority((v) => v.voice === 'off'),
    quality,
    unanimous: inventedVotes === 0 || inventedVotes === n,
  };
}
