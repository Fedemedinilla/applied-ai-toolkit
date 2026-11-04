// The entry a host imports: a handler built from the environment and the config files. Without a
// key the handler still answers, with the service reported off, so a deploy without the secret
// serves the page and says the writer is unavailable.

import { loadConfig } from './config.ts';
import { apiKeyFromEnv } from './env.ts';
import { createHandler, type Handler } from './handler.ts';
import { createWriterModel } from './model.ts';

export { createHandler, type Handler, type HandlerDeps } from './handler.ts';
export { createWriterModel, type ModelOptions, type WriterModel } from './model.ts';

/**
 * One handler per process. The config is validated here, so a broken file stops the process at
 * start. The ledger lives in memory, so the cap holds for as long as this process does.
 */
export function createHandlerFromEnv(env?: Readonly<Record<string, string | undefined>>): Handler {
  const config = loadConfig();
  const apiKey = apiKeyFromEnv(env);
  const gateway = apiKey === null ? null : createWriterModel({ apiKey }).gateway;
  return createHandler({
    config,
    gateway,
    now: () => new Date(),
    log: (event, data) => console.error(JSON.stringify({ ...data, source: 'writer-server', event })),
  });
}
