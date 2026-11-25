/**
 * diagnose(input, options): step 2 of the cohesion plan (roadmap-2026, salidas/disenos/
 * plan-cohesion-y-canal.md). It reads the whole message before anyone rewrites it: code measures
 * the shape against the channel guide (shape.ts) and one structured call says why the writer
 * writes, what the reader needs, where an idea does not follow, whether the opening and the closing
 * do what the channel asks and what reads as generated. The lint findings go in as hints.
 *
 * Code keeps only what the model can back. A purpose or a need counts only with a quote found in
 * the text, the recipient or the goal (case and spacing aside), so the plan built on it later never
 * starts from a guess about the reader. A gap must join two body sentences that follow each other,
 * and a generated-sounding quote must be in the sentence it names. What is dropped is listed.
 *
 * Not yet called by rewrite(); the 'drafted' strategy (the next step) will. A reply that cannot be
 * read is asked for once more, like the other stages; if the retry fails too, the shape still comes
 * back, with no reading.
 */
import { ResponseError } from '../../gateway/src/index.ts';
import { channelFor, type Channel } from '../../style-refs/src/index.ts';
import type { DiagnoseOutput } from './outputs.ts';
import type { PromptRefs } from './prompt.ts';
import { measureShape, type Shape } from './shape.ts';
import { analyse, prepare, type Analysis } from './stages/analyse.ts';
import { diagnoseStage, metered, STAGE_ATTEMPTS, type ModelStages, type Usage } from './stages/model.ts';
import { RewriteInput, type RewriteOptions } from './types.ts';

export { DIAGNOSE_PROMPT_VERSION } from './prompt.ts';

export interface Diagnosis {
  readonly shape: Shape;
  /** The model's reading after the checks, or null when no reply could be read. */
  readonly reading: DiagnoseOutput | null;
  /** What the checks took out of the reading, and why. */
  readonly dropped: readonly string[];
  readonly unread: boolean;
  readonly usage: Usage;
}

export type DiagnoseOptions = Pick<RewriteOptions, 'gateway' | 'refs' | 'userId' | 'jobId'>;

const EMPTY_REFS: PromptRefs = { principles: [], sources: [], examples: [] };

export const squash = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();

export async function diagnose(raw: RewriteInput, options: DiagnoseOptions): Promise<Diagnosis> {
  const a = analyse(prepare(RewriteInput.parse(raw)));
  const refs = options.refs ?? EMPTY_REFS;
  const usage: Usage = { calls: 0, costUsd: 0 };
  const m: ModelStages = {
    gateway: metered(options.gateway, usage),
    prompt: { input: a.input, register: a.register, refs },
    userId: options.userId ?? null,
    jobId: options.jobId ?? null,
  };
  return { ...(await readMessage(a, m)), usage };
}

/** The guide of the analysed text's channel, or undefined. */
export function guideOf(a: Analysis, refs: PromptRefs): Channel | undefined {
  const { genre, lang, variety } = a.input;
  return channelFor(refs.channels ?? [], { genre, lang, register: a.register, ...(variety === undefined ? {} : { variety }) });
}

/** The diagnosis over an analysis and stages rewrite() already built; diagnose() and the drafted strategy share it. */
export async function readMessage(a: Analysis, m: ModelStages): Promise<Omit<Diagnosis, 'usage'>> {
  const shape = measureShape(a.text, a.input.lang, guideOf(a, m.prompt.refs));
  let reply: DiagnoseOutput | null = null;
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS && reply === null; attempt++) {
    try {
      reply = await diagnoseStage(m, a.lint.findings, shape);
    } catch (error) {
      if (!(error instanceof ResponseError && error.code === 'invalid_output')) throw error;
    }
  }
  if (reply === null) return { shape, reading: null, dropped: [], unread: true };

  const r = a.input.recipient;
  const sources = [a.text, a.input.goal, r?.name, r?.org, r?.role, r?.previousMessage].filter((x): x is string => x !== undefined).map(squash);
  const dropped: string[] = [];
  const quoted = (field: 'purpose' | 'readerNeed'): DiagnoseOutput['purpose'] => {
    const q = reply[field];
    if (!q.found) return { ...q, quote: '' };
    if (q.quote.trim() !== '' && sources.some((s) => s.includes(squash(q.quote)))) return q;
    dropped.push(`${field}: «${q.quote}» is not in the text, the recipient or the goal`);
    return { found: false, quote: '', note: q.note };
  };
  const body = shape.bodySentenceIds;
  const gaps = reply.gaps.filter((g) => {
    const i = body.indexOf(g.afterSentenceId);
    const ok = i !== -1 && body[i + 1] === g.afterSentenceId + 1;
    if (!ok) dropped.push(`gap after sentence ${g.afterSentenceId}: both sentences must be body sentences, one after the other`);
    return ok;
  });
  const artificial = reply.artificial.filter((x) => {
    const sentence = a.sentences.find((s) => s.id === x.sentenceId);
    const ok = sentence !== undefined && squash(sentence.text).includes(squash(x.quote));
    if (!ok) dropped.push(`artificial in sentence ${x.sentenceId}: «${x.quote}» is not in that sentence`);
    return ok;
  });
  return { shape, reading: { ...reply, purpose: quoted('purpose'), readerNeed: quoted('readerNeed'), gaps, artificial }, dropped, unread: false };
}
