// A tiny node:http wrapper around the handler, for running model mode locally:
//
//   ANTHROPIC_API_KEY=sk-ant-... node apps/caja/server/dev-server.ts
//   npx vite apps/caja        # Vite's dev and preview servers proxy /api here (vite.config.ts)
//
// Without the key it still starts, and /api/health answers 503, so the toggle stays hidden.
// It listens on 127.0.0.1 only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MAX_BODY_BYTES } from './handler.ts';
import { createHandlerFromEnv } from './index.ts';

export const DEV_PORT = 8787;
const handler = createHandlerFromEnv();

/**
 * Keeps at most one byte past the handler's limit and drops the rest as it arrives, so a large
 * body is never held in memory; the handler then refuses it. The stream is drained, not destroyed,
 * so the 400 still reaches the client.
 */
function collect(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    req.on('data', (chunk: Buffer) => {
      if (kept > MAX_BODY_BYTES) return;
      const part = chunk.subarray(0, MAX_BODY_BYTES + 1 - kept);
      chunks.push(part);
      kept += part.byteLength;
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const body = await collect(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = new Uint8Array(body);
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
  console.log(`caja model mode on http://127.0.0.1:${DEV_PORT}/api/health`);
});
