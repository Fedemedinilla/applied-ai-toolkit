import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { ConnectionNotOpenedError, isConnectFailure } from './errors.ts';
import { requirePositiveInt, requireSecret } from './setup.ts';

/** Explicit on purpose: without baseURL the SDK reads ANTHROPIC_BASE_URL from the environment. */
export const CLAUDE_API_URL = 'https://api.anthropic.com';

type Fetch = NonNullable<ClientOptions['fetch']>;

export interface ClaudeClientOptions {
  /** Passed in by whoever reads the environment. Never picked up from ANTHROPIC_API_KEY. */
  readonly apiKey: string;
  /**
   * Milliseconds until response headers arrive (the SDK does not time the body). The gateway
   * enforces its own deadline for the whole call on top of this. With maxRetries 0 there is one
   * attempt.
   */
  readonly timeoutMs: number;
  /** Defaults to CLAUDE_API_URL. */
  readonly baseURL?: string;
  /** For tests: a fake fetch. Defaults to the global fetch at creation time. */
  readonly fetch?: Fetch;
}

/**
 * Wraps fetch so that a connection that never opened throws ConnectionNotOpenedError instead of
 * undici's error. Without this the SDK reported undici's connect timeout as a request timeout and
 * dropped its cause, and the gateway charged the worst case for a request that never left: a
 * network outage with retries filled the caps with spend that did not happen. Failures on an open
 * connection (a reset, headers that never arrive) pass through unchanged.
 */
function withConnectFailureMarked(base: Fetch): Fetch {
  return async (url, init) => {
    try {
      return await base(url, init);
    } catch (error) {
      if (isConnectFailure(error)) throw new ConnectionNotOpenedError(error);
      throw error;
    }
  };
}

/**
 * The Anthropic client the gateway uses. Everything the SDK would otherwise read from the
 * environment is pinned here, so the host's environment cannot change where or how calls go:
 * - apiKey is explicit, so the SDK does not look for ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN;
 * - baseURL is explicit, instead of ANTHROPIC_BASE_URL;
 * - logLevel is explicit, instead of ANTHROPIC_LOG (at debug the SDK logs request bodies);
 * - OpenTelemetry content mode is metadata_only, instead of an environment variable that can put
 *   prompts into traces.
 * ANTHROPIC_CUSTOM_HEADERS cannot be turned off from the constructor; the deploy should not set it.
 *
 * maxRetries 0: retries belong to the caller, which can honour retry-after and lower concurrency.
 * Retries inside the SDK would also make a single call outlive the gateway's deadline.
 */
export function createClaudeClient(options: ClaudeClientOptions): Anthropic {
  return new Anthropic({
    apiKey: requireSecret(options.apiKey, 'the Anthropic API key'),
    baseURL: options.baseURL ?? CLAUDE_API_URL,
    maxRetries: 0,
    timeout: requirePositiveInt(options.timeoutMs, 'timeoutMs of the Claude client'),
    logLevel: 'warn',
    openTelemetry: { traces: { contentMode: 'metadata_only' } },
    fetch: withConnectFailureMarked(options.fetch ?? globalThis.fetch),
  });
}
