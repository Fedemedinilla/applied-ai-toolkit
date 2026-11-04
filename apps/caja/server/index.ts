// The entry a host imports: a handler built from the environment. Without a key the handler still
// answers, with model mode reported off, so a deploy without the secret degrades to the offline app.

import { apiKeyFromEnv } from './env.ts';
import { createHandler, type Handler } from './handler.ts';
import { createCajaModel } from './model.ts';

export { createHandler, type Handler, type HandlerDeps } from './handler.ts';
export { createCajaModel, type CajaModel, type ModelOptions } from './model.ts';

/**
 * One handler per process. The ledger lives in memory (gateway/src/memory-store.ts), so the cap
 * holds for as long as this process does; see Limits in the README.
 */
export function createHandlerFromEnv(env?: Readonly<Record<string, string | undefined>>): Handler {
  const apiKey = apiKeyFromEnv(env);
  const gateway = apiKey === null ? null : createCajaModel({ apiKey }).gateway;
  return createHandler({
    gateway,
    now: () => new Date(),
    log: (event, data) => console.error(JSON.stringify({ ...data, source: 'caja-server', event })),
  });
}
