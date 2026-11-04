// The panel's flows over the in-memory store: an invite from the operator, the owner's password,
// login with a rehash, editing content, and the checks that keep one owner out of another's row.

import { describe, expect, it } from 'vitest';
import { hashPassword, SESSION_COOKIE } from '../server/auth.ts';
import { MemoryStore } from '../server/store.ts';
import { ADMIN, BAKERY, BASE, FAST_SCRYPT, SECRET, setup, WORKSHOP, type Setup } from './setup.ts';

const ORIGIN = BASE;

function call(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/panel/api/${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const basic = (password: string): Record<string, string> => ({ authorization: `Basic ${Buffer.from(`ops:${password}`).toString('base64')}` });

/** The cookie value from a Set-Cookie header, ready for a Cookie header. */
function cookieFrom(response: Response): string {
  const set = response.headers.get('set-cookie') ?? '';
  const value = set.split(';')[0] ?? '';
  expect(value.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return value;
}

async function invite(s: Setup, tenantId = 'vivero-nuevo', email = 'owner@vivero-nuevo.example'): Promise<string> {
  const response = await s.app(call('admin/invite', 'POST', { tenantId, email, allowedDomains: ['vivero-nuevo.example'] }, basic(ADMIN)));
  expect(response.status).toBe(200);
  const { inviteUrl } = (await response.json()) as { inviteUrl: string };
  expect(inviteUrl.startsWith(`${BASE}/panel/#invite=`)).toBe(true);
  return inviteUrl.split('#invite=')[1] ?? '';
}

async function owner(s: Setup, password = 'una clave larga de prueba'): Promise<string> {
  const token = await invite(s);
  const accepted = await s.app(call('invite/accept', 'POST', { token, password }));
  expect(accepted.status).toBe(200);
  return cookieFrom(accepted);
}

describe('invites', () => {
  it('needs the operator password', async () => {
    const s = setup();
    const body = { tenantId: 'vivero-nuevo', email: 'owner@vivero-nuevo.example', allowedDomains: ['vivero-nuevo.example'] };
    expect((await s.app(call('admin/invite', 'POST', body))).status).toBe(401);
    expect((await s.app(call('admin/invite', 'POST', body, basic('guess')))).status).toBe(401);
    expect(s.store.tenants.has('vivero-nuevo')).toBe(false);
  });

  it('creates the tenant, checks the link, sets the password once and starts a session', async () => {
    const s = setup();
    const token = await invite(s);
    const check = await s.app(call('invite/check', 'POST', { token }));
    expect(await check.json()).toEqual({ email: 'owner@vivero-nuevo.example' });

    const accepted = await s.app(call('invite/accept', 'POST', { token, password: 'una clave larga de prueba' }));
    expect(accepted.status).toBe(200);
    const me = await s.app(call('me', 'GET', undefined, { cookie: cookieFrom(accepted) }));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { tenantId: string }).tenantId).toBe('vivero-nuevo');

    const again = await s.app(call('invite/accept', 'POST', { token, password: 'otra clave larga de prueba' }));
    expect(again.status).toBe(410);
  });

  it('refuses a short password, an expired link, and a link replaced by a newer one', async () => {
    const s = setup();
    const first = await invite(s);
    expect((await s.app(call('invite/accept', 'POST', { token: first, password: 'corta' }))).status).toBe(400);
    const second = await invite(s);
    expect((await s.app(call('invite/check', 'POST', { token: first }))).status).toBe(410);
    s.clock.advance(48 * 60 * 60 * 1000);
    expect((await s.app(call('invite/accept', 'POST', { token: second, password: 'una clave larga de prueba' }))).status).toBe(410);
  });

  it('refuses a session token used as an invite', async () => {
    const s = setup();
    const cookie = await owner(s);
    const sessionToken = cookie.split('=')[1] ?? '';
    expect((await s.app(call('invite/check', 'POST', { token: sessionToken }))).status).toBe(410);
  });

  it('limits failed operator logins per IP, and keeps refusing the right password until the window passes', async () => {
    const s = setup({ limits: { loginAttempts: 3 } });
    const body = { tenantId: 'vivero-nuevo', email: 'owner@vivero-nuevo.example', allowedDomains: ['vivero-nuevo.example'] };
    for (let i = 0; i < 3; i += 1) expect((await s.app(call('admin/invite', 'POST', body, basic(`guess ${i}`)))).status).toBe(401);
    const blocked = await s.app(call('admin/invite', 'POST', body, basic(ADMIN)));
    expect(blocked.status).toBe(429);
    expect(s.store.tenants.has('vivero-nuevo')).toBe(false);
    // Another address is not affected, and successful calls do not count.
    for (let i = 0; i < 4; i += 1) expect((await s.app(call('admin/invite', 'POST', body, { ...basic(ADMIN), 'x-test-ip': '192.0.2.99' }))).status).toBe(200);
    s.clock.advance(60_000);
    expect((await s.app(call('admin/invite', 'POST', body, basic(ADMIN)))).status).toBe(200);
  });

  it('refuses at startup an operator password under 16 characters', async () => {
    const { createApp } = await import('../server/app.ts');
    const { createAuth } = await import('../server/auth.ts');
    const deps = { store: new MemoryStore(), gateway: null, auth: createAuth(SECRET, () => new Date()), publicBaseUrl: BASE, clientIp: () => null };
    expect(() => createApp({ ...deps, adminPassword: 'short-password1' })).toThrow(/16 characters/u);
    expect(() => createApp({ ...deps, adminPassword: 'sixteen chars ok' })).not.toThrow();
    expect(() => createApp({ ...deps, adminPassword: null })).not.toThrow();
  });

  it('cuts an oversized chunked body at the limit, before reading the rest', async () => {
    const s = setup();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode(`{"token":"${'a'.repeat(16 * 1024)}`));
      },
    });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: endless, duplex: 'half' };
    const response = await s.app(new Request(`${BASE}/panel/api/invite/check`, init));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'too_large' });
    // 128 KiB in chunks of about 16 KiB: a handful of pulls, not the whole stream.
    expect(pulled).toBeLessThan(12);
  });

  it('does not hand a tenant to a second email', async () => {
    const s = setup();
    await invite(s);
    const response = await s.app(call('admin/invite', 'POST', { tenantId: 'vivero-nuevo', email: 'someone@else.example', allowedDomains: ['x.example'] }, basic(ADMIN)));
    expect(response.status).toBe(409);
  });
});

