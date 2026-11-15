// The local HTTP server without the environment: the built page from `root` with the CSP header,
// and ./api/* handed to `app`. serve.ts reads the env and listens; the tests start this on port 0.

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';

/** The largest request body handed to the app; a bigger one gets 413. */
export const BODY_LIMIT = 32 * 1024;
const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
/** The same policy csp-build-guard checks the build against (csp-guard.config.json); a test compares them. */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
// Node accepts TRACE, CONNECT and others that `new Request` throws on; they never reach the app.
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export type App = (request: Request, clientAddress: string) => Promise<Response>;

export interface StaticServerOptions {
  /** The folder with the built page. */
  readonly root: string;
  readonly app: App;
  /** The origin requests are resolved against. */
  readonly origin: string;
}

class TooLarge extends Error {}

/** The whole body, or a TooLarge rejection past BODY_LIMIT. A truncated body is never handed on. */
function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const parts: Buffer[] = [];
    let kept = 0;
    req.on('data', (c: Buffer) => {
      kept += c.byteLength;
      if (kept > BODY_LIMIT) {
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

async function api(app: App, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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

/** A server that is not listening yet: the caller picks the port. */
export function createStaticServer(options: StaticServerOptions): Server {
  const root = resolve(options.root);
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', options.origin);
    if (url.pathname.startsWith('/api/')) {
      api(options.app, req, res, url).catch((e: unknown) => {
        if (res.headersSent) return void res.end();
        const tooLarge = e instanceof TooLarge;
        res.writeHead(tooLarge ? 413 : 500, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: tooLarge ? 'too_large' : 'server_error' }));
      });
      return;
    }
    const file = normalize(resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`));
    if (!file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    readFile(file).then(
      (data) => res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP }).end(data),
      () => res.writeHead(404).end(),
    );
  });
}
