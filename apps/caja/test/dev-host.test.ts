// The dev server's Host check. A page that rebinds its own name to 127.0.0.1 is same-origin with
// the dev server and needs no CORS preflight, so the JSON-only rule does not stop it; the Host
// header it sends still names its own domain.

import { describe, expect, it } from 'vitest';
import { DEV_PORT, withLocalHost } from '../server/dev-host.ts';
import type { Handler } from '../server/handler.ts';

function guarded(): { handler: Handler; calls: () => number } {
  let calls = 0;
  const inner: Handler = async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { handler: withLocalHost(inner), calls: () => calls };
}

const request = (host: string | null, path = '/api/extract'): Request => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (host !== null) headers.set('host', host);
  return new Request(`http://127.0.0.1:${DEV_PORT}${path}`, { method: 'POST', headers, body: '{}' });
};

describe('withLocalHost', () => {
  it.each([`127.0.0.1:${DEV_PORT}`, `localhost:${DEV_PORT}`, `LOCALHOST:${DEV_PORT}`])('passes %s to the handler', async (host) => {
    const { handler, calls } = guarded();
    expect((await handler(request(host))).status).toBe(200);
    expect(calls()).toBe(1);
  });

  it.each([
    ['a rebound domain', `attacker.example:${DEV_PORT}`],
    ['the right name on another port', 'localhost:5173'],
    ['a name with no port', 'localhost'],
    ['no Host header', null],
  ])('refuses %s with 403 before the handler runs', async (_name, host) => {
    const { handler, calls } = guarded();
    const res = await handler(request(host));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_host' });
    expect(calls()).toBe(0);
  });
});
