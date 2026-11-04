// Password hashes, signed tokens, the cookie and Basic, as functions. The panel flows that use
// them are in panel-api.test.ts.

import { describe, expect, it } from 'vitest';
import {
  basicAuthOk,
  clearSessionCookie,
  createAuth,
  hashPassword,
  parseHash,
  readCookie,
  SCRYPT_PARAMS,
  sessionCookie,
  verifyPassword,
} from '../server/auth.ts';
import { FAST_SCRYPT, SECRET } from './setup.ts';

describe('password hashes', () => {
  it('uses N = 2^17, r = 8, p = 1 by default, in a format that carries them', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/u);
    expect(SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 });
    expect(await verifyPassword('correct horse battery', hash)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword('correct horse batterz', hash)).toEqual({ ok: false, needsRehash: false });
  }, 20_000);

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password', FAST_SCRYPT), hashPassword('same password', FAST_SCRYPT)]);
    expect(a).not.toBe(b);
  });

  it('asks for a rehash when a valid hash is weaker than the current parameters', async () => {
    const weak = await hashPassword('correct horse battery', FAST_SCRYPT);
    expect(await verifyPassword('correct horse battery', weak, SCRYPT_PARAMS)).toEqual({ ok: true, needsRehash: true });
    expect(await verifyPassword('correct horse battery', weak, FAST_SCRYPT)).toEqual({ ok: true, needsRehash: false });
    // A wrong password never asks for a rehash.
    expect(await verifyPassword('wrong', weak, SCRYPT_PARAMS)).toEqual({ ok: false, needsRehash: false });
  });

  it('refuses stored hashes outside the accepted bounds instead of computing them', async () => {
    const good = await hashPassword('x', FAST_SCRYPT);
    const [, , , , salt, key] = good.split('$');
    const variants = [
      `scrypt$12345$8$1$${salt}$${key}`, // N not a power of two
      `scrypt$8192$8$1$${salt}$${key}`, // N below 2^14
      `scrypt$2097152$8$1$${salt}$${key}`, // N above 2^20
      `scrypt$1048576$16$1$${salt}$${key}`, // 2 GiB of memory
      `scrypt$16384$8$9$${salt}$${key}`, // p too high
      `bcrypt$16384$8$1$${salt}$${key}`,
      'salt:hash',
      '',
    ];
    for (const stored of variants) {
      expect(parseHash(stored)).toBeNull();
      expect((await verifyPassword('x', stored)).ok).toBe(false);
    }
  });
});

describe('signed tokens', () => {
  let now = new Date('2026-11-04T12:00:00Z');
  const auth = createAuth(SECRET, () => now);

  it('round-trips a session and an invite, each only for its purpose', () => {
    const session = auth.sign('session', 'panaderia-sol', 'tag', 60);
    const invite = auth.sign('invite', 'panaderia-sol', 'nonce', 60);
    expect(auth.verify(session, 'session')).toEqual({ tenantId: 'panaderia-sol', n: 'tag' });
    expect(auth.verify(invite, 'invite')).toEqual({ tenantId: 'panaderia-sol', n: 'nonce' });
    expect(auth.verify(session, 'invite')).toBeNull();
    expect(auth.verify(invite, 'session')).toBeNull();
  });

  it('refuses a tampered payload, a tampered signature and another secret', () => {
    const token = auth.sign('session', 'panaderia-sol', 'tag', 60);
    const [body = '', signature = ''] = token.split('.');
    const forged = Buffer.from(Buffer.from(body, 'base64url').toString('utf8').replace('panaderia-sol', 'taller-rueda')).toString('base64url');
    expect(auth.verify(`${forged}.${signature}`, 'session')).toBeNull();
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(auth.verify(`${body}.${flipped}`, 'session')).toBeNull();
    expect(auth.verify(`${body}.`, 'session')).toBeNull();
    expect(auth.verify(body, 'session')).toBeNull();
    expect(createAuth(`${SECRET}-other`, () => now).verify(token, 'session')).toBeNull();
  });

  it('refuses an expired token', () => {
    const invite = auth.sign('invite', 'panaderia-sol', 'nonce', 60);
    now = new Date(now.getTime() + 59_999);
    expect(auth.verify(invite, 'invite')).not.toBeNull();
    now = new Date(now.getTime() + 1);
    expect(auth.verify(invite, 'invite')).toBeNull();
  });

  it('needs a secret of at least 32 bytes', () => {
    expect(() => createAuth('short', () => now)).toThrow(/32 bytes/u);
  });
});

describe('cookie and Basic', () => {
  it('sets a __Host- cookie that is HttpOnly, Secure and SameSite=Strict, and reads it back', () => {
    const cookie = sessionCookie('abc.def');
    expect(cookie).toBe('__Host-cw_session=abc.def; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800');
    expect(clearSessionCookie()).toContain('Max-Age=0');
    const request = new Request('https://widget.example/', { headers: { cookie: 'other=1; __Host-cw_session=abc.def; x=2' } });
    expect(readCookie(request, '__Host-cw_session')).toBe('abc.def');
    expect(readCookie(new Request('https://widget.example/', { headers: { cookie: 'x__Host-cw_session=evil' } }), '__Host-cw_session')).toBeNull();
  });

  it('compares the Basic password in constant time and ignores the user name', () => {
    const auth = createAuth(SECRET, () => new Date());
    const basic = (value: string): Request => new Request('https://widget.example/', { headers: { authorization: `Basic ${Buffer.from(value).toString('base64')}` } });
    expect(basicAuthOk(basic('anyone:open sesame'), 'open sesame', auth)).toBe(true);
    expect(basicAuthOk(basic('anyone:open sesamE'), 'open sesame', auth)).toBe(false);
    expect(basicAuthOk(basic('open sesame'), 'open sesame', auth)).toBe(false);
    expect(basicAuthOk(basic('anyone:open sesame'), null, auth)).toBe(false);
    expect(basicAuthOk(new Request('https://widget.example/'), 'open sesame', auth)).toBe(false);
  });
});
