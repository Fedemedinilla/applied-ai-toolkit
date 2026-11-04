/**
 * One PostgREST RPC call, classified by what its result says about the write.
 *
 * PostgREST runs each RPC in one transaction and rolls it back when the function raises, so an
 * error status from PostgREST means nothing was written. Everything else is ambiguous: a network
 * error, a timeout or a 5xx from a proxy can come after the transaction committed.
 */

export interface RpcConfig {
  /** PostgREST base URL, for Supabase `https://<project>.supabase.co/rest/v1`. */
  readonly url: string;
  /** Sent with every request, for Supabase `apikey` and `Authorization`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch;
  /** Per attempt, over headers and body. */
  readonly timeoutMs: number;
}

export type WireResult =
  /** A 2xx with a JSON body. Its shape is checked by the caller. */
  | { readonly kind: 'body'; readonly body: unknown }
  /** An error answer: the call did not write. `code` is PostgREST's or Postgres's (`22023`, `PGRST202`). */
  | { readonly kind: 'refused'; readonly status: number; readonly code: string | null }
  /** The call may or may not have written. */
  | {
      readonly kind: 'ambiguous';
      readonly cause: 'network' | 'timeout' | 'server' | 'unreadable';
      readonly status: number | null;
      readonly retryAfterMs: number | null;
    }
  /** The caller's signal fired. The call may or may not have written. */
  | { readonly kind: 'aborted' };

/** Statuses that are retried. 408 and 429 can come from a proxy in front of PostgREST. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After in seconds, as PostgREST and most proxies send it. An HTTP date is ignored. */
export function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^\s*\d{1,6}\s*$/.test(header)) return null;
  return Number(header) * 1000;
}

export async function callRpc(
  config: RpcConfig,
  fn: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<WireResult> {
  if (signal?.aborted) return { kind: 'aborted' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await config.fetch(`${config.url.replace(/\/+$/, '')}/rpc/${fn}`, {
        method: 'POST',
        headers: { ...config.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch {
      return failure();
    }
    if (response.status >= 200 && response.status < 300) {
      try {
        return { kind: 'body', body: JSON.parse(await response.text()) as unknown };
      } catch {
        // The commit may be behind a body that did not arrive whole.
        if (timedOut || signal?.aborted) return failure();
        return { kind: 'ambiguous', cause: 'unreadable', status: response.status, retryAfterMs: null };
      }
    }
    if (isRetryableStatus(response.status) || response.status < 200 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: 'ambiguous',
        cause: 'server',
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers.get('Retry-After')),
      };
    }
    return { kind: 'refused', status: response.status, code: await errorCode(response) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  function failure(): WireResult {
    if (signal?.aborted) return { kind: 'aborted' };
    return { kind: 'ambiguous', cause: timedOut ? 'timeout' : 'network', status: null, retryAfterMs: null };
  }
}

/** PostgREST error bodies carry `code`. Only the code is kept: messages can echo the request. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(await response.text());
    if (typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string') {
      return body.code.slice(0, 32);
    }
  } catch {
    // Not JSON: a proxy's error page.
  }
  return null;
}
