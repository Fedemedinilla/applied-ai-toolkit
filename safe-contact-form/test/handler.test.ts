// The handler end to end: a Request in, the emails the fake Resend received and the Response out.

import { describe, expect, it } from 'vitest';
import { createContactHandler, resendTransport, type ContactConfig, type ContactEvent } from '../src/index.ts';
import { FAKE_KEY, fakeResend } from './helpers/fake-resend.ts';

const SITE = 'https://studio.example';
const T0 = Date.UTC(2026, 10, 4, 15, 0, 0);

function setup(over: Partial<ContactConfig> = {}) {
  const resend = fakeResend();
  let clock = T0;
  const events: ContactEvent[] = [];
  const handler = createContactHandler({
    to: 'owner@studio.example',
    from: 'Example Studio <hello@studio.example>',
    publicAddress: 'hello@studio.example',
    siteName: 'Example Studio',
    homeUrl: { en: '/', es: '/es/' },
    transport: resendTransport({ apiKey: FAKE_KEY, baseUrl: 'https://resend.test', fetch: resend.fetch }),
    now: () => clock,
    log: (e) => events.push(e),
    ...over,
  });
  return {
    resend,
    events,
    handler,
    advance: (ms: number) => {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

type Fields = Record<string, string>;
const good = (now: number, over: Fields = {}): Fields => ({
  full_name: 'Tomás Ejemplo',
  reply_email: 'tomas@visitor.example',
  body: 'I would like a new website.\n\nHave a look at www.visitor-shop.example please.',
  page: 'home',
  topic: 'A new project',
  lang: 'en',
  rendered_at: String(now - 60_000),
  ...over,
});

let ip = 0;
const asJson = (fields: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SITE}/api/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE, ...headers },
    body: JSON.stringify(fields),
  });
const asForm = (fields: Fields, headers: Record<string, string> = {}) =>
  new Request(`${SITE}/api/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const ctx = () => ({ clientAddress: `198.51.100.${++ip}` });

describe('a valid message', () => {
  for (const lang of ['en', 'es'] as const) {
    it(`${lang}: sends the notice and the acknowledgment as whole documents with a text part`, async () => {
      const s = setup();
      const res = await s.handler(asJson(good(s.now, { lang })), ctx());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, acknowledged: true });
      expect(s.resend.sent).toHaveLength(2);
      const [notice, ack] = s.resend.sent;
      for (const mail of [notice!, ack!]) {
        expect(mail.html.startsWith(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`)).toBe(true);
        expect(mail.html).toContain('<title>');
        expect(mail.html.endsWith('</body></html>')).toBe(true);
        expect(mail.text.length).toBeGreaterThan(20);
      }
      expect(notice!.to).toBe('owner@studio.example');
      expect(notice!.reply_to).toBe('tomas@visitor.example');
      expect(notice!.text).toContain('www.visitor-shop.example');
      expect(ack!.to).toBe('tomas@visitor.example');
      expect(ack!.reply_to).toBe('hello@studio.example');
      expect(ack!.html).toContain('Tomás Ejemplo');
      expect(ack!.html + ack!.text).not.toContain('visitor-shop');
      expect(ack!.html).not.toMatch(/<a\b/i);
      expect(ack!.subject + ack!.text + ack!.html).not.toMatch(/[—–]/);
      expect(ack!.subject.endsWith('· Example Studio')).toBe(true);
      expect(ack!.text.endsWith('\n\nExample Studio\n')).toBe(true);
      expect(s.events.at(-1)).toEqual({ kind: 'sent', acknowledged: true });
    });
  }

  it('the destination comes only from the config, never from the request', async () => {
    const s = setup();
    await s.handler(asJson(good(s.now, { to: 'attacker@evil.example', destination: 'attacker@evil.example' })), ctx());
    expect(s.resend.sent[0]!.to).toBe('owner@studio.example');
    expect(JSON.stringify(s.resend.calls)).not.toContain('attacker@evil.example');
  });

  it('a subject with a newline stays one line, and the name is always in it', async () => {
    const s = setup();
    await s.handler(asJson(good(s.now, { topic: 'Hello\r\nBcc: someone@evil.example' })), ctx());
    expect(s.resend.sent[0]!.subject).toBe('Hello Bcc: someone@evil.example · Tomás Ejemplo (home)');
  });

  it('the message keeps its paragraphs and is escaped in the HTML part', async () => {
    const s = setup();
    await s.handler(asJson(good(s.now, { body: 'one\ntwo\n\n<b>three</b>' })), ctx());
    expect(s.resend.sent[0]!.html).toContain('<p style="margin:0 0 14px">one<br>two</p><p style="margin:0 0 14px">&lt;b&gt;three&lt;/b&gt;</p>');
  });

  it('field names are configurable', async () => {
    const s = setup({ fields: { name: 'nombre', email: 'correo', message: 'mensaje' } });
    const res = await s.handler(asJson({ nombre: 'Ana', correo: 'ana@visitor.example', mensaje: 'Hola, una consulta.' }), ctx());
    expect(res.status).toBe(200);
    expect(s.resend.sent[0]!.reply_to).toBe('ana@visitor.example');
  });

  it('the acknowledgment can be turned off', async () => {
    const s = setup({ sendAcknowledgment: false });
    expect(await (await s.handler(asJson(good(s.now)), ctx())).json()).toEqual({ ok: true, acknowledged: false });
    expect(s.resend.sent).toHaveLength(1);
  });
});

