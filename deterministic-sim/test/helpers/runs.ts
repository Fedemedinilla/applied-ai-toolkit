import fc from 'fast-check';
import { advance, canApply, start, type Input, type State } from '../../src/index.ts';

/** What a player tries to do; legalize() turns an unaffordable roll into a rest. */
export const intent: fc.Arbitrary<Input> = fc.oneof(
  fc.record({ kind: fc.constant('roll' as const), dice: fc.integer({ min: 1, max: 5 }) }),
  fc.constant({ kind: 'rest' as const }),
);

export const seed = fc.string({ minLength: 1, maxLength: 24 });

export const intents = fc.array(intent, { maxLength: 20 });

export function legalize(state: State, wanted: Input): Input {
  return canApply(state, wanted) ? wanted : { kind: 'rest' };
}

/** Plays the intents from the start, returning every state and the inputs actually applied. */
export function play(seedText: string, wanted: readonly Input[]): { states: State[]; inputs: Input[] } {
  const states = [start(seedText)];
  const inputs: Input[] = [];
  for (const w of wanted) {
    const last = states[states.length - 1] as State;
    if (last.status === 'ended') break;
    const input = legalize(last, w);
    inputs.push(input);
    states.push(advance(last, input));
  }
  return { states, inputs };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Searches seeds "<prefix>-0", "<prefix>-1", ... for one whose first input gives the wanted log entry. */
export function findSeed(prefix: string, input: Input, wanted: (state: State) => boolean): string {
  for (let i = 0; i < 10_000; i++) {
    const s = `${prefix}-${i}`;
    if (wanted(advance(start(s), input))) return s;
  }
  throw new Error(`no seed found for ${prefix}`);
}
