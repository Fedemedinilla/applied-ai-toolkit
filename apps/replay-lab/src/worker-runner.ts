// The browser's BatchRunner, apart from main.ts so the tests can drive it with a fake Worker. One
// worker per batch: cancelling is terminate(), which stops the loop at once.

import type { BatchRunner } from './app.ts';
import type { BatchMessage, BatchRequest } from './batch-protocol.ts';

/** The part of a Worker the runner uses. */
export interface WorkerLike {
  addEventListener(type: 'message', listener: (event: MessageEvent<BatchMessage>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  postMessage(request: BatchRequest): void;
  terminate(): void;
}

export function workerRunner(create: () => WorkerLike): BatchRunner {
  return {
    start(request, onMessage) {
      const worker = create();
      let finished = false;
      const stop = (): void => {
        finished = true;
        worker.terminate();
      };
      worker.addEventListener('message', (event) => {
        if (finished) return;
        if (event.data.type !== 'progress') stop();
        onMessage(event.data);
      });
      worker.addEventListener('error', (event) => {
        if (finished) return;
        stop();
        onMessage({ type: 'error', message: event.message || 'the worker stopped' });
      });
      worker.postMessage(request);
      return stop;
    },
  };
}
