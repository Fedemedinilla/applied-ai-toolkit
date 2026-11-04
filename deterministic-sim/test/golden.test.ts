// Saved runs must keep replaying to the same state. test/golden/ is protected by the guard hook,
// so an agent cannot make this pass by regenerating the file.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyRun } from '../src/index.ts';

const file = JSON.parse(readFileSync(new URL('./golden/runs.json', import.meta.url), 'utf8')) as {
  runs: Array<{ name: string } & Record<string, unknown>>;
};

describe('golden runs (ruleset dice-1)', () => {
  it('there are six of them', () => {
    expect(file.runs).toHaveLength(6);
  });

  it.each(file.runs.map((run) => [run.name, run] as const))('%s replays to its sealed hashes', (_name, run) => {
    const v = verifyRun(run);
    if (!v.ok) throw new Error(v.error);
    expect(v.inputsHash).toBe(run['inputsHash']);
    expect(v.finalStateHash).toBe(run['finalStateHash']);
  });
});
