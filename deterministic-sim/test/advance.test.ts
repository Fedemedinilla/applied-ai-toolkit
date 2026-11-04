import { describe, expect, it } from 'vitest';
import {
  advance,
  applyPermille,
  canApply,
  checkInput,
  comboOf,
  heatPermille,
  InvalidInputError,
  replay,
  rollSum,
  rulesFor,
  start,
  UnknownRulesetError,
  type Input,
  type LogEntry,
  type State,
} from '../src/index.ts';
import { RULES_V1 } from '../src/tournament/rules-v1.ts';
import { findSeed } from './helpers/runs.ts';

const roll = (dice: number): Input => ({ kind: 'roll', dice });
const REST: Input = { kind: 'rest' };
const lastEntry = (state: State): LogEntry => {
  const entry = state.log[state.log.length - 1];
  if (!entry) throw new Error('empty log');
  return entry;
};

describe('start', () => {
  it('opens round 0 with the ruleset chips and a house mood drawn from the seed', () => {
    const s = start('alpha');
    expect(s).toMatchObject({ rulesetVersion: 'dice-1', seed: 'alpha', status: 'active', round: 0, chips: 10, score: 0, streak: 0, busts: 0, log: [] });
    expect(['calm', 'cold', 'hot']).toContain(s.house);
    expect(start('alpha')).toEqual(s);
  });

  it('refuses an empty or overlong seed and an unknown ruleset', () => {
    expect(() => start('')).toThrow(InvalidInputError);
    expect(() => start('x'.repeat(129))).toThrow(InvalidInputError);
    expect(() => start('ok', 'dice-0')).toThrow(UnknownRulesetError);
  });
});

