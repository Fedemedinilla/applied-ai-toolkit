import { describe, expect, it } from 'vitest';
import {
  advance,
  canonicalJson,
  InvalidRecordError,
  inputsHash,
  parseRunRecord,
  recordOf,
  replay,
  replaySteps,
  RUN_FORMAT,
  sealRun,
  start,
  stateHash,
  verifyRun,
  type Input,
  type RunRecord,
} from '../src/index.ts';

const INPUTS: Input[] = [
  { kind: 'roll', dice: 3 },
  { kind: 'roll', dice: 3 },
  { kind: 'rest' },
  { kind: 'roll', dice: 5 },
  { kind: 'roll', dice: 2 },
];
const RECORD: RunRecord = { format: RUN_FORMAT, rulesetVersion: 'dice-1', seed: 'replay', inputs: INPUTS };

describe('replay', () => {
  it('rebuilds the state that playing the inputs one by one produced', () => {
    let s = start('replay');
    for (const input of INPUTS) s = advance(s, input);
    expect(canonicalJson(replay('replay', INPUTS))).toBe(canonicalJson(s));
  });

  it('replaySteps gives the state after each prefix', () => {
    const steps = replaySteps('replay', INPUTS);
    expect(steps).toHaveLength(INPUTS.length + 1);
    steps.forEach((state, k) => expect(state).toEqual(replay('replay', INPUTS.slice(0, k))));
  });

  it('recordOf recovers seed, ruleset and inputs from a state', () => {
    expect(recordOf(replay('replay', INPUTS))).toEqual(RECORD);
  });
});

describe('hashes', () => {
  it('the inputs hash ignores key order in the record and in each input', () => {
    const reordered = parseRunRecord(
      JSON.parse('{"inputs":[{"dice":3,"kind":"roll"},{"dice":3,"kind":"roll"},{"kind":"rest"},{"dice":5,"kind":"roll"},{"dice":2,"kind":"roll"}],"seed":"replay","rulesetVersion":"dice-1","format":"dsim-run/1"}'),
    );
    expect(inputsHash(reordered)).toBe(inputsHash(RECORD));
    expect(inputsHash(RECORD)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('the inputs hash changes with the seed, the ruleset, or any input', () => {
    const base = inputsHash(RECORD);
    expect(inputsHash({ ...RECORD, seed: 'replay2' })).not.toBe(base);
    expect(inputsHash({ ...RECORD, rulesetVersion: 'dice-2' })).not.toBe(base);
    expect(inputsHash({ ...RECORD, inputs: [...INPUTS.slice(0, 4), { kind: 'roll', dice: 1 }] })).not.toBe(base);
  });

  it('the state hash covers the log: same score, different history, different hash', () => {
    const a = replay('h', [{ kind: 'rest' }, { kind: 'rest' }]);
    const b = { ...a, log: a.log.slice().reverse() };
    expect(stateHash(a)).not.toBe(stateHash(b));
    expect(stateHash(a)).toBe(stateHash(replay('h', [{ kind: 'rest' }, { kind: 'rest' }])));
  });
});

describe('parseRunRecord', () => {
  it.each([
    [null, /JSON object/u],
    [{ ...RECORD, format: 'dsim-run/0' }, /format/u],
    [{ ...RECORD, rulesetVersion: 7 }, /rulesetVersion/u],
    [{ ...RECORD, seed: '' }, /seed/u],
    [{ ...RECORD, inputs: 'roll' }, /array/u],
    [{ ...RECORD, inputs: Array.from({ length: 21 }, () => ({ kind: 'rest' })) }, /at most 20/u],
    [{ ...RECORD, inputs: [{ kind: 'roll', dice: 9 }] }, /inputs\[0\]: dice/u],
  ])('refuses %j', (value, message) => {
    expect(() => parseRunRecord(value)).toThrow(InvalidRecordError);
    expect(() => parseRunRecord(value)).toThrow(message);
  });

  it('refuses an unknown ruleset by name', () => {
    expect(() => parseRunRecord({ ...RECORD, rulesetVersion: 'dice-0' })).toThrow(/unknown ruleset "dice-0"/u);
  });
});

describe('sealRun and verifyRun', () => {
  it('a sealed run verifies, both hashes matching, through a JSON round trip', () => {
    const sealed = JSON.parse(JSON.stringify(sealRun(RECORD))) as unknown;
    const v = verifyRun(sealed);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.inputsHashMatches).toBe(true);
    expect(v.finalStateHashMatches).toBe(true);
    expect(v.state).toEqual(replay('replay', INPUTS));
  });

  it('a changed input still replays, and the stated inputs hash no longer matches', () => {
    const sealed = sealRun(RECORD);
    const tampered = { ...sealed, inputs: [...INPUTS.slice(0, 4), { kind: 'roll', dice: 1 }] };
    const v = verifyRun(tampered);
    expect(v.ok && v.inputsHashMatches).toBe(false);
    expect(v.ok && v.finalStateHashMatches).toBe(false);
  });

  it('a wrong final state hash is reported on its own', () => {
    const sealed = sealRun(RECORD);
    const v = verifyRun({ ...sealed, finalStateHash: '0'.repeat(64) });
    expect(v.ok && v.inputsHashMatches).toBe(true);
    expect(v.ok && v.finalStateHashMatches).toBe(false);
  });

  it('a file without hashes verifies with null matches, not false and not true', () => {
    const v = verifyRun(RECORD);
    expect(v.ok && v.inputsHashMatches).toBeNull();
    expect(v.ok && v.finalStateHashMatches).toBeNull();
  });

  it('an input that is illegal at its point in the run fails with the reason', () => {
    const broke = { ...RECORD, inputs: [{ kind: 'roll', dice: 5 }, { kind: 'roll', dice: 5 }, { kind: 'roll', dice: 1 }] };
    expect(verifyRun(broke)).toEqual({ ok: false, error: 'rolling 1 dice costs 1 chips; there are 0' });
  });
});
