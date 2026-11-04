/**
 * A fetch function that answers like PostgREST's `/rpc/<function>` and runs the real SQL in
 * PGlite. Faults are queued per function and consumed one per request, so a test can say "the
 * first place_order commits and its response is lost" and the database shows what really happened.
 */
import type { PGlite } from '@electric-sql/pglite';

export type Fault =
  /** The request never reaches the database; fetch rejects. */
  | 'drop-before'
  /** The function runs and commits; fetch rejects as if the connection broke on the way back. */
  | 'drop-after-commit'
  /** The function runs and commits; a proxy answers 504. */
  | 'gateway-timeout-after-commit'
  /** The function runs and commits; the 200 body arrives cut. */
  | 'truncated-after-commit'
  /** The function runs and commits; the 200 body is valid JSON of the wrong shape. */
  | 'wrong-shape-after-commit'
  /** No answer until the request is aborted. Nothing runs. */
  | 'hang'
  /** An answer without running the function. */
  | { readonly status: number; readonly retryAfter?: string; readonly body?: unknown };

/** The argument names and casts of each function, as PostgREST would read them from the schema. */
const SIGNATURES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  place_order: [['p_key', 'text'], ['p_customer', 'text'], ['p_lines', 'jsonb']],
  find_order: [['p_key', 'text'], ['p_customer', 'text']],
  confirm_order: [['p_order_id', 'bigint'], ['p_expected_version', 'integer'], ['p_key', 'text']],
  get_order: [['p_order_id', 'bigint']],
};

/**
 * PostgREST's mapping from SQLSTATE to HTTP status, for the codes these functions can raise.
 * 42883 (undefined function) stands for the schema cache miss PostgREST reports as PGRST202.
 */
function httpStatus(sqlstate: string): number {
  if (sqlstate === '23505' || sqlstate === '23503') return 409;
  if (sqlstate === '42501') return 403;
  if (sqlstate === '42883') return 404;
  if (sqlstate === 'P0001' || sqlstate.startsWith('22') || sqlstate.startsWith('23')) return 400;
  return 500;
}

export interface FakeRequest {
  readonly fn: string;
  readonly args: unknown;
  readonly fault: Fault | null;
}

export class FakePostgrest {
  readonly requests: FakeRequest[] = [];
  /** Functions answered with 404 PGRST202, as before their migration ran. */
  readonly missing = new Set<string>();
  readonly #faults = new Map<string, Fault[]>();
  readonly #db: PGlite;

  constructor(db: PGlite) {
    this.#db = db;
  }

  /** Queues faults for the next requests to `fn`, one per request. */
  fail(fn: string, ...faults: Fault[]): this {
    this.#faults.set(fn, [...(this.#faults.get(fn) ?? []), ...faults]);
    return this;
  }

  /** Every request to `fn` gets this fault until `reset()`. */
  failAlways(fn: string, fault: Fault): this {
    return this.fail(fn, ...Array.from({ length: 1000 }, () => fault));
  }

  reset(): void {
    this.#faults.clear();
    this.missing.clear();
    this.requests.length = 0;
  }

  count(fn: string): number {
    return this.requests.filter((r) => r.fn === fn).length;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const fn = /\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1] ?? '';
    const args: unknown = JSON.parse(String(init?.body ?? 'null'));
    const fault = this.#faults.get(fn)?.shift() ?? null;
    this.requests.push({ fn, args, fault });
    const signal = init?.signal ?? undefined;

    if (fault === 'drop-before') throw new TypeError('fetch failed');
    if (fault === 'hang') {
      await new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (typeof fault === 'object' && fault !== null) {
      return Response.json(fault.body ?? { code: null, message: 'fault' }, {
        status: fault.status,
        headers: fault.retryAfter === undefined ? {} : { 'Retry-After': fault.retryAfter },
      });
    }

    const signature = SIGNATURES[fn];
    if (!signature || this.missing.has(fn)) {
      return Response.json({ code: 'PGRST202', message: 'Could not find the function in the schema cache' }, { status: 404 });
    }
    const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    const params = signature.map(([name, type]) => (type === 'jsonb' ? JSON.stringify(record[name] ?? null) : (record[name] ?? null)));
    const sql = `select ${fn}(${signature.map(([name, type], i) => `${name} => $${i + 1}::${type}`).join(', ')}) as r`;

    let body: unknown;
    try {
      const result = await this.#db.query<{ r: unknown }>(sql, params);
      body = result.rows[0]?.r ?? null;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'XX000';
      return Response.json({ code, message: 'error' }, { status: httpStatus(code) });
    }

    // From here on the transaction has committed.
    if (fault === 'drop-after-commit') throw new TypeError('fetch failed');
    if (fault === 'gateway-timeout-after-commit') return new Response('upstream timed out', { status: 504 });
    if (fault === 'truncated-after-commit') {
      return new Response(JSON.stringify(body).slice(0, 20), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (fault === 'wrong-shape-after-commit') return Response.json({ ok: true }, { status: 200 });
    return Response.json(body, { status: 200 });
  };
}
