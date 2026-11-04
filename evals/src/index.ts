/**
 * The public entry of evals: what an app needs to run its own target through the variant runner.
 * The blinding, judge and red-team modules are used by scripts/ and are not published here.
 */
export {
  DUMP_NOW,
  dumpPrompts,
  isFailure,
  planJobs,
  preflight,
  runEval,
  systemFor,
  wordCount,
  type EvalFailure,
  type EvalRow,
  type Job,
  type RunOptions,
  type WriterTarget,
} from './runner.ts';
export { applyEdits, countMatches, VariantError, type Edit, type Variant } from './variants.ts';
export {
  anthropicModelClient,
  type CallSettings,
  type ChatMessage,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
  type ModelUsage,
  type SystemBlock,
} from './model.ts';
export { appendJsonl, freshOutput, readJsonl } from './files.ts';
export { wilson } from './aggregate.ts';
