// The server's request handler: POST ./api/assistant goes to the grounded-assistant handler, and
// without a key it answers 503 with no model call. Framework-free, so serve.ts and the tests drive
// the same function.

import { createAssistantHandler } from '../../../grounded-assistant/src/index.ts';
import { createSalonModel, type ModelOptions } from './model.ts';

export interface AppOptions {
  readonly apiKey: string | null;
  readonly historySecret: string;
  readonly fetch?: ModelOptions['fetch'];
  readonly now?: () => Date;
  readonly monthlyCapUsd?: number;
  readonly log?: (line: string) => void;
  /** Per-IP turns per minute. Default 12, the source's figure. */
  readonly perMinute?: number;
}

/** Turns per IP in the last minute, counting only accepted ones. One process only, at most 10,000 addresses. */
export function perMinuteLimiter(max: number, now: () => number): (ip: string) => boolean {
  const hits = new Map<string, number[]>();
  return (ip) => {
    const t = now();
    const recent = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
    const over = recent.length >= max;
    if (!over) recent.push(t);
    // Re-inserted so the Map's order is least recently seen first, and the eviction below drops
    // an idle address, not an active one.
    hits.delete(ip);
    hits.set(ip, recent);
    if (hits.size > 10_000) hits.delete(hits.keys().next().value ?? '');
    return over;
  };
}

export function createApp(options: AppOptions): (request: Request, clientAddress: string) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const unavailable = () =>
    new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const model = options.apiKey
    ? createSalonModel({
        apiKey: options.apiKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.monthlyCapUsd !== undefined ? { monthlyCapUsd: options.monthlyCapUsd } : {}),
        ...(options.log ? { log: options.log } : {}),
        clock: { now, monotonicMs: () => performance.now() },
      })
    : null;
  const handler = model
    ? createAssistantHandler({
        historySecret: options.historySecret,
        propose: model.propose,
        now,
        limited: perMinuteLimiter(options.perMinute ?? 12, () => now().getTime()),
      })
    : null;

  return async (request, clientAddress) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/api/health')) return new Response(JSON.stringify({ ok: handler !== null }), { status: handler ? 200 : 503, headers: { 'content-type': 'application/json' } });
    if (!path.endsWith('/api/assistant')) return new Response(null, { status: 404 });
    return handler ? handler(request, { clientAddress }) : unavailable();
  };
}
