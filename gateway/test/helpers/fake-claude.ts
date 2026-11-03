/**
 * A fake Claude HTTP API: a fetch that records every request and answers in order, as JSON or as
 * server-sent events like the real API. It is passed to the real client (createClaudeClient), so
 * the tests also exercise what SDK 1.1.0 does with headers, bodies, error classes and stream
 * assembly. Nothing goes to the network.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { createClaudeClient } from '../../src/client.ts';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaUsage = Anthropic.Beta.BetaUsage;
type Category = Anthropic.Beta.BetaRefusalStopDetails['category'];

export const REQUEST_ID = 'req_fake_123';

export function fakeUsage(partial: Partial<BetaUsage> = {}): BetaUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: 0,
    iterations: null,
    output_tokens: 0,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    speed: null,
    ...partial,
  };
}

export function fakeMessage(partial: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: 'msg_fake',
    container: null,
    content: [],
    context_management: null,
    diagnostics: null,
    model: 'claude-sonnet-5-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: fakeUsage(),
    ...partial,
  };
}

export function textBlock(text: string): Anthropic.Beta.BetaTextBlock {
  return { type: 'text', text, citations: null };
}

/** A thinking block as it arrives with the default display: no text. */
export function thinkingBlock(): Anthropic.Beta.BetaThinkingBlock {
  return { type: 'thinking', thinking: '', signature: 'fake_signature' };
}

export function fallbackBlock(from: string, to: string, category: Category): Anthropic.Beta.BetaFallbackBlock {
  return { type: 'fallback', from: { model: from }, to: { model: to }, trigger: { type: 'refusal', category } };
}

export function refusalDetails(category: Category, recommendedModel: string | null = null): Anthropic.Beta.BetaRefusalStopDetails {
  return {
    type: 'refusal',
    category,
    explanation: 'API text about the refusal',
    fallback_credit_token: null,
    fallback_has_prefill_claim: null,
    recommended_model: recommendedModel,
  };
}

// ---------------------------------------------------------------------------
// HTTP responses
// ---------------------------------------------------------------------------

export function jsonResponse(message: BetaMessage, requestId = REQUEST_ID): Response {
  return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', 'request-id': requestId } });
}

export function errorResponse(status: number, type: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: `API message (${type})` }, request_id: REQUEST_ID }), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': REQUEST_ID, ...headers },
  });
}

/** The SSE events the API sends for that message, in order. Text arrives in two pieces. */
export function eventsFor(message: BetaMessage): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  events.push({
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_details: null,
        usage: { ...message.usage, output_tokens: 1, iterations: null, output_tokens_details: null },
      },
    },
  });
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { ...block, text: '' } } });
      const half = Math.ceil(block.text.length / 2);
      for (const piece of [block.text.slice(0, half), block.text.slice(half)]) {
        if (piece === '') continue;
        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
      }
    } else {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      context_management: null,
      delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details, container: null },
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: message.usage.cache_read_input_tokens,
        cache_creation: message.usage.cache_creation,
        iterations: message.usage.iterations,
        output_tokens_details: message.usage.output_tokens_details,
        server_tool_use: null,
        fallback_credit: null,
      },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

export interface SseOptions {
  /** End the body after this many events, without message_stop (a dropped connection). */
  readonly cutAfter?: number;
  /** Send an API `error` event after this many events. */
  readonly errorAfter?: { readonly events: number; readonly type: string };
}

function sseBody(events: ReadonlyArray<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

export function sseResponse(message: BetaMessage, options: SseOptions = {}): Response {
  let events = eventsFor(message);
  if (options.errorAfter) {
    events = [...events.slice(0, options.errorAfter.events), { event: 'error', data: { type: 'error', error: { type: options.errorAfter.type, message: 'Overloaded' } } }];
  } else if (options.cutAfter !== undefined) {
    events = events.slice(0, options.cutAfter);
  }
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': REQUEST_ID } });
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

export interface SeenRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | null;
}

/** Answers one request. It may throw (a network failure) or never resolve until the signal fires. */
export type Responder = (request: SeenRequest) => Response | Promise<Response>;

/**
 * A stream that sends the first `count` events of the message and stays open, like a model still
 * writing, until the request's signal fires. message_delta, which carries the output, never comes.
 */
export function sseThatKeepsGoing(message: BetaMessage, count: number): Responder {
  return (request) => {
    const sent = new TextEncoder().encode(sseBody(eventsFor(message).slice(0, count)));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sent);
        request.signal?.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': REQUEST_ID } });
  };
}

/** A 200 whose body fails with that error while being read. */
export function bodyThatFails(error: Error): Responder {
  return () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': REQUEST_ID } },
    );
}

/**
 * What Node's fetch (undici) throws when connect times out with no answer to the SYN: the request
 * never left. Shaped after undici (lib/core/errors.js, lib/core/connect.js), including the word
 * "Timeout" that makes the SDK report it as a request timeout.
 */
export function connectTimeoutError(): TypeError {
  const cause = Object.assign(new Error('Connect Timeout Error (attempted address: api.example.test:443, timeout: 10000ms)'), {
    name: 'ConnectTimeoutError',
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  return new TypeError('fetch failed', { cause });
}

export const connectTimesOut: Responder = () => Promise.reject(connectTimeoutError());

/** As Node 24's fetch throws it against a closed port. */
export const connectionRefused: Responder = () =>
  Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:443'), { code: 'ECONNREFUSED', syscall: 'connect', errno: -111 }),
    }),
  );

/** Never answers until the request's signal fires, then rejects like fetch. */
export const hangs: Responder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  });

export interface FakeApi {
  readonly client: Anthropic;
  readonly requests: SeenRequest[];
}

/**
 * The gateway's Anthropic client (createClaudeClient) with a fake fetch that answers in order. A
 * request beyond the list of responders fails the test.
 */
export function fakeApi(responders: readonly Responder[], options: { timeoutMs?: number } = {}): FakeApi {
  const requests: SeenRequest[] = [];
  const queue = [...responders];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = await request.text();
    const seen: SeenRequest = { url: request.url, headers: request.headers, body: text ? JSON.parse(text) : {}, signal: init?.signal ?? null };
    requests.push(seen);
    const responder = queue.shift();
    if (!responder) throw new Error(`The fake API got one request too many (${requests.length})`);
    return responder(seen);
  };
  const client = createClaudeClient({ apiKey: 'sk-fake', timeoutMs: options.timeoutMs ?? 60_000, fetch });
  return { client, requests };
}
