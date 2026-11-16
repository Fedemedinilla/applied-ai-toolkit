/**
 * The contract of the rewriter, as zod schemas: what rewrite() takes, the edits a model proposes,
 * the fact report and what rewrite() returns. Phase F0 of the design fixes these shapes; the
 * stages that fill them come in F4 and F5.
 *
 * The user's text and CV are data, never instructions. The model never returns a whole text: it
 * proposes edits over exact quoted spans, and code applies, checks and reverts them.
 */
import { z } from 'zod';
import type { ModelClient } from '../../evals/src/index.ts';
import type { Gateway } from '../../gateway/src/index.ts';
import type { LintResult } from '../../slop-lint/src/types.ts';
import type { PromptRefs } from './prompt.ts';
import { GENRES } from '../../style-refs/src/index.ts';

/** The genres come from style-refs, so a principle and a rewrite cannot name different lists. */
export { GENRES };
export const Genre = z.enum(GENRES);
export type Genre = z.infer<typeof Genre>;

export const Lang = z.enum(['es', 'en']);
export type Lang = z.infer<typeof Lang>;

/** Spanish only. */
export const Variety = z.enum(['rioplatense', 'neutral']);
export type Variety = z.infer<typeof Variety>;

export const Register = z.enum(['formal', 'neutral', 'casual']);
export type Register = z.infer<typeof Register>;

/** How far a rewrite may go: the smallest fix, a polish, or a real rewording by paragraph. */
export const Mode = z.enum(['minimo', 'pulido', 'reescritura']);
export type Mode = z.infer<typeof Mode>;

/** WhatsApp defaults to the smallest edit; every other genre to a polish. */
export function defaultMode(genre: Genre): Mode {
  return genre === 'whatsapp' ? 'minimo' : 'pulido';
}

/**
 * The register a genre is rewritten in when the input sets none (design 4.3 leaves it "según el
 * género"). PROVISIONAL: it follows the register of style-refs' examples for each genre (formal
 * cover letter, neutral email and follow-up, casual WhatsApp), so the prompt finds examples by
 * default. The evals of F6 may change it.
 */
export function defaultRegister(genre: Genre): Register {
  const registers: Readonly<Record<Genre, Register>> = { 'cover-letter': 'formal', email: 'neutral', 'follow-up': 'neutral', whatsapp: 'casual' };
  return registers[genre];
}

const Text = z.string().min(1);

export const RewriteInput = z
  .strictObject({
    text: Text,
    genre: Genre,
    lang: Lang,
    variety: Variety.optional(),
    register: Register.optional(),
    mode: Mode.optional(),
    profile: z.strictObject({
      cvMarkdown: Text,
      anchors: z.array(Text).optional(),
      extraFacts: z.array(Text).optional(),
    }),
    recipient: z
      .strictObject({
        name: Text.optional(),
        org: Text.optional(),
        role: Text.optional(),
        previousMessage: Text.optional(),
      })
      .optional(),
    goal: Text.optional(),
    /** Phrases that are never touched. */
    keep: z.array(Text).optional(),
    /** Runs the fact judge on WhatsApp in `minimo` mode too. */
    strict: z.boolean().optional(),
  })
  .refine((input) => input.variety === undefined || input.lang === 'es', { message: 'variety applies to Spanish only', path: ['variety'] });
export type RewriteInput = z.infer<typeof RewriteInput>;

/**
 * A missing fact is asked for with a labelled marker, `[COMPLETAR: what is missing]`. A bare
 * `[COMPLETAR]` is refused: slop-lint reports it as FMT-04 (level 1), so the edit would be
 * reverted anyway, and the label is what tells the user what to fill in.
 */
const BARE_PLACEHOLDER = /\[\s*COMPLETAR\s*(?::\s*)?\]/i;

/** One edit a model proposes: the exact text it replaces in one sentence, and the replacement. */
export const Edit = z.strictObject({
  sentenceId: z.number().int().nonnegative(),
  /** Quoted exactly from the text; an edit whose `before` is not found is rejected in code. */
  before: Text,
  after: z.string().refine((s) => !BARE_PLACEHOLDER.test(s), { message: 'a placeholder needs a label: [COMPLETAR: ...]' }),
  reason: Text,
  ruleId: Text.optional(),
  principleId: Text.optional(),
  /** Set when the edit removes a fact on purpose; accepted only if the fact stays in another sentence. */
  drop: z.boolean().optional(),
});
export type Edit = z.infer<typeof Edit>;