describe('what the acknowledgment may quote', () => {
  it('no domain survives, whatever its TLD; prose with figures and abbreviations does', async () => {
    const s = setup();
    const prose = 'It costs 1.500 pesos, v2.0 and S.R.L. at 10.30hs.';
    await s.handler(
      asJson(
        good(s.now, {
          full_name: 'Ana visit shop.top',
          body: `${prose}\n\nGo to some.ru/login, store.app, page.online/x, пример.рф or xn--e1afmkfd.xn--p1ai and write to support@some.click or [here](https://x.example)`,
        }),
      ),
      ctx(),
    );
    const [notice, ack] = s.resend.sent;
    const all = ack!.html + ack!.text;
    const left = ['some.ru', 'login', 'store.app', 'page.online', 'пример.рф', 'xn--', 'some.click', 'shop.top', 'x.example'].filter((d) => all.includes(d));
    expect(left).toEqual([]);
    expect(all).toContain(prose);
    expect(all).toContain('[link]');
    expect(notice!.text).toContain('some.ru/login');
  });

  it('a domain the cut leaves clean is removed, in the message and in the name', async () => {
    const s = setup();
    await s.handler(
      asJson(good(s.now, { full_name: `${'x'.repeat(24)} some.ru5`, body: `Look...other.ru please. ${'a'.repeat(270)} some.ru-x more text after` })),
      ctx(),
    );
    const ack = s.resend.sent[1]!;
    const all = ack.html + ack.text;
    expect(all).not.toContain('some.ru');
    expect(all).not.toContain('other.ru');
    expect(all).toContain('Look...');
  });

  it('a name made only of a link gets the greeting with no name', async () => {
    const s = setup();
    await s.handler(asJson(good(s.now, { full_name: 'https://evil.example/login' })), ctx());
    expect(s.resend.sent[1]!.text.startsWith('Hi,\n\n')).toBe(true);
  });

  it('the quote is cut at quoteMax', async () => {
    const s = setup({ quoteMax: 20 });
    await s.handler(asJson(good(s.now, { body: 'b'.repeat(100) })), ctx());
    expect(s.resend.sent[1]!.text).toContain(`${'b'.repeat(20)}…`);
    expect(s.resend.sent[1]!.text).not.toContain('b'.repeat(21));
  });
});

describe('bots', () => {
  it('the trap field answers success and sends nothing', async () => {
    const s = setup();
    const res = await s.handler(asJson(good(s.now, { fax_number: '555' })), ctx());
    expect(await res.json()).toEqual({ ok: true, acknowledged: true });
    expect(s.resend.calls).toHaveLength(0);
    expect(s.events).toEqual([{ kind: 'dropped', reason: 'trap' }]);
  });

  it('a submit faster than minFillMs is dropped the same way', async () => {
    const s = setup();
    const res = await s.handler(asJson(good(s.now, { rendered_at: String(s.now - 800) })), ctx());
    expect(res.status).toBe(200);
    expect(s.resend.calls).toHaveLength(0);
    expect(s.events).toEqual([{ kind: 'dropped', reason: 'too_fast' }]);
  });

  it('a visitor clock ahead of the server is skew, not a bot', async () => {
    const s = setup();
    for (const ahead of [1, 1_000, 90_000]) {
      await s.handler(asJson(good(s.now, { rendered_at: String(s.now + ahead) })), ctx());
    }
    expect(s.resend.sent).toHaveLength(6);
  });

  it('without the clock field (no JS) the clock is not judged', async () => {
    const s = setup();
    const fields = good(s.now);
    delete fields['rendered_at'];
    await s.handler(asForm(fields), ctx());
    expect(s.resend.sent).toHaveLength(2);
  });

  it('the threshold is configurable', async () => {
    const s = setup({ minFillMs: 100 });
    await s.handler(asJson(good(s.now, { rendered_at: String(s.now - 800) })), ctx());
    expect(s.resend.sent).toHaveLength(2);
  });

  it('the no-JS trap answer is the success page', async () => {
    const s = setup();
    const res = await s.handler(asForm(good(s.now, { fax_number: 'x' })), ctx());
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Message received.');
  });
});

