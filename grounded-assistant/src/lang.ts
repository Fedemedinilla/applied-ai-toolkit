/** The two languages the assistant speaks, and the formatting both share. */

export type Lang = 'es' | 'en';

/** Only the exact string 'en' means English; anything else is the Spanish default. */
export const langFrom = (value: unknown): Lang => (value === 'en' ? 'en' : 'es');

/**
 * Throws if an English table does not cover exactly the Spanish ids. It runs when the module
 * loads, so a row added in Spanish without its English twin fails every test.
 */
export function parity(name: string, ids: readonly string[], table: Readonly<Record<string, unknown>>): void {
  const want = [...new Set(ids)].sort();
  const got = Object.keys(table).sort();
  const missing = want.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !want.includes(k));
  if (missing.length || extra.length) {
    throw new Error(`${name}: the English table is out of step with the Spanish one. Missing: [${missing.join(', ')}]. Extra: [${extra.join(', ')}].`);
  }
}

/** Pesos the way an English reader parses them: "$16,000". Integers only. */
export const pesosEn = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** Pesos the es-AR way: "$16.000". */
export const pesosEs = (n: number): string => `$${n.toLocaleString('es-AR')}`;

/** "17:00" to "5:00 pm", for display only; data and validators stay 24-hour. */
export function time12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${h >= 12 ? 'pm' : 'am'}`;
}

/** "A, B and C". No Oxford comma. */
export function joinEn(items: readonly string[], word: 'and' | 'or'): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}
