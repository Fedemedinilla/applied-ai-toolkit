// The rewriter's endpoint, framework-free: a Request goes in, a Response comes out, so it runs under
// any host that speaks the fetch API (dev-server.ts wraps it for node:http).
//
//   GET  /api/health   200 {"ok": true} when a key is configured, 503 {"ok": false} otherwise.
//   POST /api/rewrite  {text, genre, lang, variety?, register?, mode?, recipient?, keep?, cv}
//                      -> 200 {original, result}: the text as the rewriter read it (NFC), which
//                         every span of the result points into, and prose-rewriter's RewriteResult;
//                      or an error code: bad_request (400), forbidden (403), too_large (413),
//                      unsupported_media_type (415), cap_reached (503), model_unavailable (503),
//                      model_unusable (502), server_error (500).
//
// The body is a strict zod object, so a request cannot pick the strategy, the models, the fact
// judge's switch or anything else the page does not send. The CV travels in the body for this one
// call: it goes into the prompt through the gateway and nowhere else. A log line holds an event
// name and a code; an error body holds a code and, for a 400, the names of the fields that failed.
// Neither ever holds the text, the CV or an upstream message. Responses are no-store.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, CapError, GatewayError, ResponseError, type Gateway } from '../../../gateway/src/index.ts';
import { Genre, Lang, Mode, Register, rewrite, RewriteInput, Variety, type PromptRefs, type RewriteResult } from '../../../prose-rewriter/src/index.ts';
import { MAX_BODY_BYTES, MAX_CV_CHARS, MAX_FIELD_CHARS, MAX_KEEP, MAX_KEEP_CHARS, MAX_PREVIOUS_CHARS, MAX_TEXT_CHARS } from '../src/protocol.ts';

/** A required text: blank is refused, and the limit counts what the user typed. */
const text = (max: number) => z.string().max(max).refine((s) => s.trim() !== '');

const Body = z.strictObject({
  text: text(MAX_TEXT_CHARS),
  genre: Genre,
  lang: Lang,
  variety: Variety.optional(),
  register: Register.optional(),
  mode: Mode.optional(),
  recipient: z
    .strictObject({
      name: text(MAX_FIELD_CHARS).optional(),
      org: text(MAX_FIELD_CHARS).optional(),
      role: text(MAX_FIELD_CHARS).optional(),
      previousMessage: text(MAX_PREVIOUS_CHARS).optional(),
    })
    .optional(),
  keep: z.array(text(MAX_KEEP_CHARS)).max(MAX_KEEP).optional(),
  cv: text(MAX_CV_CHARS),
});
type Body = z.infer<typeof Body>;

/** The input rewrite() takes. The CV becomes the profile; nothing else is added. */
export function toInput(body: Body): RewriteInput {
  const { cv, ...rest } = body;
  return { ...rest, profile: { cvMarkdown: cv } };
}

export interface HandlerDeps {
  /** Null when no key is configured: health says so and rewrite answers 503 without trying. */
  readonly gateway: Gateway | null;
  readonly refs: PromptRefs;
  /** One line per failure, with a code and never the text. */
  readonly log?: (event: string, data: Readonly<Record<string, string | number | boolean | null>>) => void;
  /** The gateway's job id for one rewrite, so the per-job cap binds per rewrite. A UUID. */
  readonly newJobId?: () => string;
}

export type Handler = (request: Request) => Promise<Response>;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

const error = (status: number, code: string, detail?: string): Response => reply(status, detail ? { error: code, detail } : { error: code });

type Read = { ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'not_json' };

async function readBody(request: Request): Promise<Read> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return { ok: false, reason: 'too_large' };
  if (!request.body) return { ok: false, reason: 'not_json' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: 'not_json' };
  }
}

/**
 * Whether a browser says the request comes from another site. Sec-Fetch-Site is set by the
 * browser and cannot be forged by a page; a script with no browser sends none and is let through.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

/**
 * A JSON content type makes a cross-origin browser request preflighted, and the server answers
 * no preflight, so another site cannot post a text/plain body that spends the key.
 */
const isJson = (request: Request): boolean => /^application\/json\s*(?:;|$)/iu.test(request.headers.get('content-type') ?? '');

/** The top-level field names of the issues, never their messages or values. */
const fields = (issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>): string =>
  [...new Set(issues.map((i) => (typeof i.path[0] === 'string' ? i.path[0] : '(body)')))].sort().join(',');

export function createHandler(deps: HandlerDeps): Handler {
  const log = deps.log ?? (() => undefined);
  const newJobId = deps.newJobId ?? randomUUID;

  async function rewriteRequest(request: Request, gateway: Gateway): Promise<Response> {
    if (crossSite(request)) return error(403, 'forbidden');
    if (!isJson(request)) return error(415, 'unsupported_media_type');
    const read = await readBody(request);
    if (!read.ok) return read.reason === 'too_large' ? error(413, 'too_large') : error(400, 'bad_request', '(body)');
    const parsed = Body.safeParse(read.value);
    if (!parsed.success) return error(400, 'bad_request', fields(parsed.error.issues));
    // The rewriter's own contract, so a variety with English is refused here, before any call.
    const input = RewriteInput.safeParse(toInput(parsed.data));
    if (!input.success) return error(400, 'bad_request', fields(input.error.issues));

    let result: RewriteResult;
    try {
      result = await rewrite(input.data, { gateway, refs: deps.refs, jobId: newJobId() });
    } catch (e) {
      // Never e.message or e.cause: an API error's cause holds the API's own message.
      if (e instanceof CapError) {
        log('rewrite_failed', { code: e.code });
        return error(503, 'cap_reached');
      }
      if (e instanceof ApiError) {
        log('rewrite_failed', { code: e.code, retryable: e.retryable, status: e.status });
        if (e.retryable) return reply(503, { error: 'model_unavailable' }, e.retryAfterSec !== null ? { 'retry-after': String(e.retryAfterSec) } : {});
        return error(500, 'server_error');
      }
      if (e instanceof ResponseError) {
        // Refused, cut at max_tokens, or unreadable twice where rewrite() does not fall back. Billed, and in the ledger.
        log('rewrite_failed', { code: e.code });
        return error(502, 'model_unusable');
      }
      log('rewrite_failed', { code: e instanceof GatewayError ? e.code : 'unexpected' });
      return error(500, 'server_error');
    }
    return reply(200, { original: input.data.text.normalize('NFC'), result });
  }

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/api/health')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'method_not_allowed');
      return reply(deps.gateway ? 200 : 503, { ok: deps.gateway !== null });
    }
    if (path.endsWith('/api/rewrite')) {
      if (request.method !== 'POST') return error(405, 'method_not_allowed');
      if (!deps.gateway) return error(503, 'model_unavailable');
      return rewriteRequest(request, deps.gateway);
    }
    return error(404, 'not_found');
  };
}
