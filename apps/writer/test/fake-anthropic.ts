// A small fake of the Anthropic Messages API for the writer's tests: a fetch that records each
// request and answers with the next queued reply. The gateway's text() streams, so a reply is a
// server-sent event stream in the API's format. It is passed to the gateway's real client, so the
// tests also run what SDK 1.1.0 does with the body, the headers and the events.

export interface SeenRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type Reply = () => Response | Promise<Response>;

export interface FakeAnthropic {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requests: SeenRequest[];
  readonly left: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

function sse(events: ReadonlyArray<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

const usageFields = (usage: Usage, output: number) => ({
  cache_creation: null,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: null,
  inference_geo: null,
  iterations: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: 'standard',
  speed: null,
  input_tokens: usage.input_tokens,
  output_tokens: output,
});

/** A streamed message whose only text block is `text`, sent in two deltas. */
export function streamed(text: string, options: { usage?: Usage; stopReason?: string; cutAfter?: number } = {}): Reply {
  const usage = options.usage ?? { input_tokens: 3000, output_tokens: 600 };
  const stopReason = options.stopReason ?? 'end_turn';
  const half = Math.ceil(text.length / 2);
  let events: Array<{ event: string; data: unknown }> = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          container: null,
          context_management: null,
          diagnostics: null,
          content: [],
          stop_reason: null,
          stop_details: null,
          stop_sequence: null,
          usage: usageFields(usage, 1),
        },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } } },
    ...[text.slice(0, half), text.slice(half)]
      .filter((piece) => piece !== '')
      .map((piece) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        context_management: null,
        delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null, container: null },
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          fallback_credit: null,
        },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  if (options.cutAfter !== undefined) events = events.slice(0, options.cutAfter);
  return () => new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake' } });
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
      requests.push({ url: request.url, headers: request.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      const next = queue.shift();
      if (!next) throw new Error(`fake Anthropic API: request ${requests.length} was not expected`);
      return next();
    },
  };
}
