/**
 * The public entry of prose-rewriter. Phase F0 published the contract; F4 publishes the pure core:
 * the voice profile (voice.ts), the fact check (facts.ts), the sentences, edits and diff
 * (edits.ts) and the injection guard (injection.ts). No model, no gateway and no I/O in any of
 * them. rewrite() comes in F5, with the stages S0 to S7 through the gateway and the CLI.
 */
export {
  Change,
  defaultMode,
  DiffHunk,
  Edit,
  FactReport,
  Flag,
  Genre,
  GENRES,
  Lang,
  Mode,
  Register,
  RewriteInput,
  RewriteResult,
  type JudgeClient,
  type RewriteOptions,
  STAGES,
  Variety,
} from './types.ts';
export {
  GENRE_REQUIRES,
  isGreetingLine,
  isSignOffLine,
  signOffIndex,
  type Treatment,
  type VoiceContext,
  type VoiceProfile,
  voicePromptLines,
  voiceProfile,
  type VoiceTrait,
  type VoiceViolation,
  voiceViolations,
} from './voice.ts';
export {
  canonicalNumber,
  checkEdit,
  type EditCheck,
  type EditContext,
  extract,
  type ExtractOptions,
  type Fact,
  FACT_KINDS,
  factInvariant,
  type FactKind,
  type FactLabel,
  factReport,
  type FactSources,
  type InvariantResult,
  inventory,
  type LabelledFact,
  placeholders,
  type RevertReason,
} from './facts.ts';
export {
  type AppliedEdit,
  applyEdits,
  type ApplyOptions,
  type ApplyResult,
  diffHunks,
  type PartSpan,
  type RejectedEdit,
  type RejectReason,
  renderEdits,
  revertEdit,
  type Sentence,
  splitSentences,
  type TextPart,
  textParts,
  type TextRange,
} from './edits.ts';
export {
  DATA_TAGS,
  type DataSource,
  injectionFlags,
  restoreData,
  unwrapData,
  wrapData,
} from './injection.ts';
