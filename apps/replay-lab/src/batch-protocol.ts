// The messages between the page and the batch worker, and the job the worker runs. The job is a
// plain function, so the tests run it in the test process and the worker only wires it to postMessage.

import { batchSeed, fixedDicePolicy, playOut, reportHash, summarize, type BatchReport, type State } from '../../../deterministic-sim/src/index.ts';

export interface BatchRequest {
  readonly runs: number;
  readonly dice: number;
  readonly seedPrefix: string;
}

export type BatchMessage =
  | { readonly type: 'progress'; readonly done: number; readonly total: number }
  | { readonly type: 'done'; readonly report: BatchReport; readonly hash: string }
  | { readonly type: 'error'; readonly message: string };

export const MIN_RUNS = 1;
export const MAX_RUNS = 10_000;
export const PROGRESS_EVERY = 50;

/** Validates a request from the form or from a message; returns the error text when it is not one. */
export function checkRequest(value: unknown): BatchRequest | string {
  if (typeof value !== 'object' || value === null) return 'the request is not an object';
  const { runs, dice, seedPrefix } = value as Record<string, unknown>;
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < MIN_RUNS || runs > MAX_RUNS) {
    return `runs must be a whole number from ${MIN_RUNS} to ${MAX_RUNS.toLocaleString('en-US')}`;
  }
  if (typeof dice !== 'number' || !Number.isInteger(dice) || dice < 1 || dice > 5) return 'dice must be a whole number from 1 to 5';
  if (typeof seedPrefix !== 'string' || seedPrefix.length === 0 || seedPrefix.length > 64) return 'the seed prefix must be 1 to 64 characters';
  return { runs, dice, seedPrefix };
}

export function runBatchJob(request: unknown, post: (message: BatchMessage) => void): void {
  const checked = checkRequest(request);
  if (typeof checked === 'string') {
    post({ type: 'error', message: checked });
    return;
  }
  try {
    const policy = fixedDicePolicy(checked.dice);
    const finals: State[] = [];
    for (let i = 0; i < checked.runs; i++) {
      finals.push(playOut(batchSeed(checked.seedPrefix, i), policy));
      if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < checked.runs) post({ type: 'progress', done: i + 1, total: checked.runs });
    }
    const report = summarize(finals, { seedPrefix: checked.seedPrefix, policy });
    post({ type: 'done', report, hash: reportHash(report) });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : 'the batch failed' });
  }
}
