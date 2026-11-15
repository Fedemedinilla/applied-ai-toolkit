// The local server from server/static.ts on a free port of 127.0.0.1, over a temporary folder and
// a stub app. Nothing leaves the machine.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY_LIMIT, CSP, createStaticServer } from '../server/static.ts';

let dir = '';
let server: Server;
let port = 0;
const seen: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'salon-assistant-serve-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><p>page</p>');
  writeFileSync(join(dir, 'secret.txt'), 'outside-the-root');
  server = createStaticServer({
    root: join(dir, 'dist'),
    origin: 'http://127.0.0.1:8791',
    app: async (req) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      if (new URL(req.url).pathname === '/api/throws') throw new Error('boom');
      return new Response(JSON.stringify({ ok: true, length: (await req.arrayBuffer()).byteLength }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A raw request: the path is sent as written, with no client-side normalisation. */
function send(method: string, path: string, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: body === undefined ? {} : { 'content-type': 'application/json' } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

/** Raw bytes on a socket, for request targets an HTTP client would refuse to send. */
function raw(bytes: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(bytes));
    const parts: Buffer[] = [];
    socket.on('data', (c: Buffer) => parts.push(c));
    socket.on('end', () => done(Buffer.concat(parts).toString('latin1')));
    socket.on('error', fail);
  });
}

describe('the local server', () => {
  it('answers 400 to a request target the URL parser rejects, and keeps serving', async () => {
    const reply = await raw('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
    expect((await send('GET', '/')).status).toBe(200);
  });

  it('serves the page with the CSP header', async () => {
    const r = await send('GET', '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('page');
    expect(r.headers['content-security-policy']).toBe(CSP);
  });

  it('sends the policy csp-build-guard checks the build against', () => {
    const config = JSON.parse(readFileSync(new URL('../csp-guard.config.json', import.meta.url), 'utf8')) as { csp: { value: string } };
    expect(CSP).toBe(config.csp.value);
  });

  it('never serves a file outside the root', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/..%5csecret.txt']) {
      const r = await send('GET', path);
      expect(r.status, path).toBe(404);
      expect(r.text, path).not.toContain('outside-the-root');
    }
  });

  it('answers TRACE with 405 and never hands it to the app', async () => {
    seen.length = 0;
    const r = await send('TRACE', '/api/assistant');
    expect(r.status).toBe(405);
    expect(seen).toEqual([]);
  });

  it('hands a body up to the limit to the app, and answers 413 above it', async () => {
    const ok = await send('POST', '/api/assistant', 'x'.repeat(BODY_LIMIT));
    expect([ok.status, JSON.parse(ok.text)]).toEqual([200, { ok: true, length: BODY_LIMIT }]);
    const big = await send('POST', '/api/assistant', 'x'.repeat(BODY_LIMIT + 1));
    expect([big.status, JSON.parse(big.text)]).toEqual([413, { error: 'too_large' }]);
  });

  it('answers 500 when the app rejects, and keeps serving', async () => {
    const r = await send('POST', '/api/throws', '{}');
    expect([r.status, JSON.parse(r.text)]).toEqual([500, { error: 'server_error' }]);
    expect((await send('GET', '/')).status).toBe(200);
  });
});
