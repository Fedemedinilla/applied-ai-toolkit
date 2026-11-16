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
import { rawMatches, RULES } from '../../slop-lint/src/lint.ts';
import type { PatternRule } from '../../slop-lint/src/types.ts';
import { splitSentences } from './edits.ts';
import { Edit } from './types.ts';

/**
 * What the plan may decide for a sentence, after the examples of design 4.4 S2: cut it, make it
 * specific with a fact of the CV, remove a set phrase, or leave it alone. The reason says the rest.
 */
export const PLAN_ACTIONS = ['cut', 'make-specific', 'remove-formula', 'keep'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/** Format characters (zero-width spaces, soft hyphens, joiners): a model does not see them, a regex does. */
const FORMAT_CHARS = /\p{Cf}/gu;
const visible = (s: string): string => s.replace(FORMAT_CHARS, '');

/**
 * A labelled marker and nothing else: `[COMPLETAR: what is missing]` (design 4.6 step 5). The
 * label holds a letter or a digit, so "...", a space or an invisible character is not a label.
 */
const LABELLED_PLACEHOLDER = /^\[COMPLETAR:\s*(?=[^\]]*[\p{L}\p{N}])[^\]\s][^\]]*\]$/u;
const isLabelledRequest = (s: string): boolean => !/\p{Cf}/u.test(s) && LABELLED_PLACEHOLDER.test(s);

/** Every COMPLETAR marker in a text, labelled or not, as the reader sees it. */
const ANY_COMPLETAR = /\[\s*COMPLETAR\b[^\]]*\]/giu;
const LABELLED_IN_TEXT = /^\[COMPLETAR:\s*(?=[^\]]*[\p{L}\p{N}])[^\]\s][^\]]*\]$/u;

const FMT_04 = RULES.find((r): r is PatternRule => r.id === 'FMT-04' && r.kind === 'pattern');
if (FMT_04 === undefined) throw new Error('slop-lint has no FMT-04 pattern rule');

/** The FMT-04 matches of a text in either language: placeholders and chat residue, which S6 would revert. */
function fmt04(text: string): string[] {
  return (['es', 'en'] as const).flatMap((lang) => rawMatches(FMT_04 as PatternRule, text, lang).map((m) => text.slice(m.start, m.end)));
}

/**
 * PROVISIONAL. How many sentences an edit's `after` may hold beyond its `before`: one, so an edit
 * may split a sentence in two (a style edit for rhythm) but not turn one into a whole text. The
 * design says an edit stays inside one sentence (4.4 S3), or one paragraph in `reescritura`, and
 * gives no number; the evals of F6 confirm or change it.
 */
export const EDIT_EXTRA_SENTENCES = 1;

/**
 * The splitter's count, or a rougher one when that is higher: the pieces with a letter or a digit
 * between line breaks and terminators, wherever the next sentence starts (no space after the
 * period, a lowercase letter, a new line). A period between two digits is a decimal, not an end.
 * Both the quote and the replacement are counted the same way, so an abbreviation or a domain the
 * quote already has costs nothing.
 */
const sentenceCount = (s: string): number => {
  if (s.trim() === '') return 0;
  const rough = s
    .replace(/(\d)[.,](?=\d)/gu, '$1')
    .split(/\n|[.!?…]+/u)
    .filter((piece) => /[\p{L}\p{N}]/u.test(piece)).length;
  return Math.max(splitSentences(s, 'en').length, rough);
};

/**
 * What a model's edit may write, beyond the Edit schema: no marker without a real label, even one
 * hidden with a format character; no placeholder or chat residue slop-lint reports as FMT-04 that
 * the quoted text did not already have; and no more than EDIT_EXTRA_SENTENCES sentences beyond
 * the quote. The messages are fixed, so a refusal names the field and never the text.
 */
function modelEditProblem(e: { readonly before: string; readonly after: string }): string | null {
  const after = visible(e.after);
  if ([...after.matchAll(ANY_COMPLETAR)].some((m) => !LABELLED_IN_TEXT.test(m[0]))) return 'a placeholder needs a label: [COMPLETAR: ...]';
  const had = new Set(fmt04(visible(e.before)));
  if (fmt04(after).some((m) => !had.has(m))) return 'an edit may not add a placeholder or chat residue';
  if (sentenceCount(e.after) > sentenceCount(e.before) + EDIT_EXTRA_SENTENCES) return 'an edit stays inside its sentence';
  return null;
}

