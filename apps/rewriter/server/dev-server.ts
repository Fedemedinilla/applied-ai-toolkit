// A small node:http wrapper around the handler, for running the rewriter on your own machine:
//
//   ANTHROPIC_API_KEY=sk-ant-... node apps/rewriter/server/dev-server.ts
//   npx vite --config apps/rewriter/vite.config.ts    # proxies /api to this server
//
// Without the key it still starts, and /api/health answers 503, so the page shows its recorded
// examples. It listens on 127.0.0.1 only, and answers only requests addressed to 127.0.0.1 or
// localhost on its own port: a page on another name that resolves to 127.0.0.1 (DNS rebinding)
// gets a 403. Vite's proxy rewrites the Host header to this server's, so the page still works.
// rewrite() takes no abort signal, so a client that disconnects does not stop the calls in flight;
// the caps still bound them.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_BODY_BYTES } from '../src/protocol.ts';
import type { Handler } from './handler.ts';
import { createHandlerFromEnv } from './index.ts';

export const DEV_PORT = 8789;

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  // Keeps at most one chunk past the limit, so the handler sees an oversized body and refuses it
  // while memory stays bounded; the rest is read and dropped.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (size > MAX_BODY_BYTES) continue;
    size += (chunk as Buffer).byteLength;
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = Buffer.concat(chunks);
  return new Request(new URL(req.url ?? '/', `http://127.0.0.1:${port}`), init);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The server, not yet listening. The Host check uses the port it ends up listening on. */
export function createDevServer(handler: Handler): Server {
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : DEV_PORT;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      req.resume();
      res.statusCode = 403;
      res.end();
      return;
    }
    toRequest(req, port)
      .then(handler)
      .then((response) => send(res, response))
      .catch(() => {
        if (res.writableEnded || res.destroyed) return;
        res.statusCode = 500;
        res.end();
      });
  });
  return server;
}

if (import.meta.main) {
  createDevServer(createHandlerFromEnv()).listen(DEV_PORT, '127.0.0.1', () => {
    console.log(`rewriter on http://127.0.0.1:${DEV_PORT}/api/health`);
  });
}
