// One run in the play tab: its seed, the inputs applied so far, and the state they replay to.
// Undo is a replay of the inputs minus the last one, which is the replay property put to work.

import { advance, inputsHash, recordOf, replay, start, stateHash, type Input, type RunRecord, type State } from '../../../deterministic-sim/src/index.ts';

export interface Session {
  readonly state: State;
  readonly inputs: readonly Input[];
}

export function newSession(seed: string): Session {
  return { state: start(seed), inputs: [] };
}

/** Throws the core's InvalidInputError for an input the state does not accept. */
export function apply(session: Session, input: Input): Session {
  return { state: advance(session.state, input), inputs: [...session.inputs, input] };
}

export function undo(session: Session): Session {
  if (session.inputs.length === 0) return session;
  const inputs = session.inputs.slice(0, -1);
  return { state: replay(session.state.seed, inputs, session.state.rulesetVersion), inputs };
}

export function fromReplay(record: RunRecord, state: State): Session {
  return { state, inputs: record.inputs };
}

/** The two hashes shown under the state: of the run record so far, and of the state itself. */
export function hashesOf(state: State): { inputs: string; state: string } {
  return { inputs: inputsHash(recordOf(state)), state: stateHash(state) };
}
