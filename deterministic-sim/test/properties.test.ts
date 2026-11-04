// Property tests over random seeds and random play. Each property runs on 200 generated runs of up
// to 20 inputs; fast-check shrinks any failure to a minimal seed and input list.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advance, canonicalJson, replay, replaySteps, stateHash, type State } from '../src/index.ts';
import { RULES_V1 } from '../src/tournament/rules-v1.ts';
import { deepFreeze, intent, intents, legalize, play, seed } from './helpers/runs.ts';

const RUNS = { numRuns: 200 };

describe('properties', () => {
  it('replay is byte-identical to the play that produced it, and to itself', () => {
    fc.assert(
      fc.property(seed, intents, (s, wanted) => {
        const { states, inputs } = play(s, wanted);
        const played = canonicalJson(states[states.length - 1]);
        expect(canonicalJson(replay(s, inputs))).toBe(played);
        expect(canonicalJson(replay(s, inputs))).toBe(played);
        expect(stateHash(replay(s, inputs))).toBe(stateHash(states[states.length - 1] as State));
      }),
      RUNS,
    );
  });

  it('every prefix of a replay is the state at that point of the play', () => {
    fc.assert(
      fc.property(seed, intents, (s, wanted) => {
        const { states, inputs } = play(s, wanted);
        expect(replaySteps(s, inputs).map(canonicalJson)).toEqual(states.map(canonicalJson));
      }),
      RUNS,
    );
  });

  it('advance never writes to its arguments (they are deep-frozen, so a write would throw)', () => {
    fc.assert(
      fc.property(seed, intents, intent, (s, wanted, next) => {
        const { states } = play(s, wanted);
        const last = deepFreeze(states[states.length - 1] as State);
        if (last.status === 'ended') return;
        const input = deepFreeze(legalize(last, next));
        const before = canonicalJson(last);
        advance(last, input);
        expect(canonicalJson(last)).toBe(before);
      }),
      RUNS,
    );
  });

  it('chips, streak, rounds and score stay in bounds after every step', () => {
    fc.assert(
      fc.property(seed, intents, (s, wanted) => {
        for (const state of play(s, wanted).states) {
          expect(state.chips >= 0 && state.chips <= RULES_V1.maxChips).toBe(true);
          expect(state.streak >= 0 && state.streak <= RULES_V1.maxStreak).toBe(true);
          expect(state.round >= 0 && state.round <= RULES_V1.rounds).toBe(true);
          expect(state.busts <= state.round).toBe(true);
          expect(Number.isSafeInteger(state.score) && state.score >= 0).toBe(true);
          expect(state.log).toHaveLength(state.round);
          expect(state.status === 'ended').toBe(state.round === RULES_V1.rounds);
        }
      }),
      RUNS,
    );
  });

  it('the score is the sum of the logged points and end bonus', () => {
    fc.assert(
      fc.property(seed, intents, (s, wanted) => {
        const { states } = play(s, wanted);
        const last = states[states.length - 1] as State;
        expect(last.log.reduce((sum, e) => sum + e.points + e.endBonus, 0)).toBe(last.score);
      }),
      RUNS,
    );
  });

  it('streams are independent: the next house mood never depends on how many dice were rolled', () => {
    fc.assert(
      fc.property(seed, intents, fc.integer({ min: 1, max: 5 }), (s, wanted, dice) => {
        const { states } = play(s, wanted);
        const last = states[states.length - 1] as State;
        if (last.status === 'ended' || last.chips < dice) return;
        expect(advance(last, { kind: 'roll', dice }).house).toBe(advance(last, { kind: 'rest' }).house);
      }),
      RUNS,
    );
  });
});
