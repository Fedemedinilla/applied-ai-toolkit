/**
 * The public entry of prose-rewriter. Phase F0 published the contract; F4 adds the pure core
 * (voice profile, facts, edits, injection). rewrite() itself comes in F5, with the stages through
 * the gateway.
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
  type Treatment,
  type VoiceContext,
  type VoiceProfile,
  voicePromptLines,
  voiceProfile,
  type VoiceTrait,
  type VoiceViolation,
  voiceViolations,
} from './voice.ts';
