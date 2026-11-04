/**
 * One chat turn over the Fetch API's Request and Response, with no framework and no model client.
 * The model call is a function passed in (`propose`), so this file never sees an API key; the
 * salon-assistant app wires it to the gateway. One call per turn, structured output, no streaming:
 * the card has to be a guaranteed shape, not something scraped out of a sentence.
 *
 * The order of the checks is the point. The history is verified before the model is called, the
 * model's booking goes through decide(), and the prose goes through the money guard before it is
 * signed and sent. Nothing the model writes reaches the visitor without one of those.
 */
import { z } from 'zod';
import { decide, type Card } from './decide.ts';
import { createHistorySigner, type Turn, type UserTurn } from './history.ts';
import { langFrom, type Lang } from './lang.ts';
import { cardInWords, garbled, moneyToEn, moneyVerdict, plainText, withoutControls } from './money-guard.ts';
import { SYSTEM_RULES } from './prompt.ts';
import { SALON, SALON_CONTEXT } from './salon.ts';

/* `booking` first, so the model commits to the structured decision before it writes the sentence
   that has to agree with it. The English schema is a separate object because the descriptions are
   part of the request. */
export const REPLY_SCHEMAS = {
  es: z.object({
    booking: z
      .object({
        service: z.string().describe('Exact service name, as written in the context'),
        stylist: z.string().nullable().describe('First name, or null if more than one person could take it'),
        date: z.string().describe('Date in YYYY-MM-DD'),
        time: z.string().nullable().describe('HH:MM only if the visitor named an hour; otherwise null'),
      })
      .nullable()
      .describe('Only when the visitor asked for an appointment and service + day are known'),
    reply: z.string().describe('What the assistant says, in rioplatense Spanish'),
  }),
  en: z.object({
    booking: z
      .object({
        service: z.string().describe('Exact English service name, as written in the price tables of the context'),
        stylist: z.string().nullable().describe('First name, or null if more than one person could take it'),
        date: z.string().describe('Date in YYYY-MM-DD'),
        time: z.string().nullable().describe('24-hour HH:MM (5:30 pm is 17:30), only if the visitor named an hour; otherwise null'),
      })
      .nullable()
      .describe('Only when the visitor asked for an appointment and service + day are known'),
    reply: z.string().describe('What the assistant says, in plain English'),
  }),
} as const;

export type ModelReply = z.output<(typeof REPLY_SCHEMAS)['es']>;

export interface ProposeInput {
  readonly lang: Lang;
  readonly schema: (typeof REPLY_SCHEMAS)[Lang];
  /** Rules and context first (stable, cacheable), then today's date and time. */
  readonly system: readonly [string, string];
  readonly messages: readonly [...Turn[], UserTurn];
  /** 1, or 2 for the single retry after a garbled reply. */
  readonly attempt: number;
}

/** Thrown by `propose` for a failure the visitor should see as "busy" or "unavailable". */
export class ModelUnavailable extends Error {
  readonly code: 'busy' | 'cap' | 'failed';
  constructor(code: 'busy' | 'cap' | 'failed') {
    super(`model unavailable: ${code}`);
    this.name = 'ModelUnavailable';
    this.code = code;
  }
}

export type ProposeReply = (input: ProposeInput) => Promise<ModelReply>;

export interface AssistantConfig {
  /** At least 32 bytes, of its own: not derived from the API key. */
  readonly historySecret: string | Uint8Array;
  readonly propose: ProposeReply;
  readonly now?: () => Date;
  /** The salon's zone, for "today" and "now". */
  readonly timeZone?: string;
  /** User turns per conversation. Default 8. */
  readonly maxTurns?: number;
  /** Characters of each turn the model reads. Default 600. */
  readonly maxChars?: number;
  /** Request bodies above this get 413. Default 24 KiB. */
  readonly maxBodyBytes?: number;
  /** Returns true when this client is over its limit. */
  readonly limited?: (clientAddress: string) => boolean;
}

export interface TurnResponse {
  readonly reply: string;
  readonly signature: string;
  readonly booking: Card | null;
  /** Why the model's booking was refused, when it was. */
  readonly bookingRejected?: string;
  /** True when a valid card was withdrawn because the prose failed the money guard. */
  readonly bookingWithdrawn?: true;
}

export type AssistantError =
  | 'method'
  | 'media_type'
  | 'too_large'
  | 'invalid_json'
  | 'history'
  | 'no_message'
  | 'turn_limit'
  | 'limited'
  | 'busy'
  | 'unavailable'
  | 'model_failed';

const APOLOGY: Record<Lang, string> = {
  es: `Prefiero no tirarte un número que no tengo cargado. Mirá la lista en ${SALON.site} o preguntame por un servicio puntual.`,
  en: `I'd rather not give you a figure I don't have loaded. Check the price list at ${SALON.site} or ask me about a specific service.`,
};
const NO_ADDRESSES: Record<Lang, string> = {
  es: `Escribime por acá lo que necesites, o mirá ${SALON.site}.`,
  en: `Message me here with whatever you need, or have a look at ${SALON.site}.`,
};

class TooLarge extends Error {}

