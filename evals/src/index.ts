/**
 * The public entry of evals: what an app needs to run its own target through the variant runner,
 * score the outputs with a rubric, gate a candidate run against a baseline and render the report.
 * It also publishes blinding, the line-by-line groundedness judge with its line rule, and the
 * red-team runner, so a library that judges or attacks its own output uses these instead of a copy
 * that drifts from them. Aggregation (unblinding and the results table) stays with scripts/.
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
export {
  JudgeError,
  judgeWith,
  RubricError,
  rubricRequest,
  type BlindContent,
  type CodeRubric,
  type Judged,
  type JudgeRubric,
  type Outcome,
  type Rubric,
  type Table,
} from './rubric.ts';
export { checkLineCoverage, groundedness, judgePiece, LineSupport, type JudgedPiece, type Verdict } from './judge.ts';
export { blind, type BlindKey, type BlindPiece, type KeyEntry, type Withheld } from './blind.ts';
export {
  Attack,
  parseAttacks,
  runAttacks,
  type AttackRecord,
  type ChatHandler,
  type ChatRequest,
  type ChatResponse,
  type HistoryMessage,
  type Outcome as AttackOutcome,
  type TurnRecord,
} from './redteam.ts';
export { classification, classificationReport, type ClassificationOptions, type ClassificationReport, type ClassificationVerdict } from './classification.ts';
export { extraction, extractionReport, type ExtractionReport, type ExtractionVerdict } from './extraction.ts';
export { judgedRuns, parseRun, RUN_FORMAT, RunError, scoreItems, summarize, type RunResult, type RunSummary, type StoredRun } from './run.ts';
export { decide, DEFAULT_MARGIN, differenceInterval, gate, GATE_EXIT, gateMarkdown, GateRefusal, gateText, type GateOptions, type GateResult, type GateState } from './gate.ts';
export { renderComparisonReport, renderRunReport } from './report.ts';
