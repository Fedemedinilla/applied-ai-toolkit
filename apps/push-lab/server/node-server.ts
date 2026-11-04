// node:http around the handler: /api/* goes to it, everything else is a file from the build.
// Used by server/serve.ts and by the tests; a host with a Fetch API runtime can call the handler
// directly and serve the build as static files instead.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** The policy the build is checked against (csp-guard.config.json), sent with every file. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/**
 * The file for a URL path inside `dir`, or null. The path is decoded and normalized first, and
 * anything that resolves outside `dir` (`..`, an encoded slash) is refused.
 */
export function resolveStatic(dir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const root = normalize(dir.endsWith(sep) ? dir : dir + sep);
  const full = normalize(join(root, relative));
  return full.startsWith(root) ? full : null;
}

function cacheControl(path: string): string {
  // Hashed names never change; everything else (index.html, sw.js, the manifest) must be checked
  // on every load, or a phone keeps an old worker for a day.
  return path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

async function serveFile(dir: string, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const path = resolveStatic(dir, pathname);
  const found = path ? await stat(path).then((s) => s.isFile(), () => false) : false;
  if (!path || !found) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    res.end('Not found');
    return;
  }
  const body = await readFile(path);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': cacheControl(path),
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

export interface NodeServerOptions {
  readonly handler: (request: Request) => Promise<Response>;
  /** The build output (dist/apps/push-lab). */
  readonly dir: string;
}

export function createNodeServer({ handler, dir }: NodeServerOptions): Server {
  return createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    // A fixed origin: the handler reads only the path, and a Host header is whatever the client sent.
    const work = pathname.startsWith('/api/')
      ? Promise.resolve()
          .then(() => handler(toRequest(req, 'http://localhost')))
          .then((response) => sendResponse(res, response))
      : req.method === 'GET' || req.method === 'HEAD'
        ? serveFile(dir, req, res, pathname)
        : Promise.resolve(void res.writeHead(405, { allow: 'GET, HEAD' }).end());
    work.catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    });
  });
}
