import { canApply } from './advance.ts';
import { CURRENT_RULESET, rulesFor } from './rulesets.ts';
import type { Input, State } from './types.ts';

/** A policy picks the next input from the state alone. It draws nothing, so a batch is a function of its seeds. */
export interface Policy {
  readonly name: string;
  choose(state: State): Input;
}

/**
 * Roll `dice` dice whenever the chips allow, otherwise rest. The count is checked against the
 * ruleset's maximum: a roll the rules never accept would make the policy rest every round under a
 * name that says it rolls.
 */
export function fixedDicePolicy(dice: number, rulesetVersion: string = CURRENT_RULESET): Policy {
  const { maxDice } = rulesFor(rulesetVersion);
  if (!Number.isInteger(dice) || dice < 1 || dice > maxDice) {
    throw new RangeError(`fixedDicePolicy: dice must be an integer from 1 to ${maxDice} under ${rulesetVersion}, got ${dice}`);
  }
  const roll: Input = { kind: 'roll', dice };
  return {
    name: `roll-${dice}`,
    choose: (state) => (canApply(state, roll) ? roll : { kind: 'rest' }),
  };
}

/** The policy the batch numbers in the README are measured with. */
export const REFERENCE_POLICY: Policy = fixedDicePolicy(3);
