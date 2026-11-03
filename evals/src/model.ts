/**
 * The one seam between the eval tools and a model.
 *
 * Every runner here takes a `ModelClient`, never the SDK directly. Tests pass a
 * fake that records requests and returns scripted text; the live scripts pass
 * `anthropicModelClient(new Anthropic())`. The interface is deliberately the
 * smallest thing the runners read back: the text, why it stopped, and usage.
 */
import type Anthropic from '@anthropic-ai/sdk';

export type SystemBlock = Anthropic.TextBlockParam;
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/**
 * The settings of one production call: model, output ceiling, effort.
 *
 * A target exports this object and both the product and the eval spread it. A
 * copy in the eval script drifts: the product moves to a new model or effort
 * and the eval keeps measuring the old one without a word.
 */
export type CallSettings = {
  model: string;
  max_tokens: number;
  output_config?: Anthropic.OutputConfig;
};

export type ModelRequest = CallSettings & {
  system: SystemBlock[];
  messages: ChatMessage[];
};

export type ModelUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type ModelReply = {
  text: string;
  /** `max_tokens` means the piece was cut; `refusal` means there is no piece. */
  stopReason: string | null;
  usage: ModelUsage;
};

export interface ModelClient {
  create(request: ModelRequest): Promise<ModelReply>;
}

/**
 * Wraps the SDK. No retries or timeouts are set here: the caller builds the
 * `Anthropic` instance, so a live script can match the production route's
 * timeout or loosen it on purpose, and says which in its own code.
 */
export function anthropicModelClient(client: Anthropic): ModelClient {
  return {
    async create(request) {
      const res = await client.messages.create({ ...request, stream: false });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return {
        text,
        stopReason: res.stop_reason,
        usage: {
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
