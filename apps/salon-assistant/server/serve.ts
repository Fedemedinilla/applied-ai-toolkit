// Serves the built page and the API on 127.0.0.1:8791:
//
//   npx vite build --config apps/salon-assistant/vite.config.ts
//   ASSISTANT_HISTORY_SECRET=$(openssl rand -hex 32) ANTHROPIC_API_KEY=sk-ant-... node apps/salon-assistant/server/serve.ts
//
// Without the key it still starts: /api/health and /api/assistant answer 503 and the page says
// the assistant is not available. Without a secret of at least 32 bytes it refuses to start.

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';
import { createApp } from './app.ts';
import { apiKeyFromEnv, historySecretFromEnv } from './env.ts';

const PORT = 8791;
const ROOT = resolve(import.meta.dirname, '../../../dist/apps/salon-assistant');
const LIMIT = 32 * 1024;
const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// The same policy csp-build-guard checks the build against (csp-guard.config.json).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
// Node accepts TRACE, CONNECT and others that `new Request` throws on; they never reach the app.
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const secret = historySecretFromEnv();
if (!secret) {
  process.stderr.write('Set ASSISTANT_HISTORY_SECRET to at least 32 bytes, for example: openssl rand -hex 32\n');
  process.exit(2);
}
const app = createApp({ apiKey: apiKeyFromEnv(), historySecret: secret });

class TooLarge extends Error {}

/** The whole body, or a TooLarge rejection past LIMIT. A truncated body is never handed on. */
function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const parts: Buffer[] = [];
    let kept = 0;
    req.on('data', (c: Buffer) => {
      kept += c.byteLength;
      if (kept > LIMIT) {
        req.removeAllListeners('data');
        req.resume();
        fail(new TooLarge());
        return;
      }
      parts.push(c);
    });
    req.on('end', () => done(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  if (!METHODS.has(method)) {
    res.writeHead(405, { allow: 'GET, POST' }).end();
    return;
  }
  const b = await body(req);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const r = await app(new Request(url, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: new Uint8Array(b) }) }), req.socket.remoteAddress ?? 'unknown');
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      const tooLarge = e instanceof TooLarge;
      res.writeHead(tooLarge ? 413 : 500, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: tooLarge ? 'too_large' : 'server_error' }));
    });
    return;
  }
  const file = normalize(resolve(ROOT, `.${url.pathname === '/' ? '/index.html' : url.pathname}`));
  if (!file.startsWith(ROOT + sep)) {
    res.writeHead(404).end();
    return;
  }
  readFile(file).then(
    (data) => res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP }).end(data),
    () => res.writeHead(404).end(),
  );
}).listen(PORT, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${PORT}\n`));
