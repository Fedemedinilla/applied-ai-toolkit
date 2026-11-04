/**
 * The retry protocol for placing and confirming orders through PostgREST.
 *
 * 1. One key per user action, made by the caller (see key.ts). Every attempt carries it.
 * 2. An answer that may hide a commit (network error, timeout, 408, 429, 5xx, an unreadable or
 *    malformed 2xx) is retried with the same key, with capped exponential backoff and full jitter.
 * 3. When the attempts run out, the order is read back by its key before giving up.
 * 4. The caller gets one of: it went in now, it was already in, it did not go in and why, or
 *    unknown. Unknown is never turned into a guess, and the key stays valid for another try.
 */
import { fingerprint, linesProblem, toSqlLines, type OrderLine } from './lines.ts';
import { KEY_PATTERN } from './key.ts';
import { ConfirmResponse, FindResponse, GetResponse, PlaceResponse, type Order } from './responses.ts';
import { callRpc, type RpcConfig, type WireResult } from './wire.ts';

export interface OrdersClientOptions {
  /** PostgREST base URL, for Supabase `https://<project>.supabase.co/rest/v1`. */
  readonly url: string;
  /** Sent with every request. On Supabase, the server's `apikey` and `Authorization`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** Attempts of the write itself, before the re-read. Default 3. */
  readonly maxAttempts?: number;
  /** Per request. Default 8000. */
  readonly timeoutMs?: number;
  /** First backoff ceiling; it doubles per attempt. Default 300. */
  readonly baseDelayMs?: number;
  /** Largest wait between attempts. A Retry-After above it ends the retries. Default 4000. */
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** In [0, 1). Default Math.random. */
  readonly random?: () => number;
}

export interface PlaceRequest {
  /** The key of this user action. */
  readonly key: string;
  /** The customer the server authenticated. Never taken from the request body. */
  readonly customerId: string;
  readonly lines: readonly OrderLine[];
}

export interface ConfirmRequest {
  readonly orderId: number;
  /** The version the person confirming was shown. */
  readonly expectedVersion: number;
  /** The key of this confirm action. */
  readonly key: string;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/** Requests sent, the re-read included. */
interface Counted {
  readonly requests: number;
}

/** Answers that mean nothing was written by this call, from any of the functions. */
type NotWritten =
  | { readonly kind: 'rejected'; readonly reason: 'refused'; readonly status: number; readonly code: string | null }
  | { readonly kind: 'rejected'; readonly reason: 'not_deployed'; readonly status: number; readonly code: string | null }
  | { readonly kind: 'rejected'; readonly reason: 'invalid_request'; readonly problem: string };

type Unknown = { readonly kind: 'unknown'; readonly key: string; readonly reason: 'retries_exhausted' | 'aborted' };

export type PlaceResult = Counted &
  (
    | { readonly kind: 'placed'; readonly order: Order }
    | {
        readonly kind: 'already_placed';
        readonly order: Order;
        /** True when an earlier attempt of this call may be the one that placed it. */
        readonly afterLostResponse: boolean;
        readonly via: 'resend' | 'reread';
      }
    | Unknown
    | { readonly kind: 'rejected'; readonly reason: 'key_reused'; readonly order: Order }
    | {
        readonly kind: 'rejected';
        readonly reason: 'key_expired';
        /** 'age': outside the server's resend window. 'not_pending': inside it, but no longer pending. */
        readonly why: 'age' | 'not_pending';
        readonly order: Order;
      }
    | { readonly kind: 'rejected'; readonly reason: 'key_taken' }
    | { readonly kind: 'rejected'; readonly reason: 'unavailable'; readonly productIds: readonly number[] }
    | NotWritten
  );

export type ConfirmResult = Counted &
  (
    | { readonly kind: 'confirmed'; readonly order: Order }
    | {
        readonly kind: 'already_confirmed';
        readonly order: Order;
        readonly afterLostResponse: boolean;
        readonly via: 'resend' | 'reread';
      }
    | Unknown
    | { readonly kind: 'rejected'; readonly reason: 'not_found' }
    | { readonly kind: 'rejected'; readonly reason: 'not_pending'; readonly status: string }
    | { readonly kind: 'rejected'; readonly reason: 'version_conflict'; readonly currentVersion: number }
    | {
        readonly kind: 'rejected';
        readonly reason: 'insufficient_stock';
        readonly shortages: readonly { productId: number; requested: number; onHand: number }[];
      }
    | NotWritten
  );

type Uncounted<R> = R extends Counted ? Omit<R, 'requests'> : never;

export interface OrdersClient {
  placeOrder(request: PlaceRequest, options?: CallOptions): Promise<PlaceResult>;
  confirmOrder(request: ConfirmRequest, options?: CallOptions): Promise<ConfirmResult>;
}

const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** How the write attempts ended, before the re-read. */
type LoopEnd<R> =
  | { readonly end: 'answer'; readonly result: R; readonly requests: number }
  | { readonly end: 'uncertain'; readonly requests: number }
  | { readonly end: 'aborted'; readonly requests: number };

export function createOrdersClient(options: OrdersClientOptions): OrdersClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const rpc: RpcConfig = {
    url: options.url,
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs ?? 8000,
    ...(options.headers ? { headers: options.headers } : {}),
  };
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const sleep = options.sleep ?? sleepFor;
  const random = options.random ?? Math.random;
  /**
   * Calls in flight, by action and payload. A double tap in the same process joins the first call.
   * Only calls made without a signal join or are joined: a joined call would otherwise end when
   * another caller aborts. A call with a signal sends its own requests, and the key still keeps
   * the database at one order.
   */
  const inFlight = new Map<string, Promise<PlaceResult | ConfirmResult>>();

