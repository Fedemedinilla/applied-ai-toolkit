// The endpoint of model mode, framework-free: a Request goes in, a Response comes out, so it runs
// under any host that speaks the fetch API (dev-server.ts wraps it for node:http).
//
//   GET  /api/health   200 {"ok": true} when a key is configured, 503 {"ok": false} otherwise.
//   POST /api/extract  {sentence, today, timezone} -> 200 {"reading": ModelReading}, or an error
//                      code: bad_request (400), unsupported_media_type (415, any content type
//                      but application/json), cap_reached (503), model_unavailable (503),
//                      model_unusable (502), server_error (500).
//
// The handler returns what the model read and nothing more. The verdict (verdict.ts) runs in the
// browser, next to the parser, so the amount never comes from this server. Responses carry codes,
// never the sentence or the model's text in an error, and are marked no-store.

import { z } from 'zod';
import { ApiError, CapError, GatewayError, ResponseError, type Gateway } from '../../../gateway/src/index.ts';
import { dayNumber } from '../src/verdict.ts';
import { MAX_TOKENS, TASK } from './model.ts';
import { asReading, Extraction, MAX_SENTENCE, PROMPT_VERSION, SYSTEM_PROMPT, userMessage } from './prompt.ts';

/**
 * A body past this is not a sentence from the till. A declared content-length past it is refused
 * unread, and a body sent without one is read only until it passes the limit, then cancelled.
 */
export const MAX_BODY_BYTES = 2048;

const Body = z.strictObject({
  sentence: z.string().trim().min(1).max(MAX_SENTENCE),
  today: z.string().refine((s) => dayNumber(s) !== null),
  timezone: z.string().min(1).max(64),
});

export interface HandlerDeps {
  /** Null when no key is configured: health says so and extract answers 503 without trying. */
  readonly gateway: Gateway | null;
  readonly now: () => Date;
  /** One line per failure, with a code and never the sentence. */
  readonly log?: (event: string, data: Readonly<Record<string, string | number | boolean | null>>) => void;
}

export type Handler = (request: Request) => Promise<Response>;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

const error = (status: number, code: string, detail?: string): Response => reply(status, detail ? { error: code, detail } : { error: code });

/** The calendar day at `now` in `zone`, as YYYY-MM-DD; null for a zone Intl does not know. */
export function dayIn(now: Date, zone: string): string | null {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return null;
  }
}

/** The body as text, or null past MAX_BODY_BYTES. Stops reading at the limit, whatever the headers say. */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBody(request: Request): Promise<unknown> {
  const text = await readCapped(request);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Only application/json is read. A cross-origin page can send text/plain from a visitor's browser
 * with no CORS preflight; requiring JSON forces one, which that page cannot pass, so other sites
 * cannot spend the monthly cap through the visitors they get.
 */
function isJson(request: Request): boolean {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

export function createHandler(deps: HandlerDeps): Handler {
  const log = deps.log ?? (() => undefined);

  async function extract(request: Request, gateway: Gateway): Promise<Response> {
    const parsed = Body.safeParse(await readBody(request));
    if (!parsed.success) return error(400, 'bad_request', parsed.error.issues.map((i) => i.path.join('.') || '(body)').join(','));
    const { sentence, today, timezone } = parsed.data;
    // The browser sends its own day so "ayer" means the owner's yesterday. A device whose clock is
    // more than a day off would date every row wrong, so its day must match the server's in that
    // zone, give or take one day for midnight and clock drift.
    const serverDay = dayIn(deps.now(), timezone);
    if (serverDay === null) return error(400, 'bad_request', 'timezone');
    const drift = Math.abs((dayNumber(today) ?? 0) - (dayNumber(serverDay) ?? 0));
    if (drift > 1) return error(400, 'bad_request', 'today');

    try {
      const { data } = await gateway.structured(Extraction, {
        task: TASK,
        userId: null,
        promptVersion: PROMPT_VERSION,
        maxTokens: MAX_TOKENS,
        system: [SYSTEM_PROMPT],
        messages: [{ role: 'user', content: userMessage(sentence, today, timezone) }],
        signal: request.signal,
      });
      return reply(200, { reading: asReading(data) });
    } catch (e) {
      if (e instanceof CapError) {
        log('extract_failed', { code: e.code, spentUsd: e.spentUsd, capUsd: e.capUsd });
        return error(503, 'cap_reached');
      }
      if (e instanceof ApiError) {
        log('extract_failed', { code: e.code, retryable: e.retryable, status: e.status });
        if (e.retryable) return reply(503, { error: 'model_unavailable' }, e.retryAfterSec !== null ? { 'retry-after': String(e.retryAfterSec) } : {});
        return error(500, 'server_error');
      }
      if (e instanceof ResponseError) {
        // Refused, cut at max_tokens, or output that failed the schema. Billed and in the ledger;
        // the browser shows the offline reading.
        log('extract_failed', { code: e.code });
        return error(502, 'model_unusable');
      }
      log('extract_failed', { code: e instanceof GatewayError ? e.code : 'unexpected' });
      return error(500, 'server_error');
    }
  }

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/api/health')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'method_not_allowed');
      return reply(deps.gateway ? 200 : 503, { ok: deps.gateway !== null });
    }
    if (path.endsWith('/api/extract')) {
      if (request.method !== 'POST') return error(405, 'method_not_allowed');
      if (!isJson(request)) return error(415, 'unsupported_media_type');
      if (!deps.gateway) return error(503, 'model_unavailable');
      return extract(request, deps.gateway);
    }
    return error(404, 'not_found');
  };
}
