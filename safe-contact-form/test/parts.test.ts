// The pieces on their own: link stripping, the limiter and the Resend adapter.

import { describe, expect, it } from 'vitest';
import { createLimiter, EMAIL, greeting, htmlDocument, quote, resendTransport, stripLinks, TransportError } from '../src/index.ts';
import { FAKE_KEY, fakeResend } from './helpers/fake-resend.ts';

describe('stripLinks', () => {
  const cases: Array<[string, string]> = [
    ['see https://evil.example/login now', 'see [x] now'],
    ['see HTTP://EVIL.EXAMPLE', 'see [x]'],
    ['ftp://files.example/a', '[x]'],
    ['www.evil.example', '[x]'],
    ['[click](https://evil.example)', 'click'],
    ['mail me at someone@evil.example', 'mail me at someone@[x]'],
    ['пример.рф', '[x]'],
    ['xn--e1afmkfd.xn--p1ai', '[x]'],
    ['wait...evil.ru', 'wait...[x]'],
    ['evil.co/a?b=c', '[x]'],
  ];
  it.each(cases)('%s', (input, out) => expect(stripLinks(input, '[x]')).toBe(out));

  it('prose with figures, versions and abbreviations is left alone', () => {
    const prose = 'It costs 1.500, v2.0, S.R.L., 10.30hs and 3.5 kg.';
    expect(stripLinks(prose, '[x]')).toBe(prose);
  });

  it('known false positives: a missing space after a full stop, and dotted acronyms', () => {
    expect(stripLinks('thanks.Regards', '[x]')).toBe('[x]');
    expect(stripLinks('EE.UU.', '[x]')).toBe('[x]');
  });
});

describe('quote and greeting', () => {
  it('quote filters again after the cut', () => {
    const s = `${'a'.repeat(10)} evil.ru-x`;
    expect(quote(s, 18, '[x]')).toBe(`${'a'.repeat(10)} [x]`);
  });

  it('greeting is one line and falls back when only links were there', () => {
    expect(greeting('Ana\nMaría', 32, 'there')).toBe('Ana María');
    expect(greeting('www.evil.example', 32, 'there')).toBe('there');
  });
});

describe('htmlDocument', () => {
  it('escapes the title and the lang', () => {
    expect(htmlDocument('x', 'en"', '<t>')).toContain('<html lang="en&quot;"><head><meta charset="utf-8">');
    expect(htmlDocument('x', 'en', '<t>')).toContain('<title>&lt;t&gt;</title>');
  });
});

describe('EMAIL', () => {
  it('accepts plain addresses, including plus tags and subdomains', () => {
    for (const ok of ['a@b.example', 'first.last+tag@mail.studio.example']) expect(EMAIL.test(ok)).toBe(true);
  });
});

describe('createLimiter', () => {
  it('validates its settings', () => {
    expect(() => createLimiter({ max: 0, windowMs: 1 }, () => 0)).toThrow();
    expect(() => createLimiter({ max: 1, windowMs: 0 }, () => 0)).toThrow();
  });

  it('keys are independent, and the map is bounded', () => {
    let t = 0;
    const limited = createLimiter({ max: 1, windowMs: 1000 }, () => t, 2);
    expect(limited('a')).toBe(false);
    expect(limited('b')).toBe(false);
    expect(limited('a')).toBe(true);
    expect(limited('c')).toBe(false); // evicts the least recently used key, b
    expect(limited('b')).toBe(false);
    t = 1000;
    expect(limited('a')).toBe(false);
  });
});

describe('resendTransport', () => {
  const message = { from: 'S <hello@studio.example>', to: 'v@visitor.example', replyTo: 'hello@studio.example', subject: 's', html: '<p>h</p>', text: 't' };

  it('posts the Resend body shape with the bearer key', async () => {
    const r = fakeResend();
    const t = resendTransport({ apiKey: FAKE_KEY, baseUrl: 'https://resend.test/', fetch: r.fetch });
    expect(await t.send(message)).toEqual({ id: 'email-1' });
    expect(r.calls[0]).toEqual({
      url: 'https://resend.test/emails',
      auth: `Bearer ${FAKE_KEY}`,
      body: { from: message.from, to: message.to, reply_to: message.replyTo, subject: 's', html: '<p>h</p>', text: 't' },
    });
  });

  it('a wrong key throws with the status and the provider code, never the provider message', async () => {
    const r = fakeResend();
    const t = resendTransport({ apiKey: 're_wrong', baseUrl: 'https://resend.test', fetch: r.fetch });
    const err = await t.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ status: 401, providerCode: 'missing_api_key' });
  });

  it('a 422 that echoes the request does not put it in the error', async () => {
    const r = fakeResend();
    r.failCall(1, 'validation');
    const t = resendTransport({ apiKey: FAKE_KEY, baseUrl: 'https://resend.test', fetch: r.fetch });
    const err = (await t.send(message).catch((e: unknown) => e)) as TransportError;
    expect(err.status).toBe(422);
    expect(err.message).not.toContain('visitor.example');
  });

  it('refuses to start without a key', () => {
    expect(() => resendTransport({ apiKey: '' })).toThrow(/apiKey/);
  });
});
