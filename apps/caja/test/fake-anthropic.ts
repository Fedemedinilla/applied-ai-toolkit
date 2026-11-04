// A small fake of the Anthropic Messages API for the model-mode tests: a fetch that records each
// request and answers with the next queued response, shaped like the real API's JSON. It is given
// to the gateway's real client, so the tests also run what SDK 1.1.0 does with the body, the
// headers and the error classes. Nothing goes to the network.

export interface SeenRequest {
  url: string;
  body: Record<string, unknown>;
}

export type Reply = () => Response | Promise<Response>;

export interface FakeAnthropic {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requests: SeenRequest[];
  /** Answers still queued. */
  readonly left: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** A finished message whose only text block is `form` as JSON, the way structured output arrives. */
export function message(form: unknown, usage: Usage = { input_tokens: 900, output_tokens: 120 }, stopReason = 'end_turn'): Reply {
  return () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        container: null,
        context_management: null,
        diagnostics: null,
        content: [{ type: 'text', text: JSON.stringify(form), citations: null }],
        stop_reason: stopReason,
        stop_details: null,
        stop_sequence: null,
        usage: {
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
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fake' } },
    );
}

export function apiError(status: number, type: string): Reply {
  return () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message: `fake ${type}` }, request_id: 'req_fake' }), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_fake' },
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
      requests.push({ url: request.url, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      const next = queue.shift();
      if (!next) throw new Error(`fake Anthropic API: request ${requests.length} was not expected`);
      return next();
    },
  };
}
