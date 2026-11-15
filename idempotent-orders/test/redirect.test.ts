import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrdersClient } from '../src/index.ts';

// Two loopback servers: the configured URL answers 307 to another origin, as a misrouted
// proxy or custom domain could. The secret header must never reach the other origin.
let origin: Server;
let other: Server;
let originUrl = '';
const reachedOther: IncomingMessage[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

beforeAll(async () => {
  other = createServer((req, res) => {
    reachedOther.push(req);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"outcome":"not_found"}');
  });
  const otherUrl = await listen(other);
  origin = createServer((req, res) => {
    req.resume();
    res.writeHead(307, { Location: `${otherUrl}/elsewhere${req.url ?? ''}` }).end();
  });
  originUrl = await listen(origin);
});

afterAll(async () => {
  await Promise.all([origin, other].map((s) => new Promise((resolve) => s.close(resolve))));
});

it('does not follow a redirect, so the apikey never leaves the configured origin', async () => {
  const orders = createOrdersClient({
    url: `${originUrl}/rest/v1`,
    headers: { apikey: 'test-secret' },
    sleep: async () => undefined,
  });
  const r = await orders.placeOrder({
    key: 'key-redirect-0000000001',
    customerId: 'shop-1',
    lines: [{ productId: 1, quantity: 1 }],
  });
  expect(reachedOther).toHaveLength(0);
  // A 3xx says nothing about the write, so it is treated as ambiguous and ends unknown.
  expect(r).toMatchObject({ kind: 'unknown', reason: 'retries_exhausted', requests: 4 });
});
