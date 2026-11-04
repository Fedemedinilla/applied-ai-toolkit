/**
 * A run is its seed, its ruleset version and its inputs. Replaying them rebuilds the exact state,
 * so that triple is the save format, the replay file and the check that a reported result is real.
 */

import { canonicalJson } from '../canonical.ts';
import { sha256Hex } from '../sha256.ts';
import { advance, checkInput, InvalidInputError, MAX_SEED_LENGTH, start } from './advance.ts';
import { rulesFor } from './rulesets.ts';
import type { Input, State } from './types.ts';

export const RUN_FORMAT = 'dsim-run/1';

export interface RunRecord {
  readonly format: typeof RUN_FORMAT;
  readonly rulesetVersion: string;
  readonly seed: string;
  readonly inputs: readonly Input[];
}

/** A record with the two hashes a reader can check it against. This is what the app exports. */
export interface SealedRun extends RunRecord {
  readonly inputsHash: string;
  readonly finalStateHash: string;
}

export class InvalidRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecordError';
  }
}

export function replay(seed: string, inputs: readonly Input[], rulesetVersion?: string): State {
  let state = start(seed, rulesetVersion);
  for (const input of inputs) state = advance(state, input);
  return state;
}

/** Every state of a run, from the start to the last input: replaySteps(...)[k] is the state after k inputs. */
export function replaySteps(seed: string, inputs: readonly Input[], rulesetVersion?: string): State[] {
  const states = [start(seed, rulesetVersion)];
  for (const input of inputs) {
    const last = states[states.length - 1] as State;
    states.push(advance(last, input));
  }
  return states;
}

export function recordOf(state: State): RunRecord {
  return { format: RUN_FORMAT, rulesetVersion: state.rulesetVersion, seed: state.seed, inputs: state.log.map((e) => e.input) };
}

/** SHA-256 of the canonical JSON of the record: the same run gives the same hash whatever its key order. */
export function inputsHash(record: RunRecord): string {
  return sha256Hex(canonicalJson({ format: record.format, rulesetVersion: record.rulesetVersion, seed: record.seed, inputs: record.inputs }));
}

/** SHA-256 of the canonical JSON of a state, log included. Two engines agree on a run when this agrees. */
export function stateHash(state: State): string {
  return sha256Hex(canonicalJson(state));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an untrusted value (a parsed file) as a run record. Only the shape is checked here;
 * whether each input is legal at its point in the run is up to the replay.
 */
export function parseRunRecord(value: unknown): RunRecord {
  if (!isRecord(value)) throw new InvalidRecordError('a run record must be a JSON object');
  if (value['format'] !== RUN_FORMAT) throw new InvalidRecordError(`format must be "${RUN_FORMAT}"`);
  const version = value['rulesetVersion'];
  if (typeof version !== 'string') throw new InvalidRecordError('rulesetVersion must be a string');
  const rules = rulesFor(version);
  const seed = value['seed'];
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > MAX_SEED_LENGTH) {
    throw new InvalidRecordError(`seed must be a string of 1 to ${MAX_SEED_LENGTH} characters`);
  }
  const raw = value['inputs'];
  if (!Array.isArray(raw)) throw new InvalidRecordError('inputs must be an array');
  if (raw.length > rules.rounds) throw new InvalidRecordError(`a run has at most ${rules.rounds} inputs, got ${raw.length}`);
  const inputs = raw.map((input: unknown, i) => {
    try {
      return checkInput(input, rules);
    } catch (error) {
      if (error instanceof InvalidInputError) throw new InvalidRecordError(`inputs[${i}]: ${error.message}`);
      throw error;
    }
  });
  return { format: RUN_FORMAT, rulesetVersion: version, seed, inputs };
}

export function sealRun(record: RunRecord): SealedRun {
  return { ...record, inputsHash: inputsHash(record), finalStateHash: stateHash(replay(record.seed, record.inputs, record.rulesetVersion)) };
}

export type Verification =
  | {
      readonly ok: true;
      readonly record: RunRecord;
      readonly state: State;
      /** Recomputed from the record. */
      readonly inputsHash: string;
      readonly finalStateHash: string;
      /** Whether the hashes stated in the file match; null when the file states none. */
      readonly inputsHashMatches: boolean | null;
      readonly finalStateHashMatches: boolean | null;
    }
  | { readonly ok: false; readonly error: string };

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * Parses, replays and compares. A changed input shows as an inputs hash mismatch; a run that replays
 * to a different state (other rules, an engine that drifted) shows as a final state hash mismatch.
 */
export function verifyRun(value: unknown): Verification {
  let record: RunRecord;
  let state: State;
  try {
    record = parseRunRecord(value);
    state = replay(record.seed, record.inputs, record.rulesetVersion);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'the run could not be replayed' };
  }
  const stated = isRecord(value) ? value : {};
  const statedHash = (key: string): string | null => {
    const v = stated[key];
    return typeof v === 'string' && HEX64.test(v) ? v : null;
  };
  const inputs = inputsHash(record);
  const final = stateHash(state);
  const statedInputs = statedHash('inputsHash');
  const statedFinal = statedHash('finalStateHash');
  return {
    ok: true,
    record,
    state,
    inputsHash: inputs,
    finalStateHash: final,
    inputsHashMatches: statedInputs === null ? null : statedInputs === inputs,
    finalStateHashMatches: statedFinal === null ? null : statedFinal === final,
  };
}
