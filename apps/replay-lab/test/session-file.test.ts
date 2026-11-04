import { describe, expect, it } from 'vitest';
import { replay, stateHash, type Input } from '../../../deterministic-sim/src/index.ts';
import { exportRun, importRun, MAX_FILE_BYTES, slug } from '../src/run-file.ts';
import { apply, hashesOf, newSession, undo } from '../src/session.ts';

const INPUTS: Input[] = [{ kind: 'roll', dice: 3 }, { kind: 'rest' }, { kind: 'roll', dice: 5 }];

function played() {
  let s = newSession('lab-1');
  for (const input of INPUTS) s = apply(s, input);
  return s;
}

describe('session', () => {
  it('applies inputs through the core and keeps them in order', () => {
    const s = played();
    expect(s.inputs).toEqual(INPUTS);
    expect(s.state).toEqual(replay('lab-1', INPUTS));
  });

  it('undo replays the inputs minus the last one from the seed', () => {
    const s = undo(played());
    expect(s.inputs).toEqual(INPUTS.slice(0, 2));
    expect(stateHash(s.state)).toBe(stateHash(replay('lab-1', INPUTS.slice(0, 2))));
    const fresh = newSession('lab-1');
    expect(undo(fresh)).toBe(fresh);
  });

  it('shows both hashes as 64 hex digits', () => {
    const { inputs, state } = hashesOf(played().state);
    expect(inputs).toMatch(/^[0-9a-f]{64}$/u);
    expect(state).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('run file', () => {
  it('exports the sealed record, named after the seed and the inputs hash', () => {
    const file = exportRun(played().state);
    const parsed = JSON.parse(file.text) as Record<string, unknown>;
    expect(file.fileName).toBe(`run-lab-1-${String(parsed['inputsHash']).slice(0, 8)}.json`);
    expect(parsed).toMatchObject({ format: 'dsim-run/1', rulesetVersion: 'dice-1', seed: 'lab-1', inputs: INPUTS });
    expect(file.text.endsWith('\n')).toBe(true);
  });

  it('a round trip verifies with both hashes matching', () => {
    const file = exportRun(played().state);
    const v = importRun(file.text, file.text.length);
    expect(v.ok && v.inputsHashMatches && v.finalStateHashMatches).toBe(true);
  });

  it('an edited input is caught by the inputs hash', () => {
    const file = exportRun(played().state);
    const edited = file.text.replace('"dice": 5', '"dice": 4');
    expect(edited).not.toBe(file.text);
    const v = importRun(edited, edited.length);
    expect(v.ok && v.inputsHashMatches).toBe(false);
  });

  it('refuses a file that is not JSON, or too large to be a run', () => {
    expect(importRun('{not json', 9)).toEqual({ ok: false, error: 'the file is not JSON' });
    expect(importRun('{}', MAX_FILE_BYTES + 1).ok).toBe(false);
  });

  it('slug keeps letters and digits', () => {
    expect(slug('Hello, World! 42')).toBe('hello-world-42');
    expect(slug('\u{1f3b2}\u{1f3b2}')).toBe('run');
    expect(slug('Señal')).toBe('senal');
    expect(slug('x'.repeat(40))).toHaveLength(24);
  });
});
