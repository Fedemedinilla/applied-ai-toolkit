// The one place the server reads the environment. Everything else gets these as arguments.

type Env = Readonly<Record<string, string | undefined>>;

/** The Anthropic API key, or null when missing or blank: the assistant then answers 503. */
export function apiKeyFromEnv(env: Env = process.env): string | null {
  const key = env['ANTHROPIC_API_KEY']?.trim() ?? '';
  return key === '' ? null : key;
}

/**
 * The secret that signs the history, of its own and at least 32 bytes. Not derived from the API
 * key: rotating the key must not end every conversation, and a signature must not be tied to it.
 */
export function historySecretFromEnv(env: Env = process.env): string | null {
  const secret = env['ASSISTANT_HISTORY_SECRET'] ?? '';
  return Buffer.byteLength(secret, 'utf8') >= 32 ? secret : null;
}
