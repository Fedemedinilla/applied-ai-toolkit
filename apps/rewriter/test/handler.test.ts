// The endpoint, driven through prose-rewriter's rewrite(), the real gateway and the real Anthropic
// SDK client against a fake HTTP API (fake-anthropic.ts). No key, no network.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeLines, REWRITE_CAPS, RewriteResult, splitSentences, TASK_CONFIGS } from '../../../prose-rewriter/src/index.ts';
import { apiKeyFromEnv } from '../server/env.ts';
import type { GlobalCaps } from '../../../gateway/src/index.ts';
import { createHandler, type Handler } from '../server/handler.ts';
import { createRewriterModel } from '../server/model.ts';
import { loadRefs } from '../server/refs.ts';
import { MAX_BODY_BYTES, MAX_CV_CHARS, MAX_FIELD_CHARS, MAX_KEEP, MAX_KEEP_CHARS, MAX_PREVIOUS_CHARS, MAX_TEXT_CHARS } from '../src/protocol.ts';
import { asReply } from '../src/result.ts';
import { answer, apiError, fakeAnthropic, type FakeAnthropic, type Reply } from './fake-anthropic.ts';

// After the registry's prices take effect (2026-11-03).
const NOW = new Date('2026-11-16T15:00:00.000Z');
const clock = { now: () => NOW, monotonicMs: () => 0 };
const refs = loadRefs();

/** The fictional CV of the evals, plus one line no other text has, to look for in logs and errors. */
const CV_MARK = 'Curso de cerámica en el Taller Azulejo Imaginario';
const CV = `${readFileSync(new URL('../../../prose-rewriter/evals/cases/cv/es-rioplatense.md', import.meta.url), 'utf8')}\n- ${CV_MARK}.\n`;

const TEXT = 'Hola Marta,\n\nEspero que este mensaje te encuentre muy bien. Rehice el sitio de la Panadería Los Álamos en Astro y ahora carga en 1,6 s.\n\nSaludos,\nValeria';
const FORMULA = 'Espero que este mensaje te encuentre muy bien. ';
// The edit quotes the sentence without its trailing space, so the space stays, as in the real rewrites.
const EXPECTED = TEXT.replace(FORMULA.trim(), '');

const sentenceOf = (quote: string): number => {
  const s = splitSentences(TEXT, 'es').find((x) => x.text.includes(quote.trim()));
  if (s === undefined) throw new Error('no sentence');
  return s.id;
};
const EDIT = answer(JSON.stringify({ edits: [{ sentenceId: sentenceOf(FORMULA), before: FORMULA.trim(), after: '', reason: 'Fórmula de apertura.', ruleId: 'LEX-01' }] }));
const verdict = (rewritten: string): Reply =>
  answer(JSON.stringify({ lines: judgeLines(rewritten, 'es').map((l) => ({ line: l.line, support: 'no-claim', note: '' })), note: '' }));

const BODY = { text: TEXT, genre: 'email', lang: 'es', variety: 'rioplatense', recipient: { name: 'Marta' }, cv: CV };

interface Setup {
  handler: Handler;
  api: FakeAnthropic;
  stores: ReturnType<typeof createRewriterModel>['stores'];
  logged: Array<{ event: string; data: Readonly<Record<string, unknown>> }>;
  gatewayLines: string[];
}

function setup(replies: readonly Reply[], caps?: GlobalCaps): Setup {
  const api = fakeAnthropic(replies);
  const gatewayLines: string[] = [];
  const { gateway, stores } = createRewriterModel({ apiKey: 'sk-fake', fetch: api.fetch, clock, log: (line) => gatewayLines.push(line), ...(caps ? { caps } : {}) });
  const logged: Setup['logged'] = [];
  const handler = createHandler({ gateway, refs, log: (event, data) => logged.push({ event, data }) });
  return { handler, api, stores, logged, gatewayLines };
}

const post = (body: unknown, init: { raw?: boolean; headers?: Record<string, string> } = {}): Request =>
  new Request('http://rewriter.test/api/rewrite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.raw ? String(body) : JSON.stringify(body),
  });

describe('health', () => {
  it('answers ok with a key, 503 without one, and the rewrite endpoint says unavailable', async () => {
    const { handler } = setup([]);
    const up = await handler(new Request('http://rewriter.test/api/health'));
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ ok: true });
    expect(up.headers.get('cache-control')).toBe('no-store');

    const off = createHandler({ gateway: null, refs });
    const down = await off(new Request('http://rewriter.test/api/health'));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false });
    const res = await off(post(BODY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'model_unavailable' });
  });

  it('works under a subpath and refuses other methods and paths', async () => {
    const { handler } = setup([]);
    expect((await handler(new Request('http://rewriter.test/apps/rewriter/api/health'))).status).toBe(200);
    expect((await handler(new Request('http://rewriter.test/api/health', { method: 'HEAD' }))).status).toBe(200);
    expect((await handler(new Request('http://rewriter.test/api/health', { method: 'POST' }))).status).toBe(405);
    expect((await handler(new Request('http://rewriter.test/api/rewrite'))).status).toBe(405);
    expect((await handler(new Request('http://rewriter.test/api/other'))).status).toBe(404);
  });

  it('reads the key from the environment only when it is set and not blank', () => {
    expect(apiKeyFromEnv({})).toBeNull();
    expect(apiKeyFromEnv({ ANTHROPIC_API_KEY: '  ' })).toBeNull();
    expect(apiKeyFromEnv({ ANTHROPIC_API_KEY: ' sk-x ' })).toBe('sk-x');
  });
});

