import { describe, expect, it } from 'vitest';
import { fixedDicePolicy, reportHash, runBatch } from '../../../deterministic-sim/src/index.ts';
import { checkRequest, runBatchJob, type BatchMessage } from '../src/batch-protocol.ts';

function collect(request: unknown): BatchMessage[] {
  const messages: BatchMessage[] = [];
  runBatchJob(request, (m) => messages.push(m));
  return messages;
}

describe('batch job', () => {
  it('posts progress every 50 runs, then one report equal to the library batch', () => {
    const messages = collect({ runs: 200, dice: 3, seedPrefix: 'w' });
    expect(messages.filter((m) => m.type === 'progress').map((m) => (m.type === 'progress' ? m.done : 0))).toEqual([50, 100, 150]);
    const done = messages[messages.length - 1];
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') return;
    const expected = runBatch({ runs: 200, seedPrefix: 'w', policy: fixedDicePolicy(3) });
    expect(done.report).toEqual(expected);
    expect(done.hash).toBe(reportHash(expected));
  });

  it('answers a bad request with one error message and no runs', () => {
    expect(collect({ runs: 0, dice: 3, seedPrefix: 'w' })).toEqual([{ type: 'error', message: 'runs must be a whole number from 1 to 10,000' }]);
    expect(collect(null)).toEqual([{ type: 'error', message: 'the request is not an object' }]);
  });

  it.each([
    [{ runs: 10_001, dice: 3, seedPrefix: 'p' }, /runs/u],
    [{ runs: 1.5, dice: 3, seedPrefix: 'p' }, /runs/u],
    [{ runs: Number.NaN, dice: 3, seedPrefix: 'p' }, /runs/u],
    [{ runs: 10, dice: 6, seedPrefix: 'p' }, /dice/u],
    [{ runs: 10, dice: 3, seedPrefix: '' }, /prefix/u],
    [{ runs: 10, dice: 3, seedPrefix: 'p'.repeat(65) }, /prefix/u],
  ])('checkRequest refuses %j', (value, message) => {
    expect(checkRequest(value)).toMatch(message);
  });
});
