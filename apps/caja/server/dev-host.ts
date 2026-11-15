// The Host check for the local dev server, kept apart from dev-server.ts because importing that
// file starts the server.
//
// The JSON-only rule in handler.ts stops other sites through CORS preflight. A page that rebinds
// its own name to 127.0.0.1 is same-origin with the dev server, so it gets no preflight and can
// read the replies, while the server holds the real key and the monthly cap. That page still
// sends its own name in Host, so only the two local names on this port are served. Vite's dev and
// preview servers check their own Host (allowedHosts) and forward with changeOrigin, which sets
// Host to 127.0.0.1:8787 (vite.config.ts).

import type { Handler } from './handler.ts';

export const DEV_PORT = 8787;

const ALLOWED = new Set([`127.0.0.1:${DEV_PORT}`, `localhost:${DEV_PORT}`]);

/** Answers 403 to any request whose Host is not 127.0.0.1 or localhost on DEV_PORT. */
export function withLocalHost(handler: Handler): Handler {
  return async (request) => {
    const host = (request.headers.get('host') ?? '').trim().toLowerCase();
    if (!ALLOWED.has(host)) {
      return new Response(JSON.stringify({ error: 'forbidden_host' }), {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return handler(request);
  };
}
