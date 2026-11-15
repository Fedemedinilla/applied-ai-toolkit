/**
 * The wording of the catalog's messages that only fits a cover letter, with the variant every
 * other genre gets. A cover letter keeps the catalog's text byte for byte. test/genres.test.ts
 * fails when a message in rules.ts speaks of a letter or a candidate and has no variant here.
 */
import { RULES } from './rules.ts';
import type { Genre, Rule } from './types.ts';

export interface MessageVariant {
  /** The finding's message outside a cover letter. */
  message?: string;
  /** The rule's deviation note outside a cover letter, for documentation. */
  deviation?: string;
}

export const MESSAGE_VARIANTS: Readonly<Record<string, MessageVariant>> = {
  'LEX-03': { message: 'Banned template phrase.' },
  'LEX-06': { message: 'Announcing honesty adds nothing when the message is true and makes it worse when it is not.' },
  'ESP-01': { message: 'Rounded-up quantity. An inflated figure costs the reader’s trust, and only the CV can confirm it.' },
  'EST-04': {
    deviation: 'The report checks only the first sentence; here every sentence start is checked, because the phrases are no better in the middle of a text.',
  },
  'RET-01': { message: 'Praise for the company with nothing the writer knows about it.' },
  'FMT-01': { message: 'Markdown in a plain-text message. The reader’s app shows the asterisks and hashes as typed.' },
  'FMT-02': { message: 'Emoji in a professional message.' },
  'FMT-04': { message: 'Template placeholder or chat residue. It cannot be sent as it is.' },
  'ORT-04': { message: 'A raya that opens an aside must close it, and a short text tolerates one aside between rayas.' },
  'ORT-05': {
    deviation: 'The report sets one per cover letter and gives no figure for other genres. The budget does not scale with length, so lint longer texts section by section.',
  },
};

const CATALOG_MESSAGES: ReadonlyMap<string, string> = new Map(RULES.map((r) => [r.id, r.message]));

/**
 * The message a finding of this rule shows in this genre. A rule whose message is not the
 * catalog's (a custom rule, or a caller's own wording) keeps its message in every genre.
 */
export function messageFor(rule: Rule, genre: Genre): string {
  if (genre === 'cover-letter') return rule.message;
  const variant = MESSAGE_VARIANTS[rule.id]?.message;
  return variant !== undefined && CATALOG_MESSAGES.get(rule.id) === rule.message ? variant : rule.message;
}
