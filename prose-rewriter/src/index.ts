/**
 * The public entry of prose-rewriter. Phase F0 published the contract; F4 publishes the pure core:
 * the voice profile (voice.ts), the fact check (facts.ts), the sentences, edits and diff
 * (edits.ts) and the injection guard (injection.ts). No model, no gateway and no I/O in any of
 * them. F5 adds the model-facing building blocks: the four gateway tasks with their provisional
 * caps (tasks.ts), evals' ModelClient over the gateway (model-client.ts), which the fact judge
 * calls through, and the judge's own rubric with its revert plan and the D10 switch (rubric.ts).
 * rewrite(), with the stages S0 to S7 and the CLI, comes later in F5.
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
export { callSettings, PROVISIONAL_CAPS, REWRITE_TASKS, type RewriteTask, TASK_CONFIGS, taskConfig } from './tasks.ts';
export { gatewayModelClient, type ModelClientOptions } from './model-client.ts';
export {
  factSheet,
  type Fallback,
  type JudgeLine,
  judgeLines,
  judgeRuns,
  type PlanInput,
  planReverts,
  type RevertPlan,
  REWRITE_JUDGE_PROMPT_VERSION,
  REWRITE_RUBRIC,
  REWRITE_RUBRIC_VERSION,
  rewritePiece,
  rewriteRubric,
  RewriteVerdict,
  type UserClaim,
} from './rubric.ts';
