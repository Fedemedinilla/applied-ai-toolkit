// A small node:http wrapper around the handler, for running the writer locally:
//
//   ANTHROPIC_API_KEY=sk-ant-... node apps/writer/server/dev-server.ts
//   npx vite --config apps/writer/vite.config.ts    # proxies /api to this server
//
// Without the key it still starts, and /api/health answers 503, so the page says the writer is
// unavailable. It listens on 127.0.0.1 only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MAX_BODY_BYTES } from './handler.ts';
import { createHandlerFromEnv } from './index.ts';

export const DEV_PORT = 8788;
const handler = createHandlerFromEnv();

async function toRequest(req: IncomingMessage): Promise<Request> {
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
  return new Request(new URL(req.url ?? '/', `http://127.0.0.1:${DEV_PORT}`), init);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer((req, res) => {
  toRequest(req)
    .then(handler)
    .then((response) => send(res, response))
    .catch(() => {
      res.statusCode = 500;
      res.end();
    });
}).listen(DEV_PORT, '127.0.0.1', () => {
  console.log(`writer on http://127.0.0.1:${DEV_PORT}/api/health`);
});
