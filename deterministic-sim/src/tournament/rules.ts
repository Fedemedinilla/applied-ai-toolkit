/**
 * A ruleset is data: every number the reducer uses comes from one of these objects, and a state
 * names the version it was played under. A published version never changes, because a saved run
 * replays under the rules it names; a change to the rules is a new version next to the old one.
 * The guard hook in .claude/ blocks edits to rules-v*.ts for that reason.
 */

import type { ComboName, HouseName } from './types.ts';

export interface HouseRule {
  readonly name: HouseName;
  /** Relative weight when the house mood is drawn. */
  readonly weight: number;
  /** Multiplier on a roll's points, per-mille. */
  readonly permille: number;
}

export interface Ruleset {
  readonly version: string;
  readonly rounds: number;
  readonly startChips: number;
  readonly maxChips: number;
  readonly maxDice: number;
  readonly faces: number;
  /** Chips won by resting, up to maxChips. */
  readonly restChips: number;
  readonly maxStreak: number;
  /** Streak multiplier: 1000 + streak x this, per-mille. */
  readonly heatPerStreak: number;
  /** A roll of two or more dice with at least this many ones is a bust. */
  readonly bustOnes: number;
  /** Combination multipliers, per-mille. */
  readonly combos: Readonly<Record<ComboName, number>>;
  readonly houses: readonly HouseRule[];
  readonly pointsPerChipLeft: number;
}

/** Freezes a ruleset all the way down, so no caller can change a published version in memory. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
