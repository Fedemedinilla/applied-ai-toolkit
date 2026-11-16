/**
 * The model stages of design 4.4, each one structured call through the gateway with the prompt of
 * prompt.ts and the output schema of outputs.ts:
 *
 * - S2 plan: what to fix per sentence, from S1's findings; it writes no text;
 * - S3 edit: one edit per item of the plan, and at most one extra round (S6) with the level 1
 *   findings that remain, whose history is rebuilt from what the first round parsed, never from
 *   the raw reply (design 4.9);
 * - S4 style: edits that cite a principle, at most STYLE_MAX_EDITS (outputs.ts). Skipped in
 *   `minimo`, and when the prompt shows no principle to cite, since then the only valid reply is
 *   no edit and the call would buy nothing.
 *
 * Also the meter behind RewriteResult.usage: every call through the gateway, the judge's included,
 * counted with its cost.
 */
import type { z } from 'zod';
import type { CallMeta, Conversation, Gateway } from '../../../gateway/src/index.ts';
import type { Finding } from '../../../slop-lint/src/types.ts';
import type { Sentence } from '../edits.ts';
import { wrapData } from '../injection.ts';
import { EditOutput, type PlanOutput } from '../outputs.ts';
import { editPrompt, planPrompt, stylePrompt, type PromptContext, type StagePrompt } from '../prompt.ts';
import type { Edit, JudgeClient } from '../types.ts';

/**
 * PROVISIONAL output budgets per stage, in tokens, thinking included: starting values under the
 * gateway's limit without streaming (16 000), not measurements. F6 measures the real replies.
 */
export const STAGE_MAX_TOKENS = { 'rewrite.plan': 4000, 'rewrite.edit': 6000, 'rewrite.style': 4000 } as const;

/** What RewriteResult.usage reports: costUsd turns null once any call has no price. */
export interface Usage {
  calls: number;
  costUsd: number | null;
}

/** The gateway, with every call it completes added to `usage`. */
export function metered(gateway: Gateway<string>, usage: Usage): Gateway<string> {
  const add = <R extends { readonly meta: CallMeta<string> }>(result: R): R => {
    usage.calls += 1;
    usage.costUsd = usage.costUsd === null || result.meta.costUsd === null ? null : usage.costUsd + result.meta.costUsd;
    return result;
  };
  return {
    structured: async (schema, request) => add(await gateway.structured(schema, request)),
    structuredStream: (schema, request) => {
      const call = gateway.structuredStream(schema, request);
      return { started: call.started, final: call.final.then(add) };
    },
    text: async (request) => add(await gateway.text(request)),
  };
}

/** A judge client the caller passed: counted, with no price. */
export function meteredJudge(client: JudgeClient, usage: Usage): JudgeClient {
  return {
    async create(request) {
      const reply = await client.create(request);
      usage.calls += 1;
      usage.costUsd = null;
      return reply;
    },
  };
}

export interface ModelStages {
  readonly gateway: Gateway<string>;
  readonly prompt: PromptContext;
  readonly userId: string | null;
  readonly jobId: string | null;
}

async function call<S extends z.ZodType>(m: ModelStages, p: StagePrompt<S>, messages: Conversation = p.messages): Promise<z.output<S>> {
  const task = p.task as keyof typeof STAGE_MAX_TOKENS;
  const result = await m.gateway.structured(p.schema, {
    task,
    userId: m.userId,
    jobId: m.jobId,
    promptVersion: p.promptVersion,
    maxTokens: STAGE_MAX_TOKENS[task],
    system: p.system,
    messages,
  });
  return result.data;
}

/** S2. */
export async function planStage(m: ModelStages, findings: readonly Finding[]): Promise<PlanOutput> {
  return call(m, planPrompt(m.prompt, findings));
}

/**
 * PROVISIONAL, the edit cap per text that F5a left open: S3 keeps at most one edit per item of
 * the plan that is not "keep" (design 4.4: "por ítem del plan, una edición"), and the extra round
 * at most one per finding it was given; edits past the cap are dropped before placement. S4 is
 * capped by its schema (STYLE_MAX_EDITS). F6 confirms or changes both.
 */
export function editCap(plan: PlanOutput): number {
  return plan.items.filter((i) => i.action !== 'keep').length;
}

/** What the first S3 round leaves for the extra one: its prompt and what was parsed from its reply. */
export interface EditRound {
  readonly prompt: StagePrompt<typeof EditOutput>;
  readonly parsed: EditOutput;
  readonly edits: Edit[];
}

/** S3. */
export async function editStage(m: ModelStages, plan: PlanOutput): Promise<EditRound> {
  const prompt = editPrompt(m.prompt, plan);
  const parsed = await call(m, prompt);
  return { prompt, parsed, edits: parsed.edits.slice(0, editCap(plan)) };
}

/** The extra round's promptVersion: a fixed constant, like every other. */
const EXTRA_SUFFIX = '+extra';

const EXTRA_TASK = [
  'TASK: edit, second round',
  'These slop-lint findings of level 1 remain in the text after your edits. Propose the smallest edit that solves each one, against the same numbered TEXT as before: the sentenceId and "before" quoted exactly from that sentence, "after", the reason and the ruleId.',
  'An edit that overlaps one of your earlier edits is refused, so quote a part of the sentence your earlier edits left alone.',
].join('\n');

/** A finding that remains, with the sentence of the original it sits in (null: the whole text). */
export interface Remaining {
  readonly finding: Finding;
  readonly sentenceId: number | null;
}

/**
 * S3's extra round. The conversation is the first round's user turn, the edits parsed from its
 * reply as the assistant turn, and a user turn with the findings as a list: it still ends on a
 * user turn, so there is no prefill.
 */
export async function extraEditStage(m: ModelStages, first: EditRound, remaining: readonly Remaining[]): Promise<Edit[]> {
  const lines = remaining.map(({ finding: f, sentenceId }) => `[${sentenceId ?? 'whole text'}] ${f.ruleId} (level ${f.level}): «${f.match}»: ${f.message}`);
  const [opening] = first.prompt.messages;
  if (opening === undefined) throw new Error('the first edit round has no user turn');
  const messages: Conversation = [
    opening,
    { role: 'assistant', content: JSON.stringify(first.parsed) },
    { role: 'user', content: [EXTRA_TASK, '', 'FINDINGS (slop-lint, by sentenceId)', wrapData('texto', lines.join('\n'))].join('\n') },
  ];
  const parsed = await call(m, { ...first.prompt, promptVersion: `${first.prompt.promptVersion}${EXTRA_SUFFIX}` }, messages);
  return parsed.edits.slice(0, remaining.length);
}

/** S4, or null when it does not run (see the header). */
export async function styleStage(m: ModelStages): Promise<Edit[] | null> {
  const prompt = stylePrompt(m.prompt);
  if (prompt.principleIds.length === 0) return null;
  return (await call(m, prompt)).edits;
}

/** The sentence of `sentences` a position falls in, or null. */
export function sentenceAt(sentences: readonly Sentence[], position: number): number | null {
  return sentences.find((s) => s.start <= position && position < s.end)?.id ?? null;
}
