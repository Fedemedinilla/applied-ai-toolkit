// What the page sends to POST ./api/rewrite and the limits on it. Plain data with no zod, so the
// page can import it without bundling a schema library; server/handler.ts builds its strict zod
// body from the same lists and numbers, and test/protocol.test.ts checks the lists against
// prose-rewriter's own enums.

export const GENRES = ['cover-letter', 'email', 'follow-up', 'whatsapp'] as const;
export const LANGS = ['es', 'en'] as const;
/** Spanish only: prose-rewriter refuses a variety with English. */
export const VARIETIES = ['rioplatense', 'neutral'] as const;
export const REGISTERS = ['formal', 'neutral', 'casual'] as const;
export const MODES = ['minimo', 'pulido', 'reescritura', 'redaccion'] as const;

export type Genre = (typeof GENRES)[number];
export type Lang = (typeof LANGS)[number];
export type Variety = (typeof VARIETIES)[number];
export type Register = (typeof REGISTERS)[number];
export type Mode = (typeof MODES)[number];

/** A long cover letter is about 3,000 characters; twice that leaves room without inviting a book. */
export const MAX_TEXT_CHARS = 6000;
/** A two-page CV in Markdown is about 6,000 to 9,000 characters. */
export const MAX_CV_CHARS = 20_000;
export const MAX_PREVIOUS_CHARS = 6000;
/** A name, an organisation or a role. */
export const MAX_FIELD_CHARS = 200;
export const MAX_KEEP = 10;
export const MAX_KEEP_CHARS = 300;
/**
 * Refused unread when Content-Length says more; otherwise the read is cancelled once it passes.
 * The character limits above, at up to three UTF-8 bytes a character and with JSON escapes, fit.
 */
export const MAX_BODY_BYTES = 128 * 1024;

export interface RewriteRequest {
  readonly text: string;
  readonly genre: Genre;
  readonly lang: Lang;
  readonly variety?: Variety;
  readonly register?: Register;
  readonly mode?: Mode;
  readonly recipient?: { readonly name?: string; readonly org?: string; readonly role?: string; readonly previousMessage?: string };
  readonly keep?: readonly string[];
  /** The CV as Markdown. Sent for this one call and kept nowhere. */
  readonly cv: string;
}

/** Labels for the page, in English. */
export const GENRE_LABEL: Readonly<Record<Genre, string>> = {
  'cover-letter': 'Cover letter',
  email: 'Email',
  'follow-up': 'Follow-up',
  whatsapp: 'WhatsApp message',
};
export const LANG_LABEL: Readonly<Record<Lang, string>> = { es: 'Spanish', en: 'English' };
export const VARIETY_LABEL: Readonly<Record<Variety, string>> = { rioplatense: 'Rioplatense (voseo)', neutral: 'Neutral Latin American' };
export const REGISTER_LABEL: Readonly<Record<Register, string>> = { formal: 'Formal', neutral: 'Neutral', casual: 'Casual' };
export const MODE_LABEL: Readonly<Record<Mode, string>> = {
  minimo: 'Smallest fix',
  pulido: 'Polish',
  reescritura: 'Reword by paragraph',
  redaccion: 'Write for the reader',
};
