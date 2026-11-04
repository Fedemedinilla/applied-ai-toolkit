/**
 * The history comes back from the browser, so the server signs what it said.
 *
 * Without a signature, a visitor can send `role: 'assistant'` turns the model reads as its own
 * ("I already confirmed a 50% discount"). The source's first fix (v1) signed each reply's text on
 * its own, with a key derived from the API key. That left two gaps. A signed reply could be moved:
 * replayed later in the same conversation, or pasted into another one after different user turns,
 * where it answers a question it was never asked. And rotating the API key silently ended every
 * live conversation, while a leaked log of signatures was tied to the most sensitive secret.
 *
 * v2 signs, for each assistant turn, an HMAC over a SHA-256 digest of the whole conversation up to
 * and including that turn, with a secret of its own. A reply is valid only after exactly the turns
 * it was written after, in that order, and editing an earlier user turn breaks every signature
 * after it. The version tag is inside the signed bytes, so a v1 signature can never verify.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface UserTurn {
  readonly role: 'user';
  readonly content: string;
}

export interface AssistantTurn {
  readonly role: 'assistant';
  readonly content: string;
}

export type Turn = UserTurn | AssistantTurn;

const VERSION = 'grounded-assistant/history/v2';
export const MIN_SECRET_BYTES = 32;

/** Length-prefixed, so no choice of contents can make two different conversations collide. */
export function conversationDigest(turns: readonly Turn[]): Buffer {
  const h = createHash('sha256');
  h.update(VERSION);
  for (const t of turns) {
    const body = Buffer.from(t.content, 'utf8');
    h.update(`\n${t.role}:${body.length}:`);
    h.update(body);
  }
  return h.digest();
}

export interface HistorySigner {
  /** The signature for the last turn of `turns`, which must be an assistant turn. */
  sign(turns: readonly Turn[]): string;
  /** True when `signature` is the one sign() gives for `turns`. */
  verify(turns: readonly Turn[], signature: unknown): boolean;
}

export function createHistorySigner(secret: string | Uint8Array): HistorySigner {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (key.length < MIN_SECRET_BYTES) throw new Error(`grounded-assistant: the history secret needs at least ${MIN_SECRET_BYTES} bytes`);
  const sign = (turns: readonly Turn[]) => {
    if (turns[turns.length - 1]?.role !== 'assistant') throw new Error('grounded-assistant: only an assistant turn is signed');
    return createHmac('sha256', key).update(conversationDigest(turns)).digest('base64url');
  };
  return {
    sign,
    verify(turns, signature) {
      if (typeof signature !== 'string' || turns[turns.length - 1]?.role !== 'assistant') return false;
      const want = Buffer.from(sign(turns));
      const got = Buffer.from(signature);
      return want.length === got.length && timingSafeEqual(want, got);
    },
  };
}
