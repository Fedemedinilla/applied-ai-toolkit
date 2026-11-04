// node:http around the app: the widget and panel routes go to the handler, everything else is a
// file from the build. A host with a Fetch API runtime can call the handler directly instead.

import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Handler } from './app.ts';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * The policy for this server's own pages. The widget runs under it: no inline script or style,
 * styles attached as a constructed stylesheet, and only same-origin requests.
 */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The file for a URL path inside `dir`, or null for anything that resolves outside it. */
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
  if (path.includes(`${sep}assets${sep}`)) return 'public, max-age=31536000, immutable';
  // The loader keeps its name across builds so the snippet never changes: a short cache.
  if (path.endsWith(`${sep}embed${sep}chat.js`)) return 'public, max-age=300';
  return 'no-cache';
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
    'referrer-policy': 'strict-origin-when-cross-origin',
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

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The socket's address. Behind a proxy, pass a different `clientIp` to createApp instead. */
export const SOCKET_IP = new WeakMap<Request, string>();

export function createNodeServer(options: { readonly handler: Handler; readonly dir: string }): Server {
  return createServer((req, res) => {
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const api = pathname.startsWith('/widget/') || pathname.startsWith('/panel/api/');
    const work = api
      ? (async () => {
          const request = toRequest(req, origin);
          if (req.socket.remoteAddress) SOCKET_IP.set(request, req.socket.remoteAddress);
          await send(res, await options.handler(request));
        })()
      : serveFile(options.dir, req, res, pathname);
    work.catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
}
