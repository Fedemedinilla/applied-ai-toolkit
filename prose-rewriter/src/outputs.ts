/**
 * The structured outputs of the model stages of design 4.4: the plan (S2), the edits (S3) and the
 * style edits (S4). The gateway sends each one as the call's JSON schema and validates the reply
 * with the same zod schema, so a reply outside these shapes never reaches the stages.
 *
 * Every key is fixed (no z.record), so a validation problem's path holds field names and indices,
 * never text from the CV (README, "What the gateway records"). Each root is an object: the edits
 * travel as `{ edits: [...] }`.
 */
import { z } from 'zod';
import { Edit } from './types.ts';

/**
 * What the plan may decide for a sentence, after the examples of design 4.4 S2: cut it, make it
 * specific with a fact of the CV, remove a set phrase, or leave it alone. The reason says the rest.
 */
export const PLAN_ACTIONS = ['cut', 'make-specific', 'remove-formula', 'keep'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/** A labelled marker and nothing else: `[COMPLETAR: what is missing]` (design 4.6 step 5). */
const LABELLED_PLACEHOLDER = /^\[COMPLETAR:\s*[^\]\s][^\]]*\]$/;

export const PlanItem = z.strictObject({
  sentenceId: z.number().int().nonnegative(),
  action: z.enum(PLAN_ACTIONS),
  reason: z.string().min(1),
  /** The slop-lint finding the item answers, when it answers one. */
  ruleId: z.string().min(1).optional(),
  /** A fact the text needs and neither the text nor the CV gives, asked for with its label. */
  request: z.string().regex(LABELLED_PLACEHOLDER, 'a request is one labelled [COMPLETAR: ...]').optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

/** S2 decides per sentence and writes no text: no field of an item holds a replacement. */
export const PlanOutput = z.strictObject({ items: z.array(PlanItem) });
export type PlanOutput = z.infer<typeof PlanOutput>;

/** S3: the existing Edit schema, so a bare [COMPLETAR] is refused here as everywhere else. */
export const EditOutput = z.strictObject({ edits: z.array(Edit) });
export type EditOutput = z.infer<typeof EditOutput>;

/**
 * PROVISIONAL. The design caps the style edits per text (4.4 S4) without a number. This one is a
 * starting point, not a measurement; the evals of F6 set it.
 */
export const STYLE_MAX_EDITS = 5;

/**
 * S4: edits of the same Edit shape, each citing one of the principles the prompt showed by id, at
 * most STYLE_MAX_EDITS per text. With no principle to cite, the only valid reply is no edit.
 */
export function styleOutput(principleIds: readonly string[]) {
  const [first, ...rest] = principleIds;
  const principleId = first === undefined ? z.string().min(1) : z.enum([first, ...rest]);
  const max = first === undefined ? 0 : STYLE_MAX_EDITS;
  return z.strictObject({ edits: z.array(Edit.extend({ principleId })).max(max) });
}
export type StyleOutput = z.infer<ReturnType<typeof styleOutput>>;
