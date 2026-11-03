/**
 * Blinding: the judge reads pieces without knowing which variant wrote them.
 *
 * Each row is reduced to what the judge needs (case, language, the run's date,
 * brief, text), given an id drawn at random, and shuffled across variants. The
 * variant, the sample number, latency, token counts and stop reason all go to
 * a separate key file that the judge never receives. Any of those fields would
 * let a reader guess the variant (a variant that removes a word floor writes
 * shorter pieces and spends fewer tokens), so none of them travel with the
 * text. The date is one value for the whole run, so it says nothing about the
 * variant.
 *
 * Rows with nothing to judge (a failed call, a refusal, an empty text) never
 * reach the judge. They go into the key only, marked `withheld`, so the
 * results table can count them per variant instead of losing them.
 */
import { mulberry32, shuffled } from './random.ts';
import { isFailure, type EvalFailure, type EvalRow } from './runner.ts';

export type BlindPiece = { id: string; case: string; lang: string; now: string; brief: string; text: string };
export type Withheld = 'failed' | 'refusal' | 'empty';
export type KeyEntry = { variant: string; lang: string; case: string; sample: number; stop: string | null; withheld?: Withheld };
export type BlindKey = Record<string, KeyEntry>;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomId(rand: () => number, length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

function withheldReason(r: EvalRow | EvalFailure): Withheld | undefined {
  if (isFailure(r)) return 'failed';
  if (r.stop === 'refusal') return 'refusal';
  if (r.text.trim() === '') return 'empty';
  return undefined;
}

/**
 * Same rows and seed, same output. The seed is kept with the key, not with the
 * pieces, so the blinding can be rebuilt and audited after judging.
 */
export function blind(rows: readonly (EvalRow | EvalFailure)[], seed: number): { pieces: BlindPiece[]; key: BlindKey } {
  const rand = mulberry32(seed);
  const key: BlindKey = {};
  const used = new Set<string>();
  const pieces: BlindPiece[] = [];
  for (const r of rows) {
    let id = randomId(rand);
    while (used.has(id)) id = randomId(rand);
    used.add(id);
    const withheld = withheldReason(r);
    const stop = isFailure(r) ? null : r.stop;
    key[id] = { variant: r.variant, lang: r.lang, case: r.case, sample: r.sample, stop, ...(withheld ? { withheld } : {}) };
    if (!withheld && !isFailure(r)) pieces.push({ id, case: r.case, lang: r.lang, now: r.now, brief: r.brief, text: r.text });
  }
  return { pieces: shuffled(pieces, rand), key };
}
