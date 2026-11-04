/**
 * The reducer. advance(state, input) returns the next state and never changes its arguments. The
 * RNG for a step is derived from the seed and the step index (state.round), so the state carries no
 * generator internals: a state is plain JSON, and any state can be advanced without the ones before it.
 */

import { applyPermille, clamp, PERMILLE } from '../fixed.ts';
import { stepRng, type StepRng } from '../rng.ts';
import type { HouseRule, Ruleset } from './rules.ts';
import { CURRENT_RULESET, rulesFor } from './rulesets.ts';
import type { ComboName, HouseName, Input, LogEntry, State } from './types.ts';

/** The streams of this domain. Dice and house draws never share a generator. */
export const STREAMS = ['dice', 'house'] as const;
export type StreamName = (typeof STREAMS)[number];

export const MAX_SEED_LENGTH = 128;

/** An input that the current state does not accept. The state is unchanged. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows an unknown value to an Input this ruleset accepts, or throws. Extra keys are refused:
 * they would change the input hash without changing the run, so two hashes would name one game.
 */
export function checkInput(value: unknown, rules: Ruleset): Input {
  if (!isRecord(value)) throw new InvalidInputError('an input must be an object');
  const keys = Object.keys(value).sort().join(',');
  if (value['kind'] === 'rest') {
    if (keys !== 'kind') throw new InvalidInputError(`a rest input has only "kind", got ${keys}`);
    return { kind: 'rest' };
  }
  if (value['kind'] === 'roll') {
    if (keys !== 'dice,kind') throw new InvalidInputError(`a roll input has "kind" and "dice", got ${keys}`);
    const dice = value['dice'];
    if (typeof dice !== 'number' || !Number.isInteger(dice) || dice < 1 || dice > rules.maxDice) {
      throw new InvalidInputError(`dice must be an integer from 1 to ${rules.maxDice}`);
    }
    return { kind: 'roll', dice };
  }
  throw new InvalidInputError('kind must be "roll" or "rest"');
}

function houseRule(rules: Ruleset, name: HouseName): HouseRule {
  const rule = rules.houses.find((h) => h.name === name);
  if (!rule) throw new RangeError(`ruleset ${rules.version} has no house "${name}"`);
  return rule;
}

function drawHouse(rng: StepRng<StreamName>, rules: Ruleset): HouseName {
  const index = rng.pickWeighted(
    'house',
    rules.houses.map((h) => h.weight),
  );
  const rule = rules.houses[index];
  if (!rule) throw new RangeError(`house index ${index} out of range`);
  return rule.name;
}

/**
 * The combination of a roll, from the sizes of its groups of equal faces, largest first: "3+2" is a
 * full house, "2+2+1" two pairs.
 */
export function comboOf(dice: readonly number[]): ComboName {
  if (dice.length === 0) throw new RangeError('comboOf: no dice');
  if (dice.length === 1) return 'single';
  const sorted = [...dice].sort((a, b) => a - b);
  const sizes: number[] = [];
  let run = 1;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] === sorted[i - 1]) run += 1;
    else {
      sizes.push(run);
      run = 1;
    }
  }
  const shape = sizes.sort((a, b) => b - a).join('+');
  if (shape === '5') return 'five';
  if (shape.startsWith('4')) return 'four';
  if (shape === '3+2') return 'full-house';
  if (shape.startsWith('3')) return 'triple';
  if (shape.startsWith('2+2')) return 'two-pair';
  if (shape.startsWith('2')) return 'pair';
  return 'none';
}

/** The sum of the faces of a roll, the base the multipliers apply to. */
export function rollSum(dice: readonly number[]): number {
  return dice.reduce((total, face) => total + face, 0);
}

/** The streak multiplier, per-mille, for a roll made with `streak` scoring rolls before it. */
export function heatPermille(rules: Ruleset, streak: number): number {
  return PERMILLE + streak * rules.heatPerStreak;
}

/** Rounds played before the first input: none. The first house mood is drawn under the step "start". */
export function start(seed: string, rulesetVersion: string = CURRENT_RULESET): State {
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > MAX_SEED_LENGTH) {
    throw new InvalidInputError(`the seed must be a string of 1 to ${MAX_SEED_LENGTH} characters`);
  }
  const rules = rulesFor(rulesetVersion);
  const rng = stepRng(seed, 'start', STREAMS);
  return {
    rulesetVersion: rules.version,
    seed,
    status: 'active',
    round: 0,
    chips: rules.startChips,
    score: 0,
    streak: 0,
    busts: 0,
    house: drawHouse(rng, rules),
    log: [],
  };
}

/**
 * Whether `input` is legal now, without throwing: exactly when `advance` would accept it. The app
 * uses it to disable buttons.
 */
export function canApply(state: State, input: unknown): boolean {
  if (state.status !== 'active') return false;
  try {
    const checked = checkInput(input, rulesFor(state.rulesetVersion));
    return checked.kind === 'rest' || checked.dice <= state.chips;
  } catch (error) {
    if (error instanceof InvalidInputError) return false;
    throw error;
  }
}

export function advance(state: State, rawInput: Input): State {
  const rules = rulesFor(state.rulesetVersion);
  if (state.status === 'ended') throw new InvalidInputError('the tournament has ended');
  const input = checkInput(rawInput, rules);
  const rng = stepRng(state.seed, state.round, STREAMS);
  const house = houseRule(rules, state.house);

  let chips = state.chips;
  let streak = state.streak;
  let busts = state.busts;
  const dice: number[] = [];
  let outcome: LogEntry['outcome'];
  let combo: ComboName | null = null;
  let multipliers: number[] = [];
  let points = 0;

  if (input.kind === 'roll') {
    if (input.dice > chips) throw new InvalidInputError(`rolling ${input.dice} dice costs ${input.dice} chips; there are ${chips}`);
    chips -= input.dice;
    for (let i = 0; i < input.dice; i++) dice.push(rng.range('dice', 1, rules.faces));
    const ones = dice.filter((face) => face === 1).length;
    if (dice.length >= 2 && ones >= rules.bustOnes) {
      outcome = 'bust';
      streak = 0;
      busts += 1;
    } else {
      outcome = 'scored';
      combo = comboOf(dice);
      const sum = rollSum(dice);
      multipliers = [rules.combos[combo], heatPermille(rules, streak), house.permille];
      // One rounding, at the end: sum x combo x heat x house / 1000^3, floored.
      points = applyPermille(sum, multipliers, 'floor');
      streak = clamp(streak + 1, 0, rules.maxStreak);
    }
  } else {
    outcome = 'rested';
    chips = clamp(chips + rules.restChips, 0, rules.maxChips);
    streak = 0;
  }

  const round = state.round + 1;
  const ended = round === rules.rounds;
  const endBonus = ended ? chips * rules.pointsPerChipLeft : 0;
  // Drawn on every step, the last included, so the number of house draws never depends on the input.
  const nextHouse = drawHouse(rng, rules);

  const entry: LogEntry = {
    round,
    input,
    house: state.house,
    dice,
    outcome,
    combo,
    multipliers,
    points,
    chips,
    streak,
    endBonus,
  };
  return {
    rulesetVersion: state.rulesetVersion,
    seed: state.seed,
    status: ended ? 'ended' : 'active',
    round,
    chips,
    score: state.score + points + endBonus,
    streak,
    busts,
    house: nextHouse,
    // A new array; the entries before it are shared, never copied or changed.
    log: [...state.log, entry],
  };
}
