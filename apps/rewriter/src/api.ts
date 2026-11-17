// The page's side of the server: is it there, and what did it answer. Both answers are treated as
// untrusted. A static host answers ./api/health with its 404 page, which is how the page knows it
// is the public demo.

import type { RewriteRequest } from './protocol.ts';
import { asReply, type RewriteReply } from './result.ts';

/** fetch, or a fake in the tests. */
export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Relative to the page, like every URL of the app (base './'). */
export const HEALTH_URL = './api/health';
export const REWRITE_URL = './api/rewrite';
export const HEALTH_TIMEOUT_MS = 3000;
/**
 * A rewrite makes two to four model calls in a row, each with a 120-second deadline on the server
 * (server/model.ts); the page waits up to four minutes.
 */
export const REWRITE_TIMEOUT_MS = 240_000;

/** 'up' with a key, 'no-key' when the server answers 503, 'absent' for anything else (a static host, no network). */
export type Health = 'up' | 'no-key' | 'absent';

/** An AbortSignal that fires after `ms` or when `outer` fires. */
function deadline(ms: number, outer?: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; done(): void } {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, ms);
  const onAbort = (): void => controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  if (outer?.aborted) controller.abort();
  return {
    signal: controller.signal,
    timedOut: () => fired,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function health(api: ApiFetch, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Health> {
  const d = deadline(timeoutMs);
  try {
    const res = await api(HEALTH_URL, { method: 'GET', cache: 'no-store', signal: d.signal });
    const body = await json(res);
    const ok = isObject(body) ? body['ok'] : undefined;
    if (res.status === 200 && ok === true) return 'up';
    if (res.status === 503 && ok === false) return 'no-key';
    return 'absent';
  } catch {
    return 'absent';
  } finally {
    d.done();
  }
}

export type FailureCode =
  | 'bad_request'
  | 'too_large'
  | 'cap_reached'
  | 'model_unavailable'
  | 'model_unusable'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'bad_reply';

export const FAILURE_TEXT: Readonly<Record<FailureCode, string>> = {
  bad_request: 'The server refused the request. Check that the text and the CV are filled in and within their limits.',
  too_large: 'The request is too large. Shorten the text or the CV.',
  cap_reached: 'The spending cap is reached. The server will rewrite again when the cap resets.',
  model_unavailable: 'The model is busy or unavailable. Try again in a few minutes.',
  model_unusable: 'The model\'s reply could not be used. Try again.',
  server_error: 'The server had an error. Try again.',
  network: 'The page cannot reach the server.',
  timeout: 'The rewrite took too long. Try again.',
  bad_reply: 'The server answered something this page does not recognise.',
};

const FIELD_TEXT: Readonly<Record<string, string>> = {
  text: 'the text',
  cv: 'the CV',
  genre: 'the kind of text',
  lang: 'the language',
  variety: 'the Spanish variety (Spanish only)',
  register: 'the register',
  mode: 'how far to go',
  recipient: 'the recipient or the earlier message',
  keep: 'the phrases to leave as they are',
};

export type RewriteAnswer = { readonly ok: true; readonly reply: RewriteReply } | { readonly ok: false; readonly code: FailureCode; readonly fields: readonly string[] };

/** The message for a failure, naming the fields the server refused when it named any. */
export function failureMessage(code: FailureCode, fields: readonly string[] = []): string {
  const named = fields.map((f) => FIELD_TEXT[f]).filter((f): f is string => f !== undefined);
  if (code === 'bad_request' && named.length > 0) return `The server refused ${named.join(', ')}. Check the field and try again.`;
  return FAILURE_TEXT[code];
}

export async function requestRewrite(api: ApiFetch, body: RewriteRequest, signal?: AbortSignal, timeoutMs = REWRITE_TIMEOUT_MS): Promise<RewriteAnswer> {
  const d = deadline(timeoutMs, signal);
  try {
    const res = await api(REWRITE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: d.signal,
    });
    const data = await json(res);
    if (res.ok) {
      const reply = asReply(data);
      return reply === null ? { ok: false, code: 'bad_reply', fields: [] } : { ok: true, reply };
    }
    const code = isObject(data) ? data['error'] : undefined;
    const detail = isObject(data) && typeof data['detail'] === 'string' ? data['detail'].split(',') : [];
    const known = typeof code === 'string' && Object.hasOwn(FAILURE_TEXT, code) ? (code as FailureCode) : res.status >= 500 ? 'server_error' : 'bad_request';
    return { ok: false, code: known, fields: detail };
  } catch {
    return { ok: false, code: d.timedOut() ? 'timeout' : 'network', fields: [] };
  } finally {
    d.done();
  }
}
