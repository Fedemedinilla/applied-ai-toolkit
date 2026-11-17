// A small fake of the Anthropic Messages API for the rewriter's tests: a fetch that records each
// request and answers with the next queued reply. It is passed to the gateway's real client, so the
// tests also run what the SDK does with the body, the headers and the events. A reply answers a
// streamed request with server-sent events in the API's format and any other with one JSON
// message, since the rewriter's stages use both.

export interface SeenRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type Reply = (body: Record<string, unknown>) => Response | Promise<Response>;

export interface FakeAnthropic {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requests: SeenRequest[];
  readonly left: number;
}

export interface Usage {
  input: number;
  output: number;
}

function message(model: unknown, text: string, usage: Usage) {
  return {
    id: 'msg_fake',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    context_management: null,
    diagnostics: null,
    model,
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: usage.input,
      iterations: null,
      output_tokens: usage.output,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: null,
    },
  };
}

function sse(msg: ReturnType<typeof message>): string {
  const [block] = msg.content;
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block?.text ?? '' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        context_management: null,
        delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null },
        usage: {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: msg.usage.cache_creation,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          fallback_credit: null,
        },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A reply whose only text block is `text` (a structured reply is its JSON). */
export function answer(text: string, usage: Usage = { input: 3000, output: 400 }): Reply {
  return (body) => {
    const msg = message(body['model'], text, usage);
    if (body['stream'] === true) return new Response(sse(msg), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake' } });
    return new Response(JSON.stringify(msg), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fake' } });
  };
}

export function apiError(status: number, type: string, headers: Record<string, string> = {}): Reply {
  return () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message: `fake ${type}` }, request_id: 'req_fake' }), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_fake', ...headers },
    });
}

export function fakeAnthropic(replies: readonly Reply[]): FakeAnthropic {
  const queue = [...replies];
  const requests: SeenRequest[] = [];
  return {
    requests,
    get left() {
      return queue.length;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const text = await request.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      requests.push({ url: request.url, headers: request.headers, body });
      const next = queue.shift();
      if (!next) throw new Error(`fake Anthropic API: request ${requests.length} was not expected`);
      return next(body);
    },
  };
}
