// A fetch function that answers like Resend's POST /emails: 200 with { id } for a valid request,
// 401 without the bearer key, 422 with { statusCode, name, message } for a missing field, and a
// scripted failure for chosen calls. It records every body it accepted or refused.

export interface Sent {
  readonly from: string;
  readonly to: string;
  readonly reply_to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface FakeResend {
  readonly fetch: typeof fetch;
  /** Bodies of accepted requests, in order. */
  readonly sent: Sent[];
  /** Every request, accepted or not. */
  readonly calls: Array<{ url: string; auth: string | null; body: unknown }>;
  /** Makes call number `n` (1-based, counting every call) fail with this answer. */
  failCall(n: number, answer: 'validation' | 'forbidden' | 'network' | 'no-id' | 'not-json'): void;
}

export const FAKE_KEY = 're_test_fake_key';

export function fakeResend(): FakeResend {
  const sent: Sent[] = [];
  const calls: FakeResend['calls'] = [];
  const failures = new Map<number, string>();
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body: unknown = JSON.parse(String(init?.body ?? 'null'));
    calls.push({ url, auth: headers.get('authorization'), body });
    const failure = failures.get(calls.length);
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure === 'validation') return reply(422, { statusCode: 422, name: 'validation_error', message: `echo: ${JSON.stringify(body)}` });
    if (failure === 'forbidden') return reply(403, { statusCode: 403, name: 'validation_error', message: 'The domain is not verified.' });
    if (failure === 'no-id') return reply(200, {});
    if (failure === 'not-json') return new Response('<html>bad gateway</html>', { status: 502 });
    if (!url.endsWith('/emails') || init?.method !== 'POST') return reply(404, { statusCode: 404, name: 'not_found', message: 'Not found' });
    if (headers.get('authorization') !== `Bearer ${FAKE_KEY}`) return reply(401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' });
    const b = body as Record<string, unknown>;
    for (const k of ['from', 'to', 'subject']) {
      if (typeof b[k] !== 'string' || b[k] === '') return reply(422, { statusCode: 422, name: 'missing_required_field', message: `Missing ${k}` });
    }
    sent.push(b as unknown as Sent);
    return reply(200, { id: `email-${sent.length}` });
  };
  return {
    fetch: f as typeof fetch,
    sent,
    calls,
    failCall(n, answer) {
      failures.set(n, answer);
    },
  };
}