/** One problem per edit at most, and none when the Edit schema already refused `after`. */
function checkModelEdit(e: { readonly before: string; readonly after: string }, ctx: z.RefinementCtx): void {
  if (typeof e.after !== 'string' || typeof e.before !== 'string' || !Edit.shape.after.safeParse(e.after).success) return;
  const problem = modelEditProblem(e);
  if (problem !== null) ctx.addIssue({ code: 'custom', path: ['after'], message: problem });
}

/** The Edit a model stage returns: the shared schema plus checkModelEdit(). */
const ModelEdit = Edit.superRefine(checkModelEdit);

export const PlanItem = z.strictObject({
  sentenceId: z.number().int().nonnegative(),
  action: z.enum(PLAN_ACTIONS),
  reason: z.string().min(1),
  /** The slop-lint finding the item answers, when it answers one. */
  ruleId: z.string().min(1).optional(),
  /** A fact the text needs and neither the text nor the CV gives, asked for with its label. */
  request: z.string().refine(isLabelledRequest, 'a request is one labelled [COMPLETAR: ...]').optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

/** S2 decides per sentence and writes no text: no field of an item holds a replacement. */
export const PlanOutput = z.strictObject({ items: z.array(PlanItem) });
export type PlanOutput = z.infer<typeof PlanOutput>;

/**
 * What S2 hands the gateway: PlanOutput with `request` as any string, described for the model,
 * since the API's schema cannot carry the refine that holds it to one labelled marker. Why: in
 * run 3 two plans of es-trap-number-not-in-cv, which asks for the source of a number, failed the
 * whole piece with "The output does not satisfy the schema". planFromReply() keeps the item.
 */
export const PlanReply = z.strictObject({
  items: z.array(PlanItem.extend({ request: z.string().describe('Exactly one labelled marker and nothing else: [COMPLETAR: what is missing]').optional() })),
});

/** The plan of a PlanReply: a request keeps its first labelled marker, and goes when it has none. */
export function planFromReply(reply: z.infer<typeof PlanReply>): PlanOutput {
  return PlanOutput.parse({
    items: reply.items.map(({ request, ...item }) => {
      const marker = request === undefined ? undefined : [...visible(request).matchAll(ANY_COMPLETAR)].map((m) => m[0]).find(isLabelledRequest);
      return marker === undefined ? item : { ...item, request: marker };
    }),
  });
}

/**
 * S3: the existing Edit schema, so a bare [COMPLETAR] is refused here as everywhere else, with the
 * checks of checkModelEdit(). The number of edits is not capped here: it follows the plan, which
 * the stage that calls the model knows.
 */
export const EditOutput = z.strictObject({ edits: z.array(ModelEdit) });
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
  return z.strictObject({ edits: z.array(Edit.extend({ principleId }).superRefine(checkModelEdit)).max(max) });
}
export type StyleOutput = z.infer<ReturnType<typeof styleOutput>>;

/**
 * What the edit stages hand the gateway: the JSON shape of EditOutput and styleOutput() without
 * their per-edit checks, so a reply with one bad edit is still parsed. editProblem() then runs
 * those checks on each edit in code, and the stage refuses only the edit that fails them.
 */
const EditShape = Edit.extend({ after: z.string() });
export const EditReply = z.strictObject({ edits: z.array(EditShape) });
export function styleReply(principleIds: readonly string[]) {
  const [first, ...rest] = principleIds;
  const principleId = first === undefined ? z.string().min(1) : z.enum([first, ...rest]);
  return z.strictObject({ edits: z.array(EditShape.extend({ principleId })).max(first === undefined ? 0 : STYLE_MAX_EDITS) });
}

/** Why EditOutput would refuse this edit (the Edit schema, then checkModelEdit()), or null. */
export function editProblem(e: z.infer<typeof EditShape>): string | null {
  const parsed = Edit.safeParse(e);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'the edit does not satisfy the schema';
  return modelEditProblem(e);
}