  function once<R extends PlaceResult | ConfirmResult>(id: string, signal: AbortSignal | undefined, run: () => Promise<R>): Promise<R> {
    if (signal) return run();
    const running = inFlight.get(id);
    if (running) return running as Promise<R>;
    const started = run().finally(() => inFlight.delete(id));
    inFlight.set(id, started);
    return started;
  }

  /**
   * Sends until an answer that settles the call, or until the attempts run out. `read` turns a 2xx
   * body into a result, or null when the body does not validate. `afterAmbiguous` tells it whether
   * an earlier attempt may have written.
   */
  async function attempt<R>(
    send: (signal?: AbortSignal) => Promise<WireResult>,
    read: (body: unknown, afterAmbiguous: boolean) => R | null,
    refused: (status: number, code: string | null) => R,
    signal: AbortSignal | undefined,
  ): Promise<LoopEnd<R>> {
    let ambiguous = 0;
    let requests = 0;
    for (let n = 1; n <= maxAttempts; n++) {
      const wire = await send(signal);
      requests++;
      if (wire.kind === 'aborted') return { end: 'aborted', requests };
      if (wire.kind === 'refused') {
        // A refusal says this attempt wrote nothing. After an ambiguous attempt it says nothing
        // about that one (the function may be gone after a deploy, a token may have expired), so
        // the re-read decides.
        if (ambiguous > 0) return { end: 'uncertain', requests };
        return { end: 'answer', result: refused(wire.status, wire.code), requests };
      }
      if (wire.kind === 'body') {
        const result = read(wire.body, ambiguous > 0);
        if (result !== null) return { end: 'answer', result, requests };
      }
      ambiguous++;
      if (n === maxAttempts) break;
      const retryAfter = wire.kind === 'ambiguous' ? wire.retryAfterMs : null;
      // The server asked for a longer pause than this call will wait: stop adding load.
      if (retryAfter !== null && retryAfter > maxDelayMs) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (n - 1));
      try {
        await sleep(Math.max(retryAfter ?? 0, Math.floor(random() * ceiling)), signal);
      } catch {
        return { end: 'aborted', requests };
      }
    }
    return { end: 'uncertain', requests };
  }

  function rejectedByWire(status: number, code: string | null): NotWritten {
    return status === 404 && code === 'PGRST202'
      ? { kind: 'rejected', reason: 'not_deployed', status, code }
      : { kind: 'rejected', reason: 'refused', status, code };
  }

  async function place(request: PlaceRequest, fp: string, signal?: AbortSignal): Promise<PlaceResult> {
    const args = { p_key: request.key, p_customer: request.customerId, p_lines: toSqlLines(request.lines) };
    const loop = await attempt<Uncounted<PlaceResult>>(
      (s) => callRpc(rpc, 'place_order', args, s),
      (body, afterAmbiguous) => {
        const parsed = PlaceResponse.safeParse(body);
        if (!parsed.success) return null;
        const r = parsed.data;
        switch (r.outcome) {
          case 'placed':
            return { kind: 'placed', order: r.order };
          case 'already_placed':
            return { kind: 'already_placed', order: r.order, afterLostResponse: afterAmbiguous, via: 'resend' };
          case 'key_expired':
            // Inside the window, same cart, and an earlier attempt of this call may have written:
            // the order is this action's, confirmed before the resend arrived. Outside the window
            // the server's rule stands even after a lost attempt, so the answer does not depend on
            // which attempts happened to fail.
            if (r.why === 'not_pending' && afterAmbiguous && r.order.fingerprint === fp) {
              return { kind: 'already_placed', order: r.order, afterLostResponse: true, via: 'resend' };
            }
            return { kind: 'rejected', reason: 'key_expired', why: r.why, order: r.order };
          case 'key_reused':
            return { kind: 'rejected', reason: 'key_reused', order: r.order };
          case 'key_taken':
            return { kind: 'rejected', reason: 'key_taken' };
          case 'unavailable':
            return { kind: 'rejected', reason: 'unavailable', productIds: r.product_ids };
        }
      },
      rejectedByWire,
      signal,
    );
    if (loop.end === 'answer') return { ...loop.result, requests: loop.requests };
    if (loop.end === 'aborted') return { kind: 'unknown', key: request.key, reason: 'aborted', requests: loop.requests };

    // Every attempt may have written. Ask once whether the order is there.
    const reread = await callRpc(rpc, 'find_order', { p_key: request.key, p_customer: request.customerId }, signal);
    const requests = loop.requests + 1;
    const unknown: PlaceResult = { kind: 'unknown', key: request.key, reason: reread.kind === 'aborted' ? 'aborted' : 'retries_exhausted', requests };
    if (reread.kind !== 'body') return unknown;
    const found = FindResponse.safeParse(reread.body);
    if (!found.success) return unknown;
    switch (found.data.outcome) {
      case 'found': {
        // The same rules place_order applies to a resend, with the window judged by the server.
        const order = found.data.order;
        if (!found.data.within_window) return { kind: 'rejected', reason: 'key_expired', why: 'age', order, requests };
        if (order.fingerprint === fp) return { kind: 'already_placed', order, afterLostResponse: true, via: 'reread', requests };
        return order.status === 'pending'
          ? { kind: 'rejected', reason: 'key_reused', order, requests }
          : { kind: 'rejected', reason: 'key_expired', why: 'not_pending', order, requests };
      }
      case 'key_taken':
        return { kind: 'rejected', reason: 'key_taken', requests };
      case 'not_found':
        // Not there now. An attempt still queued on a lock can commit later, so this is not a no.
        return unknown;
    }
  }

  async function confirm(request: ConfirmRequest, signal?: AbortSignal): Promise<ConfirmResult> {
    const args = { p_order_id: request.orderId, p_expected_version: request.expectedVersion, p_key: request.key };
    const loop = await attempt<Uncounted<ConfirmResult>>(
      (s) => callRpc(rpc, 'confirm_order', args, s),
      (body, afterAmbiguous) => {
        const parsed = ConfirmResponse.safeParse(body);
        if (!parsed.success) return null;
        const r = parsed.data;
        switch (r.outcome) {
          case 'confirmed':
            return { kind: 'confirmed', order: r.order };
          case 'already_confirmed':
            return { kind: 'already_confirmed', order: r.order, afterLostResponse: afterAmbiguous, via: 'resend' };
          case 'not_found':
            return { kind: 'rejected', reason: 'not_found' };
          case 'not_pending':
            return { kind: 'rejected', reason: 'not_pending', status: r.status };
          case 'version_conflict':
            return { kind: 'rejected', reason: 'version_conflict', currentVersion: r.current_version };
          case 'insufficient_stock':
            return { kind: 'rejected', reason: 'insufficient_stock', shortages: r.shortages };
        }
      },
      rejectedByWire,
      signal,
    );
    if (loop.end === 'answer') return { ...loop.result, requests: loop.requests };
    if (loop.end === 'aborted') return { kind: 'unknown', key: request.key, reason: 'aborted', requests: loop.requests };

    const reread = await callRpc(rpc, 'get_order', { p_order_id: request.orderId }, signal);
    const requests = loop.requests + 1;
    const unknown: ConfirmResult = { kind: 'unknown', key: request.key, reason: reread.kind === 'aborted' ? 'aborted' : 'retries_exhausted', requests };
    if (reread.kind !== 'body') return unknown;
    const found = GetResponse.safeParse(reread.body);
    if (!found.success) return unknown;
    if (found.data.outcome === 'not_found') return { kind: 'rejected', reason: 'not_found', requests };
    const order = found.data.order;
    if (order.status === 'confirmed') {
      return order.confirmKey === request.key
        ? { kind: 'already_confirmed', order, afterLostResponse: true, via: 'reread', requests }
        : { kind: 'rejected', reason: 'not_pending', status: order.status, requests };
    }
    // Still pending: no attempt has committed yet, and one could still be waiting on the row lock.
    return unknown;
  }

  return {
    placeOrder(request, callOptions = {}) {
      const problem = placeProblem(request);
      if (problem) return Promise.resolve({ kind: 'rejected', reason: 'invalid_request', problem, requests: 0 });
      const fp = fingerprint(request.lines);
      return once(`place\u0000${request.key}\u0000${request.customerId}\u0000${fp}`, callOptions.signal, () => place(request, fp, callOptions.signal));
    },
    confirmOrder(request, callOptions = {}) {
      const problem = confirmProblem(request);
      if (problem) return Promise.resolve({ kind: 'rejected', reason: 'invalid_request', problem, requests: 0 });
      return once(`confirm\u0000${request.orderId}\u0000${request.expectedVersion}\u0000${request.key}`, callOptions.signal, () =>
        confirm(request, callOptions.signal),
      );
    },
  };
}

function placeProblem(request: PlaceRequest): string | null {
  if (!KEY_PATTERN.test(request.key)) return 'the key does not match KEY_PATTERN';
  const customerLength = [...request.customerId].length;
  if (customerLength < 1 || customerLength > 64) return 'customerId has 1 to 64 characters';
  return linesProblem(request.lines);
}

function confirmProblem(request: ConfirmRequest): string | null {
  if (!KEY_PATTERN.test(request.key)) return 'the key does not match KEY_PATTERN';
  if (!Number.isSafeInteger(request.orderId) || request.orderId < 1) return 'orderId is a positive integer';
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1 || request.expectedVersion > 2_147_483_647) {
    return 'expectedVersion is a positive integer';
  }
  return null;
}
