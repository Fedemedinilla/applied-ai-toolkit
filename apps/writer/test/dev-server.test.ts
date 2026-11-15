// The node:http wrapper, on an ephemeral port on 127.0.0.1 with a stub handler: no key, no model,
// no traffic beyond the loopback interface.

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevServer } from '../server/dev-server.ts';
import type { Handler } from '../server/handler.ts';

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

function get(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('dev server', () => {
  it('answers only requests addressed to 127.0.0.1 or localhost on its port', async () => {
    let calls = 0;
    const port = await start(async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    });
    expect(await get(port, `127.0.0.1:${port}`)).toBe(200);
    expect(await get(port, `localhost:${port}`)).toBe(200);
    // DNS rebinding: a page on another name that resolves to 127.0.0.1.
    expect(await get(port, `evil.example:${port}`)).toBe(403);
    expect(await get(port, '127.0.0.1:1')).toBe(403);
    expect(calls).toBe(2);
  });

  it('aborts the request when the client disconnects, so the model call stops', async () => {
    let entered: () => void = () => undefined;
    const inHandler = new Promise<void>((resolve) => (entered = resolve));
    const aborted = new Promise<boolean>((resolve) => {
      void start(async (request) => {
        request.signal.addEventListener('abort', () => resolve(true));
        entered();
        await new Promise((r) => setTimeout(r, 2000));
        resolve(false);
        return new Response('{}');
      }).then((port) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/draft', method: 'POST', headers: { host: `127.0.0.1:${port}` } });
        req.on('error', () => undefined);
        req.end('{}');
        void inHandler.then(() => req.destroy());
      });
    });
    expect(await aborted).toBe(true);
  });
});
