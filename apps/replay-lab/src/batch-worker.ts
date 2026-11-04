// The Web Worker: one batch per message, played off the main thread so the page keeps answering
// while 1,000 runs replay. The job itself is runBatchJob, tested without a worker.

import { runBatchJob, type BatchMessage } from './batch-protocol.ts';

interface WorkerScope {
  postMessage(message: BatchMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

// The shared tsconfig has the DOM lib and not WebWorker, so `self` is typed as a Window here. A type
// guard narrows it once instead of a double cast, and a page that loaded this file by mistake throws.
function isWorkerScope(scope: unknown): scope is WorkerScope {
  return typeof scope === 'object' && scope !== null && 'postMessage' in scope && 'addEventListener' in scope && !('document' in scope);
}

const scope: unknown = self;
if (!isWorkerScope(scope)) throw new Error('batch-worker.ts runs only as a Web Worker');
const worker = scope;
worker.addEventListener('message', (event) => runBatchJob(event.data, (message) => worker.postMessage(message)));
