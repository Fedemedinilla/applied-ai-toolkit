// The browser's BatchRunner against a fake Worker: one worker per batch, the request posted,
// terminate on done, on error and on cancel, and nothing forwarded once the batch is over.

import { describe, expect, it } from 'vitest';
import { runBatchJob, type BatchMessage, type BatchRequest } from '../src/batch-protocol.ts';
import { workerRunner, type WorkerLike } from '../src/worker-runner.ts';

class FakeWorker implements WorkerLike {
  posted: BatchRequest[] = [];
  terminated = 0;
  private onMessage: ((event: MessageEvent<BatchMessage>) => void) | null = null;
  private onError: ((event: ErrorEvent) => void) | null = null;

  addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent<BatchMessage>) => void) | ((event: ErrorEvent) => void)): void {
    if (type === 'message') this.onMessage = listener as (event: MessageEvent<BatchMessage>) => void;
    else this.onError = listener as (event: ErrorEvent) => void;
  }
  postMessage(request: BatchRequest): void {
    this.posted.push(request);
  }
  terminate(): void {
    this.terminated += 1;
  }
  send(data: BatchMessage): void {
    this.onMessage?.({ data } as MessageEvent<BatchMessage>);
  }
  fail(message: string): void {
    this.onError?.({ message } as ErrorEvent);
  }
}

const REQUEST: BatchRequest = { runs: 100, dice: 3, seedPrefix: 'batch' };
// A real final message, from the job the worker runs.
const DONE: BatchMessage = (() => {
  const messages: BatchMessage[] = [];
  runBatchJob({ runs: 2, dice: 3, seedPrefix: 'batch' }, (m) => messages.push(m));
  const last = messages.at(-1);
  if (last?.type !== 'done') throw new Error('expected a done message');
  return last;
})();

function setup() {
  const workers: FakeWorker[] = [];
  const runner = workerRunner(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  const got: BatchMessage[] = [];
  return { workers, runner, got, onMessage: (m: BatchMessage) => got.push(m) };
}

describe('workerRunner', () => {
  it('starts a fresh worker per batch and posts the request to it', () => {
    const { workers, runner, onMessage } = setup();
    runner.start(REQUEST, onMessage);
    runner.start(REQUEST, onMessage);
    expect(workers).toHaveLength(2);
    expect(workers.map((w) => w.posted)).toEqual([[REQUEST], [REQUEST]]);
  });

  it('forwards progress, terminates on the final message and ignores anything after it', () => {
    const { workers, runner, got, onMessage } = setup();
    runner.start(REQUEST, onMessage);
    const w = workers[0] as FakeWorker;
    w.send({ type: 'progress', done: 50, total: 100 });
    expect(w.terminated).toBe(0);
    w.send(DONE);
    expect(w.terminated).toBe(1);
    w.send({ type: 'progress', done: 100, total: 100 });
    w.fail('late');
    expect(got).toEqual([{ type: 'progress', done: 50, total: 100 }, DONE]);
  });

  it('maps a worker error to an error message, with a default text when the event has none', () => {
    const { workers, runner, got, onMessage } = setup();
    runner.start(REQUEST, onMessage);
    runner.start(REQUEST, onMessage);
    (workers[0] as FakeWorker).fail('boom');
    (workers[1] as FakeWorker).fail('');
    expect(got).toEqual([
      { type: 'error', message: 'boom' },
      { type: 'error', message: 'the worker stopped' },
    ]);
    expect(workers.map((w) => w.terminated)).toEqual([1, 1]);
  });

  it('cancel terminates the worker and drops the messages it still sends', () => {
    const { workers, runner, got, onMessage } = setup();
    const cancel = runner.start(REQUEST, onMessage);
    const w = workers[0] as FakeWorker;
    cancel();
    expect(w.terminated).toBe(1);
    w.send({ type: 'progress', done: 50, total: 100 });
    w.send(DONE);
    expect(got).toEqual([]);
  });
});
