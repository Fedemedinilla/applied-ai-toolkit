// The two public endpoints the embedded widget calls, framework-free: a Request goes in, a
// Response comes out.
//
//   GET  /widget/config?tenant=<id>  the visual subset of the tenant's config, cached 60 s
//   POST /widget/chat                {tenant, sessionId, messages} -> {reply}, or {error: code}
//
// Any site can embed the widget, so both answer cross-origin with `Access-Control-Allow-Origin: *`
// and read no cookie. Who may spend a tenant's quota is decided here, in this order, cheapest first:
// body shape, per-IP limit, plan, domain allowlist, per-tenant burst and monthly turn counts, a
// reservation recounted with itself included, and finally the gateway's spending caps. Every step
// that cannot get an answer from the store refuses: a count that failed is never read as zero.
//
// Responses carry a code, never prose: the widget owns the text the visitor reads. Log lines carry
// the tenant id and codes, never a message.

import { z } from 'zod';
import {
  ApiError,
  CapError,
  capWindows,
  ConfigError,
  GatewayError,
  RequestError,
  ReservationError,
  ResponseError,
  type Conversation,
  type Gateway,
} from '../../../gateway/src/index.ts';
import { claimedHost, createRateLimiter, hostAllowed, ipKey, readLimited, withTimeout } from './guards.ts';
import type { Limits } from './limits.ts';
import { MAX_TOKENS, TASK } from './model.ts';
import { PROMPT_VERSION, systemBlocks } from './prompt.ts';
import type { TenantStore } from './store.ts';
import { Count, PAUSED, Plan, publicConfig, TenantConfig, TenantId } from './tenant.ts';

export type LogFn = (event: string, data: Readonly<Record<string, string | number | boolean | null>>) => void;

export interface WidgetDeps {
  readonly store: TenantStore;
  /** Null when no API key is configured: config still answers, chat answers 503. */
  readonly gateway: Gateway | null;
  readonly limits: Limits;
  readonly now: () => Date;
  /** The caller's IP as the host knows it (a socket address, or a header the host's proxy sets). */
  readonly clientIp: (request: Request) => string | null;
  readonly newId?: () => string;
  readonly log?: LogFn;
}

export type ErrorCode =
  | 'bad_request'
  | 'unknown_tenant'
  | 'paused'
  | 'origin_not_allowed'
  | 'rate_limited'
  | 'busy'
  | 'monthly_limit'
  | 'spend_limit'
  | 'no_answer'
  | 'unavailable'
  | 'method_not_allowed'
  | 'not_found';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...CORS,
      ...headers,
    },
  });
}

const fail = (status: number, code: ErrorCode, headers: Record<string, string> = {}): Response => reply(status, { error: code }, headers);

const Message = z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string() });
const ChatBody = z.strictObject({
  tenant: TenantId,
  sessionId: z.guid(),
  messages: z.array(Message).min(1).max(200),
});
type Message = z.infer<typeof Message>;

/**
 * The last `max` messages as a conversation the gateway accepts: it starts and ends on a visitor
 * turn and alternates. A history that does not alternate is refused rather than repaired, since
 * only a client other than the widget sends one.
 *
 * A visitor turn over `maxChars` is refused. An assistant turn is cut to `maxReplyChars` instead:
 * it is an earlier reply of the model, which the visitor did not write and cannot shorten, so
 * refusing it would end the conversation.
 */
export function toConversation(messages: readonly Message[], max: number, maxChars: number, maxReplyChars: number): Conversation | null {
  let kept = messages.slice(-max).map((m) => {
    const content = m.content.trim();
    return { role: m.role, content: m.role === 'assistant' ? content.slice(0, maxReplyChars) : content };
  });
  while (kept[0]?.role === 'assistant') kept = kept.slice(1);
  const last = kept.at(-1);
  if (!last || last.role !== 'user') return null;
  for (const [i, m] of kept.entries()) {
    if (m.content === '' || (m.role === 'user' && m.content.length > maxChars)) return null;
    if (m.role !== (i % 2 === 0 ? 'user' : 'assistant')) return null;
  }
  const rest = kept.slice(0, -1);
  return [...rest, { role: 'user', content: last.content }];
}

