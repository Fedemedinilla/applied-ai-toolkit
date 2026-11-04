/**
 * The example domain: a twenty-round dice tournament for one player. Each round the player either
 * rolls one to five dice, paying one chip per die, or rests to win chips back. A roll scores the sum
 * of its dice, multiplied by its combination, by the current streak and by the house mood drawn for
 * the round. Two or more ones in a roll of two or more dice is a bust: no points, streak reset.
 *
 * Everything here is plain JSON (the state is the save format) and every field is required, so the
 * canonical JSON of a state is defined and a hash of it covers every field.
 */

export type ComboName = 'single' | 'none' | 'pair' | 'two-pair' | 'triple' | 'full-house' | 'four' | 'five';

export type HouseName = 'calm' | 'cold' | 'hot';

export type Input = { readonly kind: 'roll'; readonly dice: number } | { readonly kind: 'rest' };

export type Outcome = 'scored' | 'bust' | 'rested';

export interface LogEntry {
  /** The round this entry played, from 1. */
  readonly round: number;
  readonly input: Input;
  /** The house mood in force for this round. */
  readonly house: HouseName;
  /** The faces rolled, in draw order; empty for a rest. */
  readonly dice: readonly number[];
  readonly outcome: Outcome;
  /** The combination scored; null for a bust or a rest. */
  readonly combo: ComboName | null;
  /** The multipliers applied, per-mille, in the order of the formula; empty unless scored. */
  readonly multipliers: readonly number[];
  readonly points: number;
  /** Chips and streak after the round. */
  readonly chips: number;
  readonly streak: number;
  /** Points for chips left over, added on the last round only. */
  readonly endBonus: number;
}

export interface State {
  readonly rulesetVersion: string;
  readonly seed: string;
  readonly status: 'active' | 'ended';
  /** Rounds played. It is also the index of the next input, which is what seeds that step's RNG. */
  readonly round: number;
  readonly chips: number;
  readonly score: number;
  readonly streak: number;
  readonly busts: number;
  /** The house mood for the next round. */
  readonly house: HouseName;
  readonly log: readonly LogEntry[];
}
