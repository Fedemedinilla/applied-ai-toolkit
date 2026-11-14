// What an n8n Webhook node emits for a request, as the json of one item.

export function webhookItem(
  body: unknown,
  extra: { query?: Record<string, unknown>; headers?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    params: {},
    query: extra.query ?? {},
    body,
  };
}

/** Email values a lead or sale webhook must send to the discard branch. */
export const BAD_EMAILS: unknown[] = [
  undefined,
  null,
  '',
  '   ',
  'no-at-sign',
  'two@@example.com',
  'a@b',
  '@example.com',
  'ana@',
  'ana @example.com',
  'ana@example.com, other@example.com',
  'ana@example.com\nBcc: other@example.com',
  ['ana@example.com', 'other@example.com'],
  { address: 'ana@example.com' },
  42,
  true,
  // 255 characters: one more than an address can have. Unbounded, it would
  // overflow a sheet cell or the 4,096 characters of a Telegram message.
  `${'a'.repeat(243)}@example.com`,
];

/** The longest address the checks accept: 254 characters. */
export const LONGEST_EMAIL = `${'a'.repeat(242)}@example.com`;
