// createNodeServer over a real socket on 127.0.0.1: requests the URL parser rejects must not
// take the process down.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeServer } from '../server/node-http.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

/** Sends one raw HTTP/1.1 request and returns the status line. */
async function raw(port: number, target: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    data += chunk;
  });
  await once(socket, 'close');
  return data.split('\r\n')[0] ?? '';
}

describe('createNodeServer', () => {
  it('answers 400 to a request-target the URL parser rejects, and keeps serving', async () => {
    const server = createNodeServer({ handler: async () => new Response('ok'), dir: '/nonexistent-dir-for-test' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;
    for (const target of ['//[/', '//%/', 'http://[/']) expect(await raw(port, target)).toBe('HTTP/1.1 400 Bad Request');
    expect(await raw(port, '/widget/config')).toBe('HTTP/1.1 200 OK');
  });
});