/** Every list holds normalized facts (numbers with units, dates, names, tools, anchors). */
export const FactReport = z.strictObject({
  kept: z.array(z.string()),
  dropped: z.array(z.string()),
  /** In the rewrite and in none of the original, the CV or the recipient: what nothing backs. */
  added: z.array(z.string()),
  /** Taken from the CV or the recipient and not in the original: shown as "added from the CV". */
  fromCv: z.array(z.string()),
  /** In the user's text and not in the CV: flagged, never strengthened or removed. */
  notInCv: z.array(z.string()),
  placeholders: z.array(z.string()),
});
export type FactReport = z.infer<typeof FactReport>;

export const STAGES = ['prepare', 'analyse', 'plan', 'edit', 'style', 'factcheck', 'relint', 'assemble'] as const;

const Span = z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() });

export const DiffHunk = z.strictObject({ span: Span, before: z.string(), after: z.string() });
export type DiffHunk = z.infer<typeof DiffHunk>;

export const Change = z.strictObject({
  id: Text,
  span: Span,
  before: z.string(),
  after: z.string(),
  reason: Text,
  ruleId: Text.optional(),
  principleId: Text.optional(),
  stage: z.enum(STAGES),
  status: z.enum(['applied', 'reverted']),
  revertReason: Text.optional(),
});
export type Change = z.infer<typeof Change>;

export const Flag = z.strictObject({
  kind: z.enum(['not-in-cv', 'missing-fact', 'tone-risk', 'length', 'injection']),
  span: Span.optional(),
  message: Text,
});
export type Flag = z.infer<typeof Flag>;

/** slop-lint's result for the text before and after, produced by our own call to lint(), not parsed. */
const Lint = z.custom<LintResult>((value) => typeof value === 'object' && value !== null && 'findings' in value);

export const RewriteResult = z.strictObject({
  rewritten: z.string(),
  diff: z.array(DiffHunk),
  changes: z.array(Change),
  facts: FactReport,
  lint: z.strictObject({ before: Lint, after: Lint }),
  flags: z.array(Flag),
  status: z.enum(['ok', 'needs-review', 'blocked']),
  /** costUsd is null when the gateway has no price for a model: never an invented number. */
  usage: z.strictObject({ calls: z.number().int().nonnegative(), costUsd: z.number().nonnegative().nullable() }),
  /** A note for the user about the whole result, such as the early exit's "No encontré nada para cambiar" (S1b). */
  message: Text.optional(),
});
export type RewriteResult = z.infer<typeof RewriteResult>;

/** What rewrite() is given besides the input (section 4.11): the caller injects the gateway; tests pass a fake. */
export interface RewriteOptions {
  /** Every model call goes through it, the fact judge's included (design 4.6): there is no other client to pass. */
  readonly gateway: Gateway<string>;
  /** style-refs' principles, sources and examples, loaded by the caller (style-refs has no I/O). Without them the prompt shows none and S4 is skipped. */
  readonly refs?: PromptRefs;
  /** The gateway's userId: a UUID or null, never a name or an address. Default null. */
  readonly userId?: string | null;
  /** The gateway's jobId, which groups the calls of one rewrite under the per-job cap. Default null. */
  readonly jobId?: string | null;
  /** Skips S4 in every mode: the "without S4" ablation of the evals (design 5). Default false. */
  readonly skipStyle?: boolean;
  /**
   * 'staged' (the default): S2 plan and S3 edit, S4 style and at most one extra S3 round.
   * 'single': one call plans and edits (the prompt of the single-call baseline, design 4.10), and
   * its edits pass the same S5, the fact judge, S6 and S7; no S4 and no extra round. At most one
   * call plus the judge's. F6b measures it against both (decided 16/11/2026).
   */
  readonly strategy?: Strategy;
}

export const STRATEGIES = ['staged', 'single'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/**
 * The fact judge of section 4.6 runs evals' line-by-line judge through this interface, built over
 * the gateway in F5, so the judge's calls also go through the caps.
 */
export type JudgeClient = ModelClient;