describe('a rewrite', () => {
  it('runs the default strategy through the gateway: one edit call and the fact judge, priced', async () => {
    const { handler, api, stores } = setup([EDIT, verdict(EXPECTED)]);
    const res = await handler(post(BODY));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { original: string; result: unknown };
    expect(RewriteResult.safeParse(body.result).success).toBe(true);
    const reply = asReply(body);
    expect(reply).not.toBeNull();
    expect(reply?.original).toBe(TEXT.normalize('NFC'));
    expect(reply?.result.rewritten).toBe(EXPECTED);
    expect(reply?.result.status).toBe('ok');
    expect(reply?.result.changes).toHaveLength(1);
    expect(reply?.result.usage.calls).toBe(2);
    expect(reply?.result.usage.costUsd).toBeGreaterThan(0);
    // The edit on the writing model, the judge on another, as prose-rewriter's task configs say.
    expect(api.requests.map((r) => r.body['model'])).toEqual([TASK_CONFIGS['rewrite.edit'].model, TASK_CONFIGS['rewrite.judge'].model]);
    expect(api.left).toBe(0);
    // The CV reached the API inside the prompt: that is where it goes, and nowhere else.
    expect(JSON.stringify(api.requests[0]?.body)).toContain(CV_MARK);
    const rows = stores.usage.calls;
    expect(rows.map((r) => r.task)).toEqual(['rewrite.edit', 'rewrite.judge']);
    expect(new Set(rows.map((r) => r.jobId)).size).toBe(1);
    expect(rows[0]?.jobId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('gives each rewrite its own job id, so the per-job cap binds per rewrite', async () => {
    const { handler, stores } = setup([EDIT, verdict(EXPECTED), EDIT, verdict(EXPECTED)]);
    expect((await handler(post(BODY))).status).toBe(200);
    expect((await handler(post(BODY))).status).toBe(200);
    const rows = stores.usage.calls;
    expect(new Set(rows.map((r) => r.jobId)).size).toBe(2);
  });

  it('answers a WhatsApp with nothing to change with no model call (S1b)', async () => {
    const { handler, api } = setup([]);
    const text = 'Hola Marta, ya está el sitio de la panadería. ¿Lo vemos el jueves?';
    const res = await handler(post({ text, genre: 'whatsapp', lang: 'es', cv: CV }));
    expect(res.status).toBe(200);
    const reply = asReply(await res.json());
    expect(reply?.result).toMatchObject({ rewritten: text, changes: [], usage: { calls: 0 } });
    expect(api.requests).toHaveLength(0);
  });

  it('passes the recipient, the previous message, the mode, the register and the keep phrases through', async () => {
    const { handler, api } = setup([EDIT, verdict(EXPECTED)]);
    const res = await handler(
      post({ ...BODY, genre: 'follow-up', mode: 'pulido', register: 'neutral', keep: ['Saludos,'], recipient: { name: 'Marta', org: 'Vivero El Ombú', role: 'Dueña', previousMessage: 'Hola Marta, te mandé la propuesta.' } }),
    );
    expect(res.status).toBe(200);
    const prompt = JSON.stringify(api.requests[0]?.body);
    expect(prompt).toContain('Vivero El Ombú');
    expect(prompt).toContain('te mandé la propuesta');
    expect(prompt).toContain('Saludos,');
  });

  it('keeps a new line in a Spanish text in the original it sends back', async () => {
    const { handler } = setup([EDIT, verdict(EXPECTED)]);
    const reply = asReply(await (await handler(post(BODY))).json());
    expect(reply?.original.split('\n')).toHaveLength(TEXT.split('\n').length);
  });
});

describe('the request body', () => {
  const long = (n: number) => 'a'.repeat(n);
  const cases: Array<[string, unknown, string]> = [
    ['no text', { ...BODY, text: undefined }, 'text'],
    ['an empty text', { ...BODY, text: '   ' }, 'text'],
    ['a text over the limit', { ...BODY, text: long(MAX_TEXT_CHARS + 1) }, 'text'],
    ['no CV', { ...BODY, cv: undefined }, 'cv'],
    ['an empty CV', { ...BODY, cv: '' }, 'cv'],
    ['a CV over the limit', { ...BODY, cv: long(MAX_CV_CHARS + 1) }, 'cv'],
    ['an unknown genre', { ...BODY, genre: 'memo' }, 'genre'],
    ['an unknown language', { ...BODY, lang: 'pt' }, 'lang'],
    ['a variety with English', { ...BODY, lang: 'en', variety: 'rioplatense' }, 'variety'],
    ['an unknown variety', { ...BODY, variety: 'iberian' }, 'variety'],
    ['an unknown register', { ...BODY, register: 'royal' }, 'register'],
    ['an unknown mode', { ...BODY, mode: 'max' }, 'mode'],
    ['too many keep phrases', { ...BODY, keep: Array.from({ length: MAX_KEEP + 1 }, (_, i) => `frase ${i}`) }, 'keep'],
    ['a keep phrase over the limit', { ...BODY, keep: [long(MAX_KEEP_CHARS + 1)] }, 'keep'],
    ['an empty keep phrase', { ...BODY, keep: [''] }, 'keep'],
    ['a recipient field over the limit', { ...BODY, recipient: { name: long(MAX_FIELD_CHARS + 1) } }, 'recipient'],
    ['a previous message over the limit', { ...BODY, recipient: { previousMessage: long(MAX_PREVIOUS_CHARS + 1) } }, 'recipient'],
    ['an unknown recipient field', { ...BODY, recipient: { email: 'a@b.example' } }, 'recipient'],
    // An unknown key is reported as the body, never by its name.
    ['a profile object instead of cv', { ...BODY, cv: undefined, profile: { cvMarkdown: CV } }, '(body),cv'],
    ['an option the page does not send', { ...BODY, strict: true }, '(body)'],
    ['a strategy', { ...BODY, strategy: 'staged' }, '(body)'],
    ['an array', [BODY], '(body)'],
    ['a string', 'hola', '(body)'],
  ];

  it.each(cases)('refuses %s with a 400 naming the field, and calls nothing', async (_, body, field) => {
    const { handler, api } = setup([]);
    const res = await handler(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', detail: field });
    expect(api.requests).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    const { handler, api } = setup([]);
    const res = await handler(post('{"text": "hola"', { raw: true }));
    expect(res.status).toBe(400);
    expect(api.requests).toHaveLength(0);
  });

  it('refuses a text/plain post and a cross-site one, with no call', async () => {
    const { handler, api } = setup([]);
    const plain = await handler(new Request('http://rewriter.test/api/rewrite', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(BODY) }));
    expect(plain.status).toBe(415);
    const cross = await handler(post(BODY, { headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(cross.status).toBe(403);
    const same = await handler(post({ ...BODY, text: '' }, { headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(same.status).toBe(400);
    expect(api.requests).toHaveLength(0);
  });

  it('refuses a declared Content-Length over the limit without reading the body', async () => {
    const { handler } = setup([]);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const req = new Request('http://rewriter.test/api/rewrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const res = await handler(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('cancels a chunked body once it passes the limit', async () => {
    const { handler } = setup([]);
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x61));
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request('http://rewriter.test/api/rewrite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    const res = await handler(req);
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled * 16 * 1024).toBeLessThan(MAX_BODY_BYTES + 3 * 16 * 1024);
  });
});

describe('failures', () => {
  it('passes a 529 on as model_unavailable with its retry-after, and logs a code only', async () => {
    const { handler, logged, gatewayLines } = setup([apiError(529, 'overloaded_error', { 'retry-after': '7' })]);
    const res = await handler(post(BODY));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(await res.json()).toEqual({ error: 'model_unavailable' });
    expect(logged).toEqual([{ event: 'rewrite_failed', data: { code: 'overloaded', retryable: true, status: 529 } }]);
  });

  it('answers a 401 as server_error', async () => {
    const { handler } = setup([apiError(401, 'authentication_error')]);
    const res = await handler(post(BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
  });

  it('answers cap_reached once the month is spent, and the next rewrite sends nothing', async () => {
    const { handler, api, logged } = setup([EDIT], { ...REWRITE_CAPS, monthlyUsd: 0.001 });
    // The edit call spends past the cap; the judge's call is refused before it leaves.
    const first = await handler(post(BODY));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'cap_reached' });
    expect(api.requests).toHaveLength(1);
    const second = await handler(post(BODY));
    expect(second.status).toBe(503);
    expect(api.requests).toHaveLength(1);
    expect(logged.map((l) => l.data['code'])).toEqual(['cap_monthly_global', 'cap_monthly_global']);
  });

  it('never puts the CV or the text in a log line or an error body', async () => {
    const seen: string[] = [];
    for (const replies of [[apiError(529, 'overloaded_error')], [apiError(401, 'authentication_error')], [apiError(400, 'invalid_request_error')]]) {
      const { handler, logged, gatewayLines } = setup(replies);
      const res = await handler(post(BODY));
      seen.push(await res.text(), ...logged.map((l) => JSON.stringify(l)), ...gatewayLines);
    }
    const bad = setup([]);
    seen.push(await (await bad.handler(post({ ...BODY, lang: 'en', variety: 'neutral' }))).text());
    seen.push(await (await bad.handler(post({ ...BODY, text: 'x'.repeat(MAX_TEXT_CHARS + 1) }))).text());
    const all = seen.join('\n');
    expect(all).not.toContain(CV_MARK);
    expect(all).not.toContain('Valeria Sosa');
    expect(all).not.toContain('Panadería');
    expect(all).not.toContain('Marta');
  });
});
