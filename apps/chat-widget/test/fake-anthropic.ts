// A fake of the Anthropic Messages API: a fetch that records each request and answers with the next
// queued reply, as server-sent events the way the streaming API sends them, or as a JSON error. It
// is passed to the gateway's real client, so the tests also run what SDK 1.1.0 does with the body,
// the headers, the stream and the error classes. Nothing goes to the network.

export interface SeenRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export type Reply = (request: SeenRequest) => Response | Promise<Response>;

export interface FakeAnthropic {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly requests: SeenRequest[];
  readonly left: number;
}

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

const usageOf = (usage: Usage) => ({
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
  ...usage,
});

/** A streamed message whose only block is `text`, in two deltas. */
export function streamed(text: string, usage: Usage = { input_tokens: 1200, output_tokens: 80 }, stopReason = 'end_turn'): Reply {
  return () => {
    const message = {
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
      usage: { ...usageOf(usage), output_tokens: 1 },
    };
    const half = Math.ceil(text.length / 2);
    const events: Array<[string, unknown]> = [
      ['message_start', { type: 'message_start', message }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } }],
      ...[text.slice(0, half), text.slice(half)]
        .filter((piece) => piece !== '')
        .map((piece): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          context_management: null,
          delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null, container: null },
          usage: { ...usageOf(usage), server_tool_use: null, fallback_credit: null },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ];
    const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake' } });
  };
}

export function apiError(status: number, type: string, headers: Record<string, string> = {}): Reply {
  return () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message: `fake ${type}` }, request_id: 'req_fake' }), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_fake', ...headers },
    });
}

export function fakeAnthropic(replies: readonly Reply[] = []): FakeAnthropic & { push(...more: Reply[]): void } {
  const queue = [...replies];
  const requests: SeenRequest[] = [];
  return {
    requests,
    get left() {
      return queue.length;
    },
    push(...more) {
      queue.push(...more);
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const text = await request.text();
      const seen = { url: request.url, headers: request.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
      requests.push(seen);
      const next = queue.shift();
      if (!next) throw new Error(`fake Anthropic API: request ${requests.length} was not expected`);
      return next(seen);
    },
  };
}