async function readText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new TooLarge();
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/** "2026-11-04", the weekday and "HH:MM" in `timeZone`. */
export function salonClock(now: Date, timeZone: string, lang: Lang): { today: string; weekday: string; time: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-AR', { timeZone, weekday: 'long' }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return { today, weekday, time };
}

export function createAssistantHandler(config: AssistantConfig): (request: Request, context?: { clientAddress?: string }) => Promise<Response> {
  const signer = createHistorySigner(config.historySecret);
  const now = config.now ?? (() => new Date());
  const timeZone = config.timeZone ?? 'America/Argentina/Buenos_Aires';
  const maxTurns = config.maxTurns ?? 8;
  const maxChars = config.maxChars ?? 600;
  const maxBody = config.maxBodyBytes ?? 24 * 1024;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  // A failure carries `error` and never `reply`: a stray reply would be shown, and sent back, as
  // something the salon said.
  const fail = (error: AssistantError, status: number) => json({ error }, status);

  return async (request, context = {}) => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    // JSON only: a cross-site page can POST text/plain without a preflight.
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail('media_type', 415);
    if (config.limited?.(context.clientAddress || 'unknown')) return fail('limited', 429);

    let body: unknown;
    try {
      body = JSON.parse(await readText(request, maxBody));
    } catch (e) {
      return e instanceof TooLarge ? fail('too_large', 413) : fail('invalid_json', 400);
    }
    const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const lang = langFrom(rec['lang']);
    const incoming = Array.isArray(rec['messages']) ? (rec['messages'] as unknown[]) : [];

    // Every turn, exactly as received and signed. An unknown role or a non-string content is a
    // broken history, not something to filter out in silence.
    const received: Turn[] = [];
    for (const m of incoming) {
      const t = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
      const content = t['content'];
      if (typeof content !== 'string' || (t['role'] !== 'user' && t['role'] !== 'assistant')) return fail('history', 400);
      received.push(t['role'] === 'user' ? { role: 'user', content } : { role: 'assistant', content });
      if (t['role'] === 'assistant' && !signer.verify(received, t['signature'])) return fail('history', 400);
    }
    if (received.filter((t) => t.role === 'user').length > maxTurns) return fail('turn_limit', 400);

    // What the model reads: cut first, then trimmed, so 600 spaces and then text is nothing.
    const trimmed: Turn[] = received
      .map((t): Turn => ({ role: t.role, content: t.content.slice(0, maxChars).trim() }) as Turn)
      .filter((t) => t.content !== '');
    const last = trimmed[trimmed.length - 1];
    if (!last || last.role !== 'user') return fail('no_message', 400);
    const messages: readonly [...Turn[], UserTurn] = [...trimmed.slice(0, -1), last];

    const clock = salonClock(now(), timeZone, lang);
    const system: readonly [string, string] = [
      `${SYSTEM_RULES[lang]}\n\n===== BUSINESS CONTEXT =====\n${SALON_CONTEXT[lang]}`,
      lang === 'en'
        ? `Today is ${clock.weekday} (${clock.today}). It is ${clock.time}.`
        : `Hoy es ${clock.weekday} ${clock.today}. Son las ${clock.time}.`,
    ];
    const schema = REPLY_SCHEMAS[lang];

    let out: ModelReply;
    try {
      out = await config.propose({ lang, schema, system, messages, attempt: 1 });
      // A control character where an accent should be: one more try. The first reply is kept
      // when the retry throws or comes back garbled too; withoutControls mends whichever is used.
      if (garbled(out.reply)) {
        try {
          const second = await config.propose({ lang, schema, system, messages, attempt: 2 });
          if (!garbled(second.reply)) out = second;
        } catch {
          /* keep the first reply */
        }
      }
    } catch (e) {
      if (e instanceof ModelUnavailable) return e.code === 'busy' ? fail('busy', 429) : e.code === 'cap' ? fail('unavailable', 503) : fail('model_failed', 502);
      return fail('model_failed', 502);
    }

    let reply = withoutControls(plainText(out.reply));
    let card: Card | null = null;
    let rejected: string | undefined;
    if (out.booking) {
      const d = decide(out.booking, clock.today, lang, clock.time);
      if (d.ok) card = d.card;
      else {
        // The prose was written for a booking that is not happening.
        rejected = d.reason;
        reply = d.say;
      }
    }

    let withdrawn: true | undefined;
    const verdict = moneyVerdict(reply, card, lang);
    if (verdict === 'apology') {
      reply = APOLOGY[lang];
      if (card) withdrawn = true;
      card = null;
    } else {
      if (verdict === 'card' && card) reply = cardInWords(card, lang);
      if (lang === 'en') reply = moneyToEn(reply);
    }
    if (/\S+@\S+\.\S+/.test(reply)) reply = NO_ADDRESSES[lang];

    const signature = signer.sign([...received, { role: 'assistant', content: reply }]);
    const response: TurnResponse = {
      reply,
      signature,
      booking: card,
      ...(rejected ? { bookingRejected: rejected } : {}),
      ...(withdrawn ? { bookingWithdrawn: withdrawn } : {}),
    };
    return json(response);
  };
}
