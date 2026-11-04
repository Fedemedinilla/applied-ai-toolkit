// Public entry of deterministic-sim. Apps import from here only.

export { CanonicalJsonError, canonicalJson, type JsonValue } from './canonical.ts';
export { applyPermille, clamp, divRound, lookup, mulDiv, PERMILLE, type Rounding } from './fixed.ts';
export { deriveState, StepRng, stepRng, uniformInt, type StepKey } from './rng.ts';
export { sha256, sha256Hex, utf8 } from './sha256.ts';
export { Xoshiro128ss, type U32Source, type XoshiroState } from './xoshiro.ts';

export {
  advance,
  canApply,
  checkInput,
  comboOf,
  heatPermille,
  InvalidInputError,
  MAX_SEED_LENGTH,
  rollSum,
  start,
  STREAMS,
  type StreamName,
} from './tournament/advance.ts';
export { fixedDicePolicy, REFERENCE_POLICY, type Policy } from './tournament/policy.ts';
export {
  InvalidRecordError,
  inputsHash,
  parseRunRecord,
  recordOf,
  replay,
  replaySteps,
  RUN_FORMAT,
  sealRun,
  stateHash,
  verifyRun,
  type RunRecord,
  type SealedRun,
  type Verification,
} from './tournament/replay.ts';
export type { HouseRule, Ruleset } from './tournament/rules.ts';
export { CURRENT_RULESET, rulesetVersions, rulesFor, UnknownRulesetError } from './tournament/rulesets.ts';
export type { ComboName, HouseName, Input, LogEntry, Outcome, State } from './tournament/types.ts';

export {
  batchSeed,
  distribution,
  MAX_RUNS,
  playOut,
  reportHash,
  runBatch,
  summarize,
  type BatchOptions,
  type BatchReport,
  type Distribution,
  type Histogram,
} from './batch.ts';