describe('origin', () => {
  it('another site is refused before anything is sent', async () => {
    const s = setup();
    const res = await s.handler(asJson(good(s.now), { origin: 'https://evil.example' }), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin' });
    expect(s.resend.calls).toHaveLength(0);
  });

  it('"null" is not an origin of the site', async () => {
    const s = setup();
    expect((await s.handler(asJson(good(s.now), { origin: 'null' }), ctx())).status).toBe(403);
  });

  it('the public origin is rebuilt from X-Forwarded-Host when the platform rewrites the URL', async () => {
    // Some adapters build request.url from an internal host (http://localhost/...).
    const s = setup();
    const req = new Request('http://localhost:3000/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE, 'x-forwarded-host': 'studio.example, edge.internal', 'x-forwarded-proto': 'https' },
      body: JSON.stringify(good(s.now)),
    });
    expect((await s.handler(req, ctx())).status).toBe(200);
  });

  it('forwarded headers are ignored when the config says so', async () => {
    const s = setup({ trustForwardedHeaders: false });
    const req = new Request('http://localhost:3000/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE, 'x-forwarded-host': 'studio.example', 'x-forwarded-proto': 'https' },
      body: JSON.stringify(good(s.now)),
    });
    expect((await s.handler(req, ctx())).status).toBe(403);
  });

  it('an extra allowed origin, such as production from a preview', async () => {
    const s = setup({ allowedOrigins: ['https://www.studio.example/'] });
    expect((await s.handler(asJson(good(s.now), { origin: 'https://www.studio.example' }), ctx())).status).toBe(200);
  });

  it('a request with no Origin header goes on to the other checks', async () => {
    const s = setup();
    const req = new Request(`${SITE}/api/contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good(s.now)) });
    expect((await s.handler(req, ctx())).status).toBe(200);
  });

  it('the no-JS refusal is a page in the visitor language', async () => {
    const s = setup();
    const res = await s.handler(asForm(good(s.now, { lang: 'es' }), { origin: 'https://evil.example' }), ctx());
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('hello@studio.example');
  });
});

describe('validation', () => {
  const invalid: Array<[string, Fields]> = [
    ['two recipients with a comma', { reply_email: 'me@visitor.example,victim@other.example' }],
    ['two recipients with a semicolon', { reply_email: 'me@visitor.example;victim@other.example' }],
    ['a display name', { reply_email: 'Me <me@visitor.example>' }],
    ['no domain dot', { reply_email: 'me@localhost' }],
    ['two @', { reply_email: 'a@b@c.example' }],
    ['a space', { reply_email: 'me @visitor.example' }],
    ['no name', { full_name: '  ' }],
    ['a one-character message', { body: 'x' }],
  ];
  it.each(invalid)('%s is refused with 400', async (_label, over) => {
    const s = setup();
    const res = await s.handler(asJson(good(s.now, over)), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
    expect(s.resend.calls).toHaveLength(0);
  });

  it('non-string fields are ignored, not stringified', async () => {
    const s = setup();
    const res = await s.handler(asJson({ ...good(s.now), reply_email: ['a@visitor.example', 'b@other.example'] }), ctx());
    expect(res.status).toBe(400);
  });

  it('a body that is not JSON is a 400, not a crash', async () => {
    const s = setup();
    const req = new Request(`${SITE}/api/contact`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: '{nope' });
    expect((await s.handler(req, ctx())).status).toBe(400);
  });

  it('the no-JS page for missing details', async () => {
    const s = setup();
    const res = await s.handler(asForm(good(s.now, { reply_email: 'nope' })), ctx());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Some details are missing.');
  });

  it('a multipart form works too', async () => {
    const s = setup();
    const fd = new FormData();
    for (const [k, v] of Object.entries(good(s.now))) fd.set(k, v);
    const res = await s.handler(new Request(`${SITE}/api/contact`, { method: 'POST', headers: { origin: SITE }, body: fd }), ctx());
    expect(res.status).toBe(200);
    expect(s.resend.sent).toHaveLength(2);
  });
});

describe('request shape', () => {
  it('any method but POST gets 405 with Allow', async () => {
    const s = setup();
    const res = await s.handler(new Request(`${SITE}/api/contact`), ctx());
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('text/plain gets 415, so a cross-site page cannot post JSON without a preflight', async () => {
    const s = setup();
    const req = new Request(`${SITE}/api/contact`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(good(s.now)) });
    expect((await s.handler(req, ctx())).status).toBe(415);
  });

  it('a body over the limit gets 413, even without a declared length', async () => {
    const s = setup({ maxBodyBytes: 1024 });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(512).fill(97));
        c.close();
      },
    });
    const req = new Request(`${SITE}/api/contact`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: stream, duplex: 'half' } as RequestInit);
    expect((await s.handler(req, ctx())).status).toBe(413);
  });
});

describe('no key, no fake success', () => {
  it('without a transport the JSON path answers 503 and the form path a page with the public address', async () => {
    const s = setup({ transport: null });
    const res = await s.handler(asJson(good(s.now)), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'not_configured' });
    const page = await s.handler(asForm(good(s.now)), ctx());
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain('hello@studio.example');
    expect(html).not.toContain('owner@studio.example');
    expect(s.events).toContainEqual({ kind: 'not_configured' });
  });

  it('a provider refusal of the notice is an error, not a success', async () => {
    for (const answer of ['validation', 'forbidden', 'network', 'no-id', 'not-json'] as const) {
      const s = setup();
      s.resend.failCall(1, answer);
      const res = await s.handler(asJson(good(s.now)), ctx());
      expect(res.status, answer).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'send_failed' });
      expect(s.resend.calls, answer).toHaveLength(1);
    }
  });

  it('a failed acknowledgment still answers success, and says it was not sent', async () => {
    const s = setup();
    s.resend.failCall(2, 'forbidden');
    const res = await s.handler(asJson(good(s.now)), ctx());
    expect(await res.json()).toEqual({ ok: true, acknowledged: false });
    expect(s.events).toEqual([{ kind: 'ack_failed' }, { kind: 'sent', acknowledged: false }]);
  });

  it('log events never carry what the visitor wrote', async () => {
    const s = setup();
    s.resend.failCall(2, 'validation');
    await s.handler(asJson(good(s.now)), ctx());
    await s.handler(asJson(good(s.now, { reply_email: 'bad' })), ctx());
    const logged = JSON.stringify(s.events);
    expect(logged).not.toContain('tomas');
    expect(logged).not.toContain('website');
  });
});

describe('the per-IP limit', () => {
  it('counts only accepted sends, so a patient retry gets through', async () => {
    const s = setup({ rateLimit: { max: 3, windowMs: 10 * 60_000 } });
    const at = { clientAddress: '203.0.113.9' };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await s.handler(asJson(good(s.now)), at)).status);
    expect(statuses).toEqual([200, 200, 200]);
    expect((await s.handler(asJson(good(s.now)), at)).status).toBe(429);
    const page = await s.handler(asForm(good(s.now)), at);
    expect(page.status).toBe(429);
    expect(await page.text()).toContain('hello@studio.example');
    // One retry a minute, as the page invites, for the rest of the window.
    let refused = 0;
    for (let m = 1; m <= 9; m++) {
      s.advance(60_000);
      if ((await s.handler(asJson(good(s.now)), at)).status === 429) refused++;
    }
    expect(refused).toBe(9);
    s.advance(61_000);
    expect((await s.handler(asJson(good(s.now)), at)).status).toBe(200);
  });

  it('an invalid submit does not spend a send', async () => {
    const s = setup({ rateLimit: { max: 1, windowMs: 60_000 } });
    const at = { clientAddress: '203.0.113.10' };
    expect((await s.handler(asJson(good(s.now, { reply_email: 'typo' })), at)).status).toBe(400);
    expect((await s.handler(asJson(good(s.now)), at)).status).toBe(200);
  });
});

describe('config', () => {
  it('refuses a destination that is not one address', () => {
    expect(() => setup({ to: 'a@studio.example, b@studio.example' })).toThrow(/`to`/);
    expect(() => setup({ to: '' })).toThrow(/`to`/);
  });
});
