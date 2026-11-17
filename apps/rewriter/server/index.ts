// The entry a host imports: a handler built from the environment and style-refs' data. Without a
// key the handler still answers, with the service reported off, so the page falls back to its
// recorded examples.

import { apiKeyFromEnv } from './env.ts';
import { createHandler, type Handler } from './handler.ts';
import { createRewriterModel } from './model.ts';
import { loadRefs } from './refs.ts';

export { createHandler, type Handler, type HandlerDeps } from './handler.ts';
export { createRewriterModel, type ModelOptions, type RewriterModel } from './model.ts';

/**
 * One handler per process. style-refs' data is read and checked here, so a broken file stops the
 * process at start. The ledger lives in memory, so the caps hold for as long as this process does.
 */
export function createHandlerFromEnv(env?: Readonly<Record<string, string | undefined>>): Handler {
  const refs = loadRefs();
  const apiKey = apiKeyFromEnv(env);
  const gateway = apiKey === null ? null : createRewriterModel({ apiKey }).gateway;
  return createHandler({
    gateway,
    refs,
    log: (event, data) => console.error(JSON.stringify({ ...data, source: 'rewriter-server', event })),
  });
}
