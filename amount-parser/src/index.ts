// Public API. Browser-safe: nothing in src/ imports a Node built-in.

export { parseAmount } from './money.ts';
export type { AmbiguityReason, ParsedAmount, Span, SpanRole } from './money.ts';
export { normalize } from './tokens.ts';
export { parseNumber } from './numbers.ts';
export { BASE_SCALES } from './vocabulary.ts';
