// The browser's side of model mode: is the endpoint there, and what did it read. Both answers are
// treated as untrusted. Any failure means "read without the model", which is what the app does
// with no network at all, so model mode can only add a check, never take the till away.

import { isReading, type ModelReading } from './verdict.ts';

/** fetch, or a fake in the tests. Null in AppDeps means model mode does not exist on this page. */
export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Relative to the page, like every other URL of the app (base './'). */
export const HEALTH_URL = './api/health';
export const EXTRACT_URL = './api/extract';
export const HEALTH_TIMEOUT_MS = 3000;
/** The server's own deadline is 15 s (server/model.ts); this one leaves room for the network. */
export const EXTRACT_TIMEOUT_MS = 20_000;

/** Error codes the endpoint returns (server/handler.ts), plus the two the browser adds. */
export type ModelError = 'cap_reached' | 'model_unavailable' | 'model_unusable' | 'bad_request' | 'server_error' | 'network' | 'bad_response';

export type ModelAnswer = { ok: true; reading: ModelReading } | { ok: false; error: ModelError };

const KNOWN: ReadonlySet<string> = new Set(['cap_reached', 'model_unavailable', 'model_unusable', 'bad_request', 'server_error']);

/** An AbortSignal that fires after `ms` or when `outer` fires. Written out: AbortSignal.any is not everywhere yet. */
function deadline(ms: number, outer?: AbortSignal): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = (): void => controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  if (outer?.aborted) controller.abort();
  return {
    signal: controller.signal,
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

/**
 * True only for a 200 whose body is {"ok": true}. A static host answers /api/health with its 404
 * page, and an offline phone with nothing; both keep the toggle hidden.
 */
export async function modelAvailable(api: ApiFetch, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  const d = deadline(timeoutMs);
  try {
    const res = await api(HEALTH_URL, { method: 'GET', cache: 'no-store', signal: d.signal });
    if (res.status !== 200) return false;
    const body = await json(res);
    return typeof body === 'object' && body !== null && (body as Record<string, unknown>)['ok'] === true;
  } catch {
    return false;
  } finally {
    d.done();
  }
}

export interface ExtractBody {
  sentence: string;
  /** The shop's calendar day, YYYY-MM-DD. */
  today: string;
  /** IANA zone of the device, which is the shop's. */
  timezone: string;
}

export async function askModel(api: ApiFetch, body: ExtractBody, signal?: AbortSignal): Promise<ModelAnswer> {
  const d = deadline(EXTRACT_TIMEOUT_MS, signal);
  try {
    const res = await api(EXTRACT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: d.signal,
    });
    const data = await json(res);
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    if (res.ok) return isReading(record['reading']) ? { ok: true, reading: record['reading'] } : { ok: false, error: 'bad_response' };
    const code = record['error'];
    return { ok: false, error: typeof code === 'string' && KNOWN.has(code) ? (code as ModelError) : 'server_error' };
  } catch {
    return { ok: false, error: 'network' };
  } finally {
    d.done();
  }
}

/** What the status line says when model mode could not read the sentence. The offline reading is shown below it. */
export function modelErrorMessage(error: ModelError): string {
  if (error === 'cap_reached') return 'El modo con IA llegó al tope de gasto del mes. Abajo está la lectura sin IA.';
  if (error === 'model_unavailable') return 'El modo con IA está ocupado ahora. Abajo está la lectura sin IA.';
  return 'El modo con IA no pudo leer la frase. Abajo está la lectura sin IA.';
}
