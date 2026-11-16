/**
 * The deterministic stages before any model call (design 4.4):
 *
 * - S0 prepare: NFC, the frame (subject from a first "Asunto:"/"Subject:" line per D6, greeting,
 *   body, signature), the numbered sentences, and the injection flags of the text and the CV;
 * - S1 analyse: slop-lint with the genre, language and variety, the voice profile and the fact
 *   inventory, whose not-in-cv flags are shown and never acted on (D7);
 * - S1b early exit: in `minimo` with no level 1 or 2 finding, the text comes back unchanged and
 *   no model is called.
 *
 * Pure: no gateway, no I/O.
 */
import { lint } from '../../../slop-lint/src/lint.ts';
import type { LintResult } from '../../../slop-lint/src/types.ts';
import { splitSentences, textParts, type PartSpan, type Sentence } from '../edits.ts';
import { factReport, inventory, type ExtractOptions, type FactSources, type LabelledFact } from '../facts.ts';
import { injectionFlags } from '../injection.ts';
import { defaultMode, defaultRegister, type Flag, type Mode, type Register, type RewriteInput, type RewriteResult } from '../types.ts';
import { voiceProfile, type VoiceProfile } from '../voice.ts';

const nfc = (s: string): string => s.normalize('NFC');
const nfcAll = (list: readonly string[] | undefined): string[] | undefined => list?.map(nfc);

/** S0's output: the input in NFC, its frame and sentences, and the injection flags. */
export interface Prepared {
  /** The parsed input with every string the stages compare in NFC. */
  readonly input: RewriteInput;
  /** input.text, in NFC: every span and sentence points into it. */
  readonly text: string;
  readonly parts: PartSpan[];
  readonly sentences: Sentence[];
  /** What C is made of (design 4.6): the CV, the recipient and the extra facts. */
  readonly sources: FactSources;
  readonly flags: Flag[];
}

/** S0. `input` is already parsed with RewriteInput. */
export function prepare(raw: RewriteInput): Prepared {
  const r = raw.recipient;
  const input: RewriteInput = {
    ...raw,
    text: nfc(raw.text),
    profile: {
      cvMarkdown: nfc(raw.profile.cvMarkdown),
      ...(raw.profile.anchors === undefined ? {} : { anchors: nfcAll(raw.profile.anchors) }),
      ...(raw.profile.extraFacts === undefined ? {} : { extraFacts: nfcAll(raw.profile.extraFacts) }),
    },
    ...(r === undefined ? {} : { recipient: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === undefined ? v : nfc(v)])) }),
    ...(raw.keep === undefined ? {} : { keep: nfcAll(raw.keep) }),
    ...(raw.goal === undefined ? {} : { goal: nfc(raw.goal) }),
  };
  const { text, lang } = input;
  const recipient = [r?.name, r?.org, r?.role, r?.previousMessage].filter((v): v is string => v !== undefined).map(nfc);
  const sources: FactSources = {
    cv: input.profile.cvMarkdown,
    ...(recipient.length === 0 ? {} : { recipient }),
    ...(input.profile.extraFacts === undefined ? {} : { extraFacts: input.profile.extraFacts }),
  };
  // A flag's span points into the text, so the CV's flags keep only their message.
  const cvFlags = injectionFlags(input.profile.cvMarkdown, 'perfil', lang).map(({ span: _span, ...flag }) => flag);
  return {
    input,
    text,
    parts: textParts(text, lang),
    sentences: splitSentences(text, lang),
    sources,
    flags: [...injectionFlags(text, 'texto', lang), ...cvFlags],
  };
}

/** S1's output, on top of S0's. */
export interface Analysis extends Prepared {
  readonly mode: Mode;
  readonly register: Register;
  readonly lint: LintResult;
  readonly voice: VoiceProfile;
  readonly facts: LabelledFact[];
  readonly extractOptions: ExtractOptions;
}

/** slop-lint over any text of this input (the original in S1, a rewrite in S6 and S7), with the same options. */
export function lintAs(input: RewriteInput, text: string): LintResult {
  const { genre, lang, variety } = input;
  const previous = input.recipient?.previousMessage;
  return lint(text, {
    lang,
    genre,
    ...(variety === undefined ? {} : { variety }),
    ...(input.profile.anchors === undefined ? {} : { anchors: input.profile.anchors }),
    ...(previous === undefined ? {} : { previous }),
  });
}

/** S1. Adds the not-in-cv flags to S0's. */
export function analyse(p: Prepared): Analysis {
  const { input, text } = p;
  const { genre, lang } = input;
  const result = lintAs(input, text);
  const extractOptions: ExtractOptions = { lang, ...(input.profile.anchors === undefined ? {} : { anchors: input.profile.anchors }) };
  const inv = inventory(text, p.sources, extractOptions);
  return {
    ...p,
    mode: input.mode ?? defaultMode(genre),
    register: input.register ?? defaultRegister(genre),
    lint: result,
    voice: voiceProfile(text, lang),
    facts: inv.facts,
    extractOptions,
    flags: [...p.flags, ...inv.flags],
  };
}

const NOTHING_TO_CHANGE = { es: 'No encontré nada para cambiar', en: 'I found nothing to change' } as const;

/**
 * S1b. In `minimo` mode with no finding of level 1 or 2, the finished result: the text as it came
 * (in NFC), no change, zero calls. Otherwise null, and the model stages run.
 */
export function earlyExit(a: Analysis): RewriteResult | null {
  if (a.mode !== 'minimo' || a.lint.findings.some((f) => f.level === 1 || f.level === 2)) return null;
  return {
    rewritten: a.text,
    diff: [],
    changes: [],
    facts: factReport(a.text, a.text, a.sources, a.extractOptions),
    lint: { before: a.lint, after: a.lint },
    flags: a.flags,
    status: 'ok',
    usage: { calls: 0, costUsd: 0 },
    message: NOTHING_TO_CHANGE[a.input.lang],
  };
}
