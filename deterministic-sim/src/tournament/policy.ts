import { canApply } from './advance.ts';
import type { Input, State } from './types.ts';

/** A policy picks the next input from the state alone. It draws nothing, so a batch is a function of its seeds. */
export interface Policy {
  readonly name: string;
  choose(state: State): Input;
}

/** Roll `dice` dice whenever the chips allow, otherwise rest. */
export function fixedDicePolicy(dice: number): Policy {
  if (!Number.isInteger(dice) || dice < 1) throw new RangeError(`fixedDicePolicy: dice must be a positive integer, got ${dice}`);
  const roll: Input = { kind: 'roll', dice };
  return {
    name: `roll-${dice}`,
    choose: (state) => (canApply(state, roll) ? roll : { kind: 'rest' }),
  };
}

/** The policy the batch numbers in the README are measured with. */
export const REFERENCE_POLICY: Policy = fixedDicePolicy(3);
