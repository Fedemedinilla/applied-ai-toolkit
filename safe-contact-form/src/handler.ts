/**
 * A contact form endpoint over the Fetch API's Request and Response, with no framework.
 *
 * It sends two emails: the message to the site owner, and an acknowledgment to whoever wrote, so
 * they know it arrived. It stores nothing. The acknowledgment is the dangerous one: its recipient
 * and its content are both chosen by the visitor, and it leaves signed with the site's domain.
 * Without the cuts in sanitize.ts the form would deliver anyone's phishing text to anyone's
 * address under the site's name.
 */
import { createLimiter, type RateLimit } from './rate-limit.ts';
import { escapeHtml, greeting, htmlDocument, oneLine, paragraphs, quote } from './sanitize.ts';
import { fill, TEXTS, type Lang, type PageText, type Texts } from './texts.ts';
import type { MailTransport } from './transport.ts';

export interface FieldNames {
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly phone: string;
  readonly subject: string;
  /** Which page or button the visitor came from. */
  readonly source: string;
  readonly lang: string;
  /** The honeypot: hidden from people, filled by naive bots. */
  readonly trap: string;
  /** Milliseconds since the epoch, set by the page's script when the form rendered. */
  readonly renderedAt: string;
}

export const DEFAULT_FIELDS: FieldNames = {
  name: 'full_name',
  email: 'reply_email',
  message: 'body',
  phone: 'phone',
  subject: 'topic',
  source: 'page',
  lang: 'lang',
  trap: 'fax_number',
  renderedAt: 'rendered_at',
};

export interface ContactConfig {
  /** The owner's mailbox. Only the server knows it; no visitor-facing text prints it. */
  readonly to: string;
  /** The sender of both emails, on a domain verified with the provider. */
  readonly from: string;
  /**
   * Where a reply to the acknowledgment goes, and the address error pages print. A domain sender
   * with a free-mail Reply-To is a spam signal (FREEMAIL_FORGED_REPLYTO), so this should be on the
   * site's own domain.
   */
  readonly publicAddress: string;
  /** Used in the acknowledgment subject and its signature. */
  readonly siteName: string;
  /** Where the no-JS pages link back to, per language. */
  readonly homeUrl: Readonly<Record<Lang, string>>;
  /** Null when the provider key is missing: every send answers 503 and nothing claims success. */
  readonly transport: MailTransport | null;
  readonly fields?: Partial<FieldNames>;
  readonly defaultLang?: Lang;
  /** A submit faster than this after render is a bot, answered as a success and dropped. Default 2,500 ms. */
  readonly minFillMs?: number;
  /** Accepted sends per IP. Default 5 in 15 minutes. */
  readonly rateLimit?: RateLimit;
  /** Characters of the message quoted in the acknowledgment. Default 300. */
  readonly quoteMax?: number;
  /** Characters of the name used as a greeting. Default 32. */
  readonly greetingMax?: number;
  /** Origins accepted besides the request's own, such as the production URL in a preview. */
  readonly allowedOrigins?: readonly string[];
  /** Read X-Forwarded-Host and X-Forwarded-Proto to rebuild the public origin. Default true. */
  readonly trustForwardedHeaders?: boolean;
  /** Request bodies above this many bytes get 413. Default 32 KiB. */
  readonly maxBodyBytes?: number;
  readonly sendAcknowledgment?: boolean;
  readonly texts?: Partial<Record<Lang, Texts>>;
  readonly now?: () => number;
  /** Events carry a code and nothing the visitor wrote. */
  readonly log?: (event: ContactEvent) => void;
}

export type ContactEvent =
  | { readonly kind: 'dropped'; readonly reason: 'trap' | 'too_fast' }
  | { readonly kind: 'rejected'; readonly reason: 'origin' | 'invalid' | 'limited' | 'too_large' | 'media_type' }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'sent'; readonly acknowledged: boolean }
  | { readonly kind: 'ack_failed' }
  | { readonly kind: 'send_failed' };

export interface RequestContext {
  /** The client IP as the platform reports it. */
  readonly clientAddress?: string;
}

export type ContactHandler = (request: Request, context?: RequestContext) => Promise<Response>;

/**
 * One address, nothing else. No comma or semicolon: providers read `to` as a list, so
 * `me@mine.example,victim@other.example` would pass a classic pattern and turn the
 * acknowledgment into a relay. No angle brackets, quotes or parentheses either, which a
 * provider could read as a display name.
 */
export const EMAIL = /^[^@\s,;<>"'()\\]+@[^@\s,;<>"'()\\]+\.[^@\s,;<>"'()\\]+$/;

type ErrorCode = 'origin' | 'invalid' | 'limited' | 'not_configured' | 'send_failed' | 'too_large' | 'media_type' | 'method';

