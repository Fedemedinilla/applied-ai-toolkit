/**
 * The mail transport is an interface, so the handler never imports a provider SDK. The one
 * adapter here speaks Resend's HTTP API with fetch; tests pass a fake fetch with the same shape.
 */

export interface MailMessage {
  readonly from: string;
  /** Exactly one address. The handler never passes a list. */
  readonly to: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface MailTransport {
  /** Resolves with the provider's id once the provider accepted the message; throws otherwise. */
  send(message: MailMessage): Promise<{ id: string }>;
}

export class TransportError extends Error {
  readonly status: number | null;
  readonly providerCode: string | null;
  constructor(message: string, status: number | null, providerCode: string | null) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

export interface ResendOptions {
  readonly apiKey: string;
  /** Defaults to https://api.resend.com. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Per request. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

/**
 * A transport over `POST /emails`. A non-2xx answer or a body without an `id` throws.
 *
 * The source used the Resend SDK, which returns `{ error }` instead of throwing. Two paths read
 * the result as success: an unverified sender and a key without permission both told the visitor
 * "got it" with the message nowhere. Throwing here leaves no result to misread.
 */
export function resendTransport({ apiKey, baseUrl = 'https://api.resend.com', fetch: f = fetch, timeoutMs = 10_000 }: ResendOptions): MailTransport {
  if (!apiKey) throw new Error('safe-contact-form: resendTransport needs an apiKey');
  const url = `${baseUrl.replace(/\/$/, '')}/emails`;
  return {
    async send(m) {
      const res = await f(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: m.from, to: m.to, reply_to: m.replyTo, subject: m.subject, html: m.html, text: m.text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body: unknown = await res.json().catch(() => null);
      const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      if (!res.ok) {
        // The provider's message can echo the request, so only its code is kept.
        const code = typeof rec['name'] === 'string' ? rec['name'] : null;
        throw new TransportError(`mail provider answered ${res.status}`, res.status, code);
      }
      if (typeof rec['id'] !== 'string' || rec['id'] === '') throw new TransportError('mail provider answered without an id', res.status, null);
      return { id: rec['id'] };
    },
  };
}