describe('advance', () => {
  it('a roll pays one chip per die and logs faces from 1 to 6', () => {
    const s = advance(start('alpha'), roll(4));
    const entry = lastEntry(s);
    expect(s.chips).toBe(6);
    expect(entry.dice).toHaveLength(4);
    for (const face of entry.dice) expect(face >= 1 && face <= 6).toBe(true);
    expect(s.round).toBe(1);
  });

  it('scores sum x combo x heat x house with one floor at the end, and the log carries each factor', () => {
    let s = start('formula');
    for (let i = 0; i < 6; i++) {
      s = advance(s, s.chips >= 2 ? roll(2) : REST);
      const e = lastEntry(s);
      if (e.outcome !== 'scored') continue;
      const sum = e.dice.reduce((a, b) => a + b, 0);
      expect(e.multipliers).toHaveLength(3);
      expect(e.points).toBe(applyPermille(sum, e.multipliers, 'floor'));
      expect(e.multipliers[0]).toBe(RULES_V1.combos[comboOf(e.dice)]);
      const house = RULES_V1.houses.find((h) => h.name === e.house);
      expect(e.multipliers[2]).toBe(house?.permille);
    }
  });

  it('heat grows by 100 per-mille per scoring roll in a row, up to the cap, and a rest resets it', () => {
    let s = start('heat');
    const heats: number[] = [];
    for (let i = 0; i < 7; i++) {
      s = advance(s, roll(1)); // one die never busts
      heats.push(lastEntry(s).multipliers[1] as number);
    }
    expect(heats).toEqual([1000, 1100, 1200, 1300, 1400, 1500, 1500]);
    expect(s.streak).toBe(5);
    s = advance(s, REST);
    expect(s.streak).toBe(0);
    expect(lastEntry(s)).toMatchObject({ outcome: 'rested', dice: [], combo: null, multipliers: [], points: 0 });
  });

  it('two or more ones in a roll of two or more dice is a bust: no points, streak reset, counted', () => {
    const seed = findSeed('bust', roll(5), (s) => lastEntry(s).outcome === 'bust');
    const s = advance(start(seed), roll(5));
    const entry = lastEntry(s);
    expect(entry.dice.filter((d) => d === 1).length).toBeGreaterThanOrEqual(2);
    expect(entry).toMatchObject({ outcome: 'bust', combo: null, points: 0, streak: 0 });
    expect(s.busts).toBe(1);
    expect(s.chips).toBe(5);
  });

  it('one die showing 1 is not a bust; under a calm house it scores 1 point', () => {
    const seed = findSeed('one', roll(1), (s) => lastEntry(s).dice[0] === 1 && lastEntry(s).house === 'calm');
    expect(lastEntry(advance(start(seed), roll(1)))).toMatchObject({ outcome: 'scored', combo: 'single', points: 1 });
  });

  it('a cold house can floor a small roll to 0 points, and the roll still counts for the streak', () => {
    const seed = findSeed('cold', roll(1), (s) => lastEntry(s).dice[0] === 1 && lastEntry(s).house === 'cold');
    const s = advance(start(seed), roll(1));
    expect(lastEntry(s)).toMatchObject({ outcome: 'scored', multipliers: [1000, 1000, 800], points: 0 });
    expect(s.streak).toBe(1);
  });

  it('a rest wins 4 chips, capped at 20', () => {
    let s = advance(start('rest'), REST);
    expect(s.chips).toBe(14);
    s = advance(advance(s, REST), REST);
    expect(s.chips).toBe(20);
  });

  it('refuses a roll the chips cannot pay, and leaves the state as it was', () => {
    let s = start('broke');
    s = advance(advance(s, roll(5)), roll(5));
    expect(s.chips).toBe(0);
    const before = JSON.stringify(s);
    expect(() => advance(s, roll(1))).toThrow(/costs 1 chips; there are 0/u);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('ends after 20 rounds, adds one point per chip left, and refuses further input', () => {
    const inputs: Input[] = Array.from({ length: 20 }, () => REST);
    const s = replay('end', inputs);
    expect(s.status).toBe('ended');
    expect(s.round).toBe(20);
    expect(lastEntry(s).endBonus).toBe(20);
    expect(s.score).toBe(20);
    expect(() => advance(s, REST)).toThrow(/ended/u);
  });

  it('draws the next house mood the same way whatever the input', () => {
    const s = start('independent');
    expect(advance(s, roll(5)).house).toBe(advance(s, REST).house);
  });
});

describe('checkInput', () => {
  it('accepts the two input shapes', () => {
    expect(checkInput({ kind: 'rest' }, RULES_V1)).toEqual({ kind: 'rest' });
    expect(checkInput({ dice: 3, kind: 'roll' }, RULES_V1)).toEqual({ kind: 'roll', dice: 3 });
  });

  it.each([
    [null, /object/u],
    [[], /object/u],
    [{ kind: 'jump' }, /kind/u],
    [{ kind: 'rest', note: 'x' }, /only "kind"/u],
    [{ kind: 'roll' }, /"kind" and "dice"/u],
    [{ kind: 'roll', dice: 0 }, /1 to 5/u],
    [{ kind: 'roll', dice: 6 }, /1 to 5/u],
    [{ kind: 'roll', dice: 2.5 }, /1 to 5/u],
    [{ kind: 'roll', dice: '3' }, /1 to 5/u],
    [{ kind: 'roll', dice: 2, bonus: 1 }, /"kind" and "dice"/u],
  ])('refuses %j', (value, message) => {
    expect(() => checkInput(value, RULES_V1)).toThrow(InvalidInputError);
    expect(() => checkInput(value, RULES_V1)).toThrow(message);
  });

  it('canApply agrees with advance on every one of these inputs, and on chips and the end', () => {
    const s = start('legal');
    const values: unknown[] = [null, [], { kind: 'jump' }, { kind: 'roll', dice: 2.5 }, { kind: 'roll', dice: '3' }, { kind: 'roll', dice: 0 }, { kind: 'roll', dice: 3, bonus: 1 }, roll(1), roll(5), REST];
    for (const value of values) {
      let accepted = true;
      try {
        advance(s, value as Input);
      } catch (error) {
        if (!(error instanceof InvalidInputError)) throw error;
        accepted = false;
      }
      expect(canApply(s, value)).toBe(accepted);
    }
    const poor: State = { ...s, chips: 2 };
    expect(canApply(poor, roll(2))).toBe(true);
    expect(canApply(poor, roll(3))).toBe(false);
    expect(canApply({ ...s, status: 'ended' }, REST)).toBe(false);
  });
});

describe('heatPermille and rollSum', () => {
  it('give the factors advance logs', () => {
    expect(heatPermille(RULES_V1, 0)).toBe(1000);
    expect(heatPermille(RULES_V1, 3)).toBe(1000 + 3 * RULES_V1.heatPerStreak);
    expect(rollSum([2, 5, 6])).toBe(13);
    expect(rollSum([])).toBe(0);
  });
});

describe('comboOf', () => {
  it.each([
    [[4], 'single'],
    [[1, 2], 'none'],
    [[2, 3, 4, 5, 6], 'none'],
    [[3, 3], 'pair'],
    [[5, 2, 5, 6], 'pair'],
    [[2, 2, 4, 4], 'two-pair'],
    [[6, 6, 6], 'triple'],
    [[6, 2, 6, 6, 3], 'triple'],
    [[2, 5, 2, 5, 2], 'full-house'],
    [[4, 4, 4, 4], 'four'],
    [[4, 4, 1, 4, 4], 'four'],
    [[3, 3, 3, 3, 3], 'five'],
  ] as const)('%j is %s', (dice, combo) => {
    expect(comboOf(dice)).toBe(combo);
  });
});

describe('rulesets', () => {
  it('dice-1 is frozen all the way down', () => {
    expect(Object.isFrozen(RULES_V1)).toBe(true);
    expect(Object.isFrozen(RULES_V1.combos)).toBe(true);
    expect(Object.isFrozen(RULES_V1.houses[0])).toBe(true);
    expect(() => {
      (RULES_V1.combos as Record<string, number>)['pair'] = 9000;
    }).toThrow(TypeError);
  });

  it('a state names its ruleset and advance uses that one', () => {
    expect(rulesFor(start('v').rulesetVersion)).toBe(RULES_V1);
    const forged = { ...start('v'), rulesetVersion: 'dice-9' };
    expect(() => advance(forged, REST)).toThrow(UnknownRulesetError);
  });
});
