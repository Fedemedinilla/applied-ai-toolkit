// The node:http wrapper, on an ephemeral port on 127.0.0.1 with a stub handler: no key, no model,
// no traffic beyond the loopback interface.

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevServer } from '../server/dev-server.ts';
import type { Handler } from '../server/handler.ts';
import { MAX_BODY_BYTES } from '../src/protocol.ts';

const servers: Array<ReturnType<typeof createDevServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function start(handler: Handler): Promise<number> {
  const server = createDevServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function call(port: number, host: string, method = 'GET', body?: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', method, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('dev server', () => {
  it('answers only requests addressed to 127.0.0.1 or localhost on its port', async () => {
    let calls = 0;
    const port = await start(async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    });
    expect(await call(port, `127.0.0.1:${port}`)).toBe(200);
    expect(await call(port, `localhost:${port}`)).toBe(200);
    // DNS rebinding: a page on another name that resolves to 127.0.0.1.
    expect(await call(port, `evil.example:${port}`)).toBe(403);
    expect(await call(port, '127.0.0.1:1')).toBe(403);
    expect(calls).toBe(2);
  });

  it('hands the handler at most one chunk past the body limit', async () => {
    let seen = -1;
    const port = await start(async (request) => {
      seen = (await request.arrayBuffer()).byteLength;
      return new Response('{}', { status: 200 });
    });
    expect(await call(port, `127.0.0.1:${port}`, 'POST', Buffer.alloc(4 * MAX_BODY_BYTES, 0x61))).toBe(200);
    expect(seen).toBeGreaterThan(MAX_BODY_BYTES);
    expect(seen).toBeLessThan(2 * MAX_BODY_BYTES);
  });
});