describe('login', () => {
  it('logs in, and refuses a wrong password and an unknown email with the same answer', async () => {
    const s = setup();
    await owner(s);
    const ok = await s.app(call('login', 'POST', { email: 'OWNER@vivero-nuevo.example', password: 'una clave larga de prueba' }));
    expect(ok.status).toBe(200);
    cookieFrom(ok);
    const wrong = await s.app(call('login', 'POST', { email: 'owner@vivero-nuevo.example', password: 'no es esta' }));
    const unknown = await s.app(call('login', 'POST', { email: 'nobody@vivero-nuevo.example', password: 'no es esta' }));
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('limits attempts per IP', async () => {
    const s = setup({ limits: { loginAttempts: 3 } });
    const attempt = (): Promise<Response> => s.app(call('login', 'POST', { email: 'a@b.example', password: 'x' }));
    expect([(await attempt()).status, (await attempt()).status, (await attempt()).status]).toEqual([401, 401, 401]);
    expect((await attempt()).status).toBe(429);
  });

  it('rehashes a weaker stored hash on login and keeps the session valid', async () => {
    const store = new MemoryStore();
    store.putTenant(BAKERY);
    const weak = await hashPassword('una clave larga de prueba', FAST_SCRYPT);
    const row = store.tenants.get(BAKERY.tenantId);
    if (row) row.owner.passwordHash = weak;
    // The app's current parameters are N = 2^15 here, stronger than the stored 2^14.
    const s = setup({ store });
    const { createApp } = await import('../server/app.ts');
    const { createAuth } = await import('../server/auth.ts');
    const app = createApp({ store, gateway: null, auth: createAuth('y'.repeat(40), () => s.clock.now), publicBaseUrl: BASE, adminPassword: null, clientIp: () => '192.0.2.1', scrypt: { N: 1 << 15, r: 8, p: 1 } });
    const response = await app(call('login', 'POST', { email: BAKERY.email, password: 'una clave larga de prueba' }));
    expect(response.status).toBe(200);
    const stored = store.tenants.get(BAKERY.tenantId)?.owner.passwordHash ?? '';
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/u);
    expect((await app(call('me', 'GET', undefined, { cookie: cookieFrom(response) }))).status).toBe(200);
  });
});

describe('session and content', () => {
  it('returns the content and the install line, and saves a patch', async () => {
    const s = setup();
    const cookie = await owner(s);
    const me = (await (await s.app(call('me', 'GET', undefined, { cookie }))).json()) as { snippet: string; content: Record<string, unknown> };
    expect(me.snippet).toBe('<script src="https://widget.example/embed/chat.js" data-tenant="vivero-nuevo" async></script>');
    expect(Object.keys(me.content).sort()).toEqual(['botName', 'context', 'faq', 'suggestedQuestions', 'tone', 'tonePreset', 'welcome']);

    const saved = await s.app(call('content', 'PUT', { context: 'Abrimos los sábados.', tonePreset: 'formal', suggestedQuestions: ['¿Abren hoy?'] }, { cookie }));
    expect(saved.status).toBe(200);
    expect(s.store.tenants.get('vivero-nuevo')?.config).toMatchObject({ context: 'Abrimos los sábados.', tonePreset: 'formal', suggestedQuestions: ['¿Abren hoy?'] });
  });

  it('takes the tenant from the session only: a body naming another tenant is refused', async () => {
    const s = setup();
    const cookie = await owner(s);
    const response = await s.app(call('content', 'PUT', { tenantId: WORKSHOP.tenantId, context: 'hijacked' }, { cookie }));
    expect(response.status).toBe(400);
    expect(s.store.tenants.get(WORKSHOP.tenantId)?.config['context']).toBe(WORKSHOP.context);
  });

  it('refuses content over its limits and names the fields', async () => {
    const s = setup();
    const cookie = await owner(s);
    const response = await s.app(call('content', 'PUT', { context: 'x'.repeat(20_001), suggestedQuestions: ['a', 'b', 'c', 'd', 'e'] }, { cookie }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { fields: string[] }).fields.sort()).toEqual(['context', 'suggestedQuestions']);
  });

  it('refuses a tampered or expired cookie', async () => {
    const s = setup();
    const cookie = await owner(s);
    const [name, token = ''] = cookie.split('=');
    const [body = '', signature = ''] = token.split('.');
    const forged = Buffer.from(Buffer.from(body, 'base64url').toString().replace('vivero-nuevo', 'taller-rueda')).toString('base64url');
    expect((await s.app(call('me', 'GET', undefined, { cookie: `${name}=${forged}.${signature}` }))).status).toBe(401);
    expect((await s.app(call('me', 'GET'))).status).toBe(401);
    s.clock.advance(7 * 24 * 60 * 60 * 1000);
    expect((await s.app(call('me', 'GET', undefined, { cookie }))).status).toBe(401);
  });

  it('ends every session when the password is reset through a new invite', async () => {
    const s = setup();
    const before = await owner(s);
    const token = await invite(s);
    await s.app(call('invite/accept', 'POST', { token, password: 'una clave nueva y larga' }));
    expect((await s.app(call('me', 'GET', undefined, { cookie: before }))).status).toBe(401);
  });

  it('refuses writes from another origin, with no Origin, or without a JSON content type', async () => {
    const s = setup();
    const cookie = await owner(s);
    const patch = { context: 'x' };
    expect((await s.app(call('content', 'PUT', patch, { cookie, origin: 'https://evil.example' }))).status).toBe(403);
    const noOrigin = new Request(`${BASE}/panel/api/content`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    expect((await s.app(noOrigin)).status).toBe(403);
    const form = new Request(`${BASE}/panel/api/content`, { method: 'PUT', headers: { cookie, origin: ORIGIN, 'content-type': 'text/plain' }, body: JSON.stringify(patch) });
    expect((await s.app(form)).status).toBe(400);
    expect(s.store.tenants.get('vivero-nuevo')?.config['context']).toBe('');
  });

  it('answers 503 when the store fails, without leaking the error', async () => {
    const s = setup();
    const cookie = await owner(s);
    Object.defineProperty(s.store, 'getConfig', { value: async () => Promise.reject(new Error('connection to 10.0.0.5 refused')) });
    const response = await s.app(call('me', 'GET', undefined, { cookie }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('10.0.0.5');
  });
});