class BodyTooLarge extends Error {}

async function readText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The origins this request counts as its own. */
export function ownOrigins(request: Request, trustForwarded: boolean, extra: readonly string[]): Set<string> {
  const url = new URL(request.url);
  const own = new Set<string>([url.origin, ...extra.map((o) => o.replace(/\/$/, ''))]);
  const host = request.headers.get('host');
  if (host) own.add(`${url.protocol}//${host}`);
  if (trustForwarded) {
    // A proxy chain can append: "public.example, internal:8080". The first one is the client's.
    const fHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const fProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
    if (fHost) own.add(`${fProto}://${fHost}`);
  }
  return own;
}

export function createContactHandler(config: ContactConfig): ContactHandler {
  if (!EMAIL.test(config.to)) throw new Error('safe-contact-form: `to` must be one email address');
  if (!config.from) throw new Error('safe-contact-form: `from` is required');
  if (!EMAIL.test(config.publicAddress)) throw new Error('safe-contact-form: `publicAddress` must be one email address');
  const fields: FieldNames = { ...DEFAULT_FIELDS, ...config.fields };
  const now = config.now ?? Date.now;
  const limited = createLimiter(config.rateLimit ?? { max: 5, windowMs: 15 * 60_000 }, now);
  const minFill = config.minFillMs ?? 2_500;
  const quoteMax = config.quoteMax ?? 300;
  const greetingMax = config.greetingMax ?? 32;
  const maxBody = config.maxBodyBytes ?? 32 * 1024;
  const log = config.log ?? (() => {});
  const textsFor = (lang: Lang): Texts => config.texts?.[lang] ?? TEXTS[lang];

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  /** The page a browser without JavaScript lands on. Same template for success and errors. */
  const page = (lang: Lang, key: keyof Texts['pages'], status: number) => {
    const t = textsFor(lang);
    const p: PageText = t.pages[key];
    const body = fill(p.body, { address: config.publicAddress });
    const html =
      `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
      '<meta name="color-scheme" content="light dark">' +
      `<title>${escapeHtml(p.title)}</title><style>` +
      ':root{--bg:#fff;--fg:#161616;--muted:#4a4a4a;--focus:#0b57d0}' +
      '@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#f2f2f2;--muted:#c4c4c4;--focus:#8ab4f8}}' +
      'body{background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 16px}' +
      'h1{font-size:1.5rem;margin:0 0 12px}p{margin:0 0 24px;color:var(--muted)}a{color:var(--fg)}' +
      'a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}' +
      `</style></head><body><main><h1>${escapeHtml(p.title)}</h1><p role="status">${escapeHtml(body)}</p>` +
      `<a href="${escapeHtml(config.homeUrl[lang])}">${escapeHtml(t.back)}</a></main></body></html>`;
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  };

  const PAGE_FOR: Record<ErrorCode, keyof Texts['pages']> = {
    origin: 'forbidden',
    invalid: 'invalid',
    limited: 'limited',
    not_configured: 'unavailable',
    send_failed: 'unavailable',
    too_large: 'invalid',
    media_type: 'invalid',
    method: 'invalid',
  };

  return async (request, context = {}) => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });

    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    const isJson = type.startsWith('application/json');
    const isForm = type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data');
    let lang: Lang = config.defaultLang ?? 'en';
    const fail = (code: ErrorCode, status: number) => (isJson ? json({ ok: false, error: code }, status) : page(lang, PAGE_FOR[code], status));
    const success = (acknowledged: boolean) => (isJson ? json({ ok: true, acknowledged }) : page(lang, 'ok', 200));

    if (!isJson && !isForm) {
      log({ kind: 'rejected', reason: 'media_type' });
      return fail('media_type', 415);
    }

    // Read before the origin check so the no-JS error page can be in the visitor's language.
    const data = new Map<string, string>();
    try {
      const raw = await readText(request, maxBody);
      if (isJson) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* an unreadable body has no fields, and fails validation below */
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' || typeof v === 'number') data.set(k, String(v));
        }
      } else {
        const form = await new Response(raw, { headers: { 'content-type': type } }).formData().catch(() => null);
        form?.forEach((v, k) => {
          if (typeof v === 'string' && !data.has(k)) data.set(k, v);
        });
      }
    } catch (e) {
      if (!(e instanceof BodyTooLarge)) throw e;
      log({ kind: 'rejected', reason: 'too_large' });
      return fail('too_large', 413);
    }
    const g = (key: keyof FieldNames, max = 5000) => (data.get(fields[key]) ?? '').trim().slice(0, max);
    const requested = g('lang', 5);
    if (requested === 'en' || requested === 'es') lang = requested;

    // A browser always sends Origin on a cross-site POST, with or without JavaScript. When it is
    // missing (an old client, a script), the trap, the clock and the limit still apply.
    const origin = request.headers.get('origin');
    if (origin !== null && !ownOrigins(request, config.trustForwardedHeaders ?? true, config.allowedOrigins ?? []).has(origin)) {
      log({ kind: 'rejected', reason: 'origin' });
      return fail('origin', 403);
    }

    // The trap and the clock answer success and send nothing: a bot that sees an error retries
    // with the field empty.
    if (g('trap')) {
      log({ kind: 'dropped', reason: 'trap' });
      return success(true);
    }
    // renderedAt comes from the visitor's clock and is compared with the server's. A clock a few
    // seconds ahead gives a negative delta, which is skew, not a bot: the source once dropped every
    // message from such a visitor while telling them it had arrived. Without the field (no JS) the
    // clock is not judged.
    const rendered = Number(g('renderedAt', 20));
    const elapsed = now() - rendered;
    if (Number.isFinite(rendered) && rendered > 0 && elapsed >= 0 && elapsed < minFill) {
      log({ kind: 'dropped', reason: 'too_fast' });
      return success(true);
    }

    const name = oneLine(g('name')).slice(0, 100);
    const email = g('email', 200);
    const phone = oneLine(g('phone')).slice(0, 40);
    const message = g('message');
    const source = oneLine(g('source')).slice(0, 60);
    const subject = oneLine(g('subject')).slice(0, 90);
    if (!name || email.length > 160 || !EMAIL.test(email) || message.length < 2) {
      log({ kind: 'rejected', reason: 'invalid' });
      return fail('invalid', 400);
    }

    // After validation, so a typo does not spend one of the visitor's sends.
    if (limited(context.clientAddress || 'unknown')) {
      log({ kind: 'rejected', reason: 'limited' });
      return fail('limited', 429);
    }

    // No key, no fake success. A visitor told "received" waits for a reply that never comes; an
    // error shows them the address that does work.
    const transport = config.transport;
    if (!transport) {
      log({ kind: 'not_configured' });
      return fail('not_configured', 503);
    }

    // 1) The message, to the owner, whole. Replying from the mail client answers the visitor.
    const subjectLine = oneLine(`${subject || `Contact form, ${config.siteName}`} · ${name}${source ? ` (${source})` : ''}`);
    const detail =
      `<p style="margin:0 0 4px"><strong>${escapeHtml(name)}</strong> · ${escapeHtml(email)}` +
      `${phone ? ` · ${escapeHtml(phone)}` : ''}</p>` +
      `<p style="margin:0 0 18px;color:#666;font-size:13px">${escapeHtml(source || 'no page')} · ${lang}</p>${paragraphs(message)}`;
    try {
      await transport.send({
        from: config.from,
        to: config.to,
        replyTo: email,
        subject: subjectLine,
        html: htmlDocument(detail, lang, subjectLine),
        text: `${name} <${email}>${phone ? ` · ${phone}` : ''}\n${source || 'no page'} · ${lang}\n\n${message}\n`,
      });
    } catch {
      log({ kind: 'send_failed' });
      return fail('send_failed', 502);
    }

    // 2) The acknowledgment, after: if it fails, the owner already has the message.
    let acknowledged = false;
    if (config.sendAcknowledgment ?? true) {
      const t = textsFor(lang).ack;
      const hi = greeting(name, greetingMax, '');
      const hello = hi ? fill(t.hello, { name: hi }) : t.helloNoName;
      const quoted = quote(message, quoteMax, t.linkPlaceholder);
      const ackSubject = fill(t.subject, { site: config.siteName });
      const html =
        `<p style="margin:0 0 14px">${escapeHtml(hello)}</p><p style="margin:0 0 14px">${escapeHtml(t.received)}</p>` +
        `<p style="margin:0 0 6px;color:#666;font-size:14px">${escapeHtml(t.copy)}</p>` +
        `<blockquote style="margin:0 0 18px;padding-left:14px;border-left:3px solid #999;color:#444">${paragraphs(quoted)}</blockquote>` +
        `<p style="margin:0">${escapeHtml(config.siteName)}</p>`;
      try {
        await transport.send({
          from: config.from,
          to: email,
          replyTo: config.publicAddress,
          subject: ackSubject,
          html: htmlDocument(html, lang, ackSubject),
          text: `${hello}\n\n${t.received}\n\n${t.copy}\n\n${quoted}\n\n${config.siteName}\n`,
        });
        acknowledged = true;
      } catch {
        log({ kind: 'ack_failed' });
      }
    }
    log({ kind: 'sent', acknowledged });
    return success(acknowledged);
  };
}
