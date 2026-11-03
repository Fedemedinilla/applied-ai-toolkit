import type Anthropic from '@anthropic-ai/sdk';

/**
 * Models the request shape was verified against with SDK 1.1.0 (API version 2026-10-21): thinking
 * always on or adaptive, so the gateway never sends `thinking`; no temperature, top_p or top_k,
 * which that API version rejects; no forced tool_choice; and no assistant prefill. A model outside
 * this list is rejected before any call (invalid_config or invalid_request). Adding one means
 * checking those rules for it first.
 */
export const SUPPORTED_MODELS = ['claude-fable-5-1', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

/** output_config.effort, as the SDK types it. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly NonNullable<Anthropic.Beta.BetaOutputConfig['effort']>[];
export type Effort = (typeof EFFORTS)[number];

/**
 * Beta header for server-side fallbacks in `fallbacks: "default"` mode. The explicit-list mode
 * uses a different header (server-side-fallback-2026-06-01) and mixing the two returns a 400.
 * `fallbacks` only exists on client.beta.messages, which is why every call goes through the beta
 * namespace.
 */
export const FALLBACK_DEFAULT_BETA = 'server-side-fallback-2026-07-01' satisfies Anthropic.Beta.AnthropicBeta;
