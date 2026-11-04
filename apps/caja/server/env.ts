// The one place model mode reads the environment. Everything else gets the key as an argument.

/** The Anthropic API key, or null when it is missing or blank: model mode is then off. */
export function apiKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const key = env['ANTHROPIC_API_KEY']?.trim() ?? '';
  return key === '' ? null : key;
}