/** The gateway refused before any request left: the turn spent nothing and is dropped. */
const refusedBeforeCalling = (e: unknown): boolean =>
  e instanceof CapError || e instanceof ConfigError || e instanceof RequestError || e instanceof ReservationError;

export interface WidgetApi {
  config(request: Request): Promise<Response>;
  chat(request: Request): Promise<Response>;
  preflight(): Response;
}

export function createWidgetApi(deps: WidgetDeps): WidgetApi {
  const { store, limits } = deps;
  const log: LogFn = deps.log ?? (() => undefined);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const byIp = createRateLimiter(limits.ipTurns, limits.ipWindowMs, () => deps.now().getTime());
  const timed = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, limits.storeTimeoutMs);

  /** The tenant's config and plan, parsed; or the response that refuses. */
  async function loadTenant(tenant: string): Promise<{ config: TenantConfig; plan: Plan } | Response> {
    let rows: [unknown, unknown];
    try {
      rows = await Promise.all([timed(store.getConfig(tenant)), timed(store.getPlan(tenant))]);
    } catch (e) {
      log('store_failed', { tenant, step: 'load', error: e instanceof Error ? e.name : 'unknown' });
      return fail(503, 'unavailable');
    }
    const [configRow, planRow] = rows;
    if (configRow === null || planRow === null) return fail(404, 'unknown_tenant');
    const config = TenantConfig.safeParse(configRow);
    const plan = Plan.safeParse(planRow);
    if (!config.success || !plan.success || config.data.tenantId !== tenant) {
      log('invalid_row', { tenant, config: config.success, plan: plan.success });
      return fail(503, 'unavailable');
    }
    if (PAUSED.has(plan.data.status)) return fail(403, 'paused');
    return { config: config.data, plan: plan.data };
  }

  /** Burst and month counts, or null when either failed or came back in the wrong shape. */
  async function counts(tenant: string, now: Date): Promise<{ burst: number; month: number } | null> {
    try {
      const since = new Date(now.getTime() - limits.burstWindowMs);
      const { monthStart } = capWindows(now, limits.timeZone);
      const [burst, month] = await Promise.all([timed(store.countTurnsSince(tenant, since)), timed(store.countTurnsSince(tenant, monthStart))]);
      const b = Count.safeParse(burst);
      const m = Count.safeParse(month);
      if (b.success && m.success) return { burst: b.data, month: m.data };
      log('invalid_count', { tenant });
      return null;
    } catch (e) {
      log('store_failed', { tenant, step: 'count', error: e instanceof Error ? e.name : 'unknown' });
      return null;
    }
  }

  async function drop(tenant: string, id: string): Promise<void> {
    // Best effort: a turn left reserved only makes the counts stricter.
    try {
      await timed(store.dropTurn(id));
    } catch (e) {
      log('store_failed', { tenant, step: 'drop', error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  async function config(request: Request): Promise<Response> {
    const tenant = TenantId.safeParse(new URL(request.url).searchParams.get('tenant') ?? '');
    if (!tenant.success) return fail(400, 'bad_request');
    const loaded = await loadTenant(tenant.data);
    if (loaded instanceof Response) return loaded;
    return reply(200, publicConfig(loaded.config), { 'cache-control': `public, max-age=${limits.configCacheSeconds}` });
  }

  async function chat(request: Request): Promise<Response> {
    const gateway = deps.gateway;
    if (!gateway) return fail(503, 'unavailable');

    // 1. Shape. Read with a byte limit, accepted as text/plain too: the widget sends a simple
    //    request, with no preflight, and nothing here relies on one.
    const text = await readLimited(request, limits.maxBodyBytes).catch(() => null);
    let json: unknown;
    try {
      json = text === null ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    const body = ChatBody.safeParse(json);
    if (!body.success) return fail(400, 'bad_request');
    const { tenant, sessionId } = body.data;
    const messages = toConversation(body.data.messages, limits.maxMessages, limits.maxMessageChars, limits.maxReplyChars);
    if (!messages) return fail(400, 'bad_request');

    // 2. Per IP, before the store is touched. A host that gives no address puts every such
    //    request in one shared bucket, which errs toward refusing.
    const ip = deps.clientIp(request);
    if (!byIp.allow(ip === null ? 'unknown' : ipKey(ip))) return fail(429, 'rate_limited', { 'retry-after': String(Math.ceil(limits.ipWindowMs / 1000)) });

    // 3. Tenant, plan and allowlist.
    const loaded = await loadTenant(tenant);
    if (loaded instanceof Response) return loaded;
    const { config: tenantConfig, plan } = loaded;
    if (!hostAllowed(claimedHost(request), tenantConfig.allowedDomains)) return fail(403, 'origin_not_allowed');

    // 4. Turn counts: a cheap early refusal.
    const monthlyCap = Math.min(limits.tenantMonthlyTurns, plan.monthlyTurns ?? Number.POSITIVE_INFINITY);
    const now = deps.now();
    const before = await counts(tenant, now);
    if (!before) return fail(503, 'unavailable');
    if (before.burst >= limits.tenantBurstTurns) return fail(429, 'busy');
    if (before.month >= monthlyCap) return fail(429, 'monthly_limit');

    // 5. Reserve, then count again with this turn included. Of k requests that arrive together,
    //    the last to insert sees all k, so at most the cap get through.
    const turnId = newId();
    try {
      await timed(store.reserveTurn({ id: turnId, tenantId: tenant, sessionId, at: now }));
    } catch (e) {
      log('store_failed', { tenant, step: 'reserve', error: e instanceof Error ? e.name : 'unknown' });
      return fail(503, 'unavailable');
    }
    const after = await counts(tenant, now);
    if (!after || after.burst > limits.tenantBurstTurns || after.month > monthlyCap) {
      await drop(tenant, turnId);
      if (!after) return fail(503, 'unavailable');
      return fail(429, after.month > monthlyCap ? 'monthly_limit' : 'busy');
    }

    // 6. The model, through the gateway and its spending caps.
    let answer: string;
    try {
      const result = await gateway.text({
        task: TASK,
        userId: tenantConfig.accountId,
        promptVersion: PROMPT_VERSION,
        maxTokens: MAX_TOKENS,
        system: systemBlocks(tenantConfig),
        messages,
        signal: request.signal,
      });
      answer = result.text.trim();
      const { meta } = result;
      try {
        await timed(
          store.finishTurn(turnId, {
            status: 'answered',
            model: meta.modelResponded,
            inputTokens: meta.tokens.input + meta.tokens.cacheRead + meta.tokens.cacheWrite5m + meta.tokens.cacheWrite1h,
            outputTokens: meta.tokens.output,
            costUsd: meta.costUsd,
          }),
        );
      } catch (e) {
        // The turn stays reserved and keeps counting; the spend is in the gateway's ledger.
        log('store_failed', { tenant, step: 'finish', error: e instanceof Error ? e.name : 'unknown' });
      }
    } catch (e) {
      const code = e instanceof GatewayError ? e.code : 'unexpected';
      log('chat_failed', { tenant, code });
      if (refusedBeforeCalling(e)) {
        await drop(tenant, turnId);
        return e instanceof CapError ? fail(429, 'spend_limit') : fail(503, 'unavailable');
      }
      // The request may have reached the API: the turn counts.
      await timed(store.finishTurn(turnId, { status: 'failed', errorCode: code })).catch(() => log('store_failed', { tenant, step: 'finish' }));
      if (e instanceof ApiError && e.retryable) return fail(503, 'unavailable', e.retryAfterSec !== null ? { 'retry-after': String(e.retryAfterSec) } : {});
      if (e instanceof ResponseError) return fail(502, 'no_answer');
      return fail(503, 'unavailable');
    }
    if (answer === '') return fail(502, 'no_answer');
    return reply(200, { reply: answer });
  }

  return { config, chat, preflight: () => new Response(null, { status: 204, headers: CORS }) };
}
