// A small fake of the Anthropic Messages API: a fetch that records each request and answers with
// the next queued response, shaped like the real API's JSON. It is handed to the gateway's real
// client, so the tests also run what SDK 1.1.0 does with the body, the headers and the errors.
// Nothing goes to the network.

export interface SeenRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

export type Reply = () => Response;

export interface FakeAnthropic {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly requests: SeenRequest[];
}

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake' } });

/** A finished message whose only text block is `text`, the way structured output arrives. */
export function messageText(text: string, usage: Usage = { input_tokens: 3_000, output_tokens: 2_500 }, stopReason = 'end_turn'): Reply {
  return () =>
    json(200, {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      container: null,
      context_management: null,
      diagnostics: null,
      content: [{ type: 'text', text, citations: null }],
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
    });
}

/** The same, with `form` serialized as the text. */
export const message = (form: unknown, usage?: Usage, stopReason?: string): Reply => messageText(JSON.stringify(form), usage, stopReason);

export const apiError =
  (status: number, type: string): Reply =>
  () =>
    json(status, { type: 'error', error: { type, message: `fake ${type}` }, request_id: 'req_fake' });

export function fakeAnthropic(replies: readonly Reply[]): FakeAnthropic {
  const queue = [...replies];
  const requests: SeenRequest[] = [];
  return {
    requests,
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
