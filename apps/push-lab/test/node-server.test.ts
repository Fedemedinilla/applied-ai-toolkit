// node:http around the handler, on a random local port, over a tiny fake build.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHandler } from '../server/handler.ts';
import { createNodeServer, CSP, resolveStatic } from '../server/node-server.ts';
import { memoryStore } from '../server/store.ts';
import { generateVapidPair } from '../server/vapid.ts';
import { fakeDevice } from './helpers/fake-push-service.ts';

let dir = '';
let server: Server;
let base = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'push-lab-serve-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(dir, 'sw.js'), 'self;');
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'x;');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{}');
  const vapid = { ...generateVapidPair(), subject: 'mailto:lab@example.test' };
  const handler = createHandler({ store: memoryStore(), send: async () => undefined, vapid });
  server = createNodeServer({ handler, dir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('static files', () => {
  it('serves index.html for / with the CSP and no-cache', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(CSP);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves sw.js as JavaScript with no-cache, and hashed assets as immutable', async () => {
    const sw = await fetch(`${base}/sw.js`);
    expect(sw.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const asset = await fetch(`${base}/assets/index-abc.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
  });

  it('refuses paths that leave the build folder', () => {
    expect(resolveStatic(dir, '/../etc/passwd')).toBeNull();
    expect(resolveStatic(dir, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStatic(dir, '/..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveStatic(dir, '/a%00b')).toBeNull();
    expect(resolveStatic(dir, '/%E0%A4%A')).toBeNull();
    expect(resolveStatic(dir, '/assets/index-abc.js')).toBe(join(dir, 'assets', 'index-abc.js'));
  });

  it('answers 404 for a missing file and for a folder', async () => {
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/assets`)).status).toBe(404);
  });
});

describe('the API through node:http', () => {
  it('passes the method, headers and body to the handler', async () => {
    const created = await fetch(`${base}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The server here runs with the default allowlist, so the endpoint is on a real push host.
      body: JSON.stringify({ ...fakeDevice('n'), endpoint: 'https://web.push.apple.com/node-test' }),
    });
    expect(created.status).toBe(201);
    const diagnose = await (await fetch(`${base}/api/diagnose`)).json();
    expect(diagnose).toMatchObject({ store: { subscriptions: 1, services: { apple: 1 } } });
  });

  it('refuses an endpoint outside the known push services', async () => {
    const response = await fetch(`${base}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fakeDevice('n'), endpoint: 'https://10.0.0.1/' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unknown_push_service' });
  });

  it('answers 413 to a chunked body with no Content-Length over the cap', async () => {
    // How much the handler reads is measured in handler.test.ts; here the client keeps sending
    // regardless, so only the answer through node:http is checked.
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // 1 KiB per chunk, up to 1 MiB: far more than the cap if it were all read.
        if (pulled > 1024) controller.close();
        else controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const response = await fetch(`${base}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(response.status).toBe(413);
  });

  it('returns the bare redirect without following it', async () => {
    const response = await fetch(`${base}/api/redirect-check`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('../?redirected=1');
  });
});
