// The writer's endpoint, framework-free: a Request goes in, a Response comes out, so it runs
// under any host that speaks the fetch API (dev-server.ts wraps it for node:http).
//
//   GET  /api/health  200 {"ok": true} when a key is configured, 503 {"ok": false} otherwise.
//   POST /api/draft   {role, category, messages} -> 200 with one of
//                       {type: "titles", titles, assistant}
//                       {type: "draft", es, en, report, assistant}
//                       {type: "text", text, assistant}
//                     or an error code: bad_request (400), history_too_long (400),
//                     category_not_for_role (400), cap_reached (503), model_unavailable (503),
//                     model_unusable (502), server_error (500).
//
// The browser sends only ids for the role and the category; the tone, the length, the
// sensitivity and everything else come from config/ on this side, so a request cannot lower a
// category's sensitivity or put a line of its own into the system prompt. `assistant` is the reply
// as the page must send it back in the history: rebuilt from what was parsed (protocol.ts). An
// assistant turn that is not in that canonical form, or not of a kind that fits its position, is
// refused before any call.
// Responses carry codes, never the brief or the model's text in an error, and are no-store.

import { z } from 'zod';
import { ApiError, CapError, GatewayError, ResponseError, type Gateway } from '../../../gateway/src/index.ts';
import { draftReport } from '../src/checks.ts';
import type { WriterConfig } from '../src/config-schema.ts';
import { isServedAssistantTurn, MAX_MESSAGES, parseReply, serializeReply } from '../src/protocol.ts';
import { MAX_TOKENS, TASK } from './model.ts';
import { buildSystem, PROMPT_VERSION, stepFor } from './prompt.ts';

export { MAX_MESSAGES };

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_HISTORY_CHARS = 20_000;
/**
 * Refused before reading when Content-Length says it is too big. Otherwise the body is read as a
 * stream and the read is cancelled once it passes the limit, so a chunked body is never held whole.
 */
export const MAX_BODY_BYTES = 64 * 1024;

const Message = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

const Body = z.strictObject({
  role: z.string().min(1).max(40),
  category: z.string().min(1).max(40),
  messages: z.array(Message).min(1),
});

type Message = z.infer<typeof Message>;

/**
 * Starts and ends on a user turn and alternates in between, with every assistant turn one this
 * server returned: the only shape the page produces.
 */
export function historyProblem(messages: readonly Message[]): 'too_long' | 'shape' | 'assistant' | null {
  if (messages.length > MAX_MESSAGES) return 'too_long';
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_HISTORY_CHARS) return 'too_long';
  const alternates = messages.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant'));
  if (!alternates || messages.length % 2 === 0) return 'shape';
  const forged = messages.some((m, i) => m.role === 'assistant' && !isServedAssistantTurn(m.content, i));
  return forged ? 'assistant' : null;
}

/** Look-alikes for the angle brackets: the text reads the same, and it cannot open or close a tag. */
const BRACKETS: Readonly<Record<string, string>> = { '<': '\u2039', '>': '\u203A' };

/**
 * A user turn as the model sees it: inside a tag, with each angle bracket replaced by a look-alike
 * (U+2039, U+203A) so it cannot close its own tag, while "<12 años" or "->" keeps its meaning.
 * The first one is the brief; the rest are the user's choices and requests.
 */
export function wrapUserTurn(content: string, index: number): string {
  const tag = index === 0 ? 'brief' : 'message';
  return `<${tag}>\n${content.replace(/[<>]/gu, (c) => BRACKETS[c] ?? '')}\n</${tag}>`;
}

export interface HandlerDeps {
  readonly config: WriterConfig;
  /** Null when no key is configured: health says so and draft answers 503 without trying. */
  readonly gateway: Gateway | null;
  readonly now: () => Date;
  /** One line per failure, with a code and never the text. */
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

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES || !request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createHandler(deps: HandlerDeps): Handler {
  const log = deps.log ?? (() => undefined);
  const { config } = deps;

  async function draft(request: Request, gateway: Gateway): Promise<Response> {
    const parsed = Body.safeParse(await readBody(request));
    if (!parsed.success) return error(400, 'bad_request', [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '(body)')))].join(','));
    const { messages } = parsed.data;
    const role = config.catalog.roles.find((r) => r.id === parsed.data.role);
    const category = config.catalog.categories.find((c) => c.id === parsed.data.category);
    if (!role) return error(400, 'bad_request', 'role');
    if (!category) return error(400, 'bad_request', 'category');
    if (!category.roles.includes(role.id)) return error(400, 'category_not_for_role');
    const problem = historyProblem(messages);
    if (problem === 'too_long') return error(400, 'history_too_long');
    if (problem !== null) return error(400, 'bad_request', 'messages');

    const step = stepFor(messages);
    const turn = (m: Message, i: number) =>
      m.role === 'user' ? { role: 'user' as const, content: wrapUserTurn(m.content, i) } : { role: 'assistant' as const, content: m.content };
    const earlier = messages.slice(0, -1).map(turn);
    const final = messages.at(-1);
    // historyProblem already holds the history to ending on a user turn; this narrows the type.
    if (final?.role !== 'user') return error(400, 'bad_request', 'messages');
    const conversation = [...earlier, { role: 'user' as const, content: wrapUserTurn(final.content, messages.length - 1) }] as const;

    try {
      const result = await gateway.text({
        task: TASK,
        userId: null,
        promptVersion: PROMPT_VERSION,
        maxTokens: MAX_TOKENS,
        system: buildSystem(config, role, category, step, deps.now()),
        messages: conversation,
        signal: request.signal,
      });
      const parsedReply = parseReply(result.text);
      const assistant = serializeReply(parsedReply);
      switch (parsedReply.kind) {
        case 'titles':
          return reply(200, { type: 'titles', step, titles: parsedReply.titles, assistant });
        case 'draft': {
          const report = draftReport({ category, catalog: config.catalog, school: config.school, es: parsedReply.es, en: parsedReply.en });
          return reply(200, { type: 'draft', step, es: parsedReply.es, en: parsedReply.en, report, assistant });
        }
        case 'text':
          if (parsedReply.text === '') {
            log('draft_failed', { code: 'empty_reply', step });
            return error(502, 'model_unusable');
          }
          log('draft_off_protocol', { step });
          return reply(200, { type: 'text', step, text: parsedReply.text, assistant });
      }
    } catch (e) {
      if (e instanceof CapError) {
        log('draft_failed', { code: e.code, spentUsd: e.spentUsd, capUsd: e.capUsd });
        return error(503, 'cap_reached');
      }
      if (e instanceof ApiError) {
        log('draft_failed', { code: e.code, retryable: e.retryable, status: e.status });
        if (e.retryable) return reply(503, { error: 'model_unavailable' }, e.retryAfterSec !== null ? { 'retry-after': String(e.retryAfterSec) } : {});
        return error(500, 'server_error');
      }
      if (e instanceof ResponseError) {
        // Refused or cut at max_tokens. Billed, and in the ledger.
        log('draft_failed', { code: e.code });
        return error(502, 'model_unusable');
      }
      log('draft_failed', { code: e instanceof GatewayError ? e.code : 'unexpected' });
      return error(500, 'server_error');
    }
  }

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/api/health')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'method_not_allowed');
      return reply(deps.gateway ? 200 : 503, { ok: deps.gateway !== null });
    }
    if (path.endsWith('/api/draft')) {
      if (request.method !== 'POST') return error(405, 'method_not_allowed');
      if (!deps.gateway) return error(503, 'model_unavailable');
      return draft(request, deps.gateway);
    }
    return error(404, 'not_found');
  };
}
