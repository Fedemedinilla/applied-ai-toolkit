// The server side of the lab: one function from Request to Response, with no framework. It runs
// under node:http (server/node-server.ts) and fits any runtime that speaks the Fetch API.
//
// Routes are matched on the end of the path, so the app can be mounted under any prefix:
//
//   GET  …/api/public-key      the VAPID public key the browser subscribes with
//   POST …/api/subscribe       store or refresh this device's subscription (idempotent)
//   POST …/api/unsubscribe     forget it
//   POST …/api/test            push to this device only, with a message kind and a badge number
//   GET  …/api/diagnose        what is configured and what is missing; never an endpoint or a key
//   GET  …/api/redirect-check  a bare 302, for checking that the worker leaves navigations alone
//
// A test push goes to the device that asks for it, named by its own endpoint. A public demo that
// pushed to every subscriber would let any visitor notify everyone else. And the endpoint must
// belong to a known push service: POST /api/test makes this server send a request to it, so an
// open endpoint field would let any visitor point the server at an arbitrary host.

import { z } from 'zod';
import { deliver, isPushServiceEndpoint, MESSAGE_KINDS, payloadFor, serviceOf, type Sender } from './push.ts';
import { StoreFullError, type StoredSubscription, type SubscriptionStore } from './store.ts';
import { checkVapid, type VapidConfig } from './vapid.ts';

export interface HandlerDeps {
  readonly store: SubscriptionStore;
  readonly send: Sender;
  readonly vapid: VapidConfig;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Minimum time between two test pushes to one device. */
  readonly minIntervalMs?: number;
  /**
   * Accept endpoints outside the known push services. Off by default: only the tests turn it on,
   * for their fake service at push.example.test.
   */
  readonly allowAnyEndpoint?: boolean;
}

/** Error codes the page maps to its own messages (src/messages.ts). */
export type ErrorCode =
  | 'not_found'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_subscription'
  | 'unknown_push_service'
  | 'invalid_request'
  | 'not_configured'
  | 'store_failed'
  | 'store_full'
  | 'not_subscribed'
  | 'too_soon'
  | 'gone'
  | 'push_failed';

export type Problem =
  | 'vapid_keys_missing'
  | 'public_key_format'
  | 'private_key_format'
  | 'vapid_pair_mismatch'
  | 'subject_invalid'
  | 'store_failed'
  | 'no_subscriptions';

export const MAX_BODY_BYTES = 4096;
export const MAX_DELAY_SECONDS = 5;

const base64url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u)
    .refine((s) => Buffer.from(s, 'base64url').length === bytes);

// The endpoint is issued by the browser's push service and is always https. 2000 characters, not
// less: some services issue long endpoints, and a legitimate device refused as "invalid" sends
// whoever debugs it to look in the wrong place.
const endpoint = z
  .string()
  .trim()
  .max(2000)
  .refine((s) => URL.canParse(s) && new URL(s).protocol === 'https:');

const Keys = z.object({ p256dh: base64url(65).refine((s) => Buffer.from(s, 'base64url')[0] === 0x04), auth: base64url(16) });
const Kind = z.enum(Object.keys(MESSAGE_KINDS) as [keyof typeof MESSAGE_KINDS]);
// null and absent both mean "leave the badge as it is"; 0 clears it.
const Badge = z.number().int().min(0).max(999).nullable().optional();
const Delay = z.number().int().min(0).max(MAX_DELAY_SECONDS).optional();

const SubscribeBody = z.object({ endpoint, keys: Keys });
const UnsubscribeBody = z.object({ endpoint });
const TestBody = z.object({ endpoint, kind: Kind, badge: Badge, delaySeconds: Delay });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const fail = (error: ErrorCode, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  json({ error, ...extra }, status, headers);

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * The body as text, or null once more than `limit` bytes have arrived. Read chunk by chunk, so a
 * chunked request with no Content-Length is cut off at the limit instead of buffered whole.
 */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody<T>(request: Request, schema: z.ZodType<T>, invalid: ErrorCode): Promise<Parsed<T>> {
  const type = request.headers.get('content-type') ?? '';
  // JSON only. A cross-site HTML form cannot send application/json without a CORS preflight.
  if (!/^application\/json\b/iu.test(type)) return { ok: false, response: fail('unsupported_media_type', 415) };
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return { ok: false, response: fail('payload_too_large', 413) };
  const text = await readLimited(request, MAX_BODY_BYTES);
  if (text === null) return { ok: false, response: fail('payload_too_large', 413) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: fail('invalid_json', 400) };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, response: fail(invalid, 400) };
}

/** The diagnosis problems for one VAPID check, in the order to fix them. */
function vapidProblems(check: ReturnType<typeof checkVapid>): Problem[] {
  if (!check.publicKeyPresent || !check.privateKeyPresent) return ['vapid_keys_missing'];
  const problems: Problem[] = [];
  if (!check.publicKeyFormatOk) problems.push('public_key_format');
  if (!check.privateKeyFormatOk) problems.push('private_key_format');
  if (check.publicKeyFormatOk && check.privateKeyFormatOk && !check.pairMatches) problems.push('vapid_pair_mismatch');
  if (!check.subjectOk) problems.push('subject_invalid');
  return problems;
}

export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minIntervalMs = deps.minIntervalMs ?? 3000;
  const vapid = checkVapid(deps.vapid);
  // Its own error code, so a refused host does not read as a malformed subscription.
  const refuseHost = (endpoint: string): Response | null =>
    deps.allowAnyEndpoint === true || isPushServiceEndpoint(endpoint) ? null : fail('unknown_push_service', 400);
  // When each device last got a test. Every new entry first drops the ones older than
  // minIntervalMs, the only age that matters, so the map holds at most the devices tested within
  // one interval. Unsubscribing does not clear an entry: otherwise unsubscribe and subscribe again
  // would skip the limit.
  const lastSent = new Map<string, number>();
  const markSent = (endpoint: string): void => {
    const t = now();
    for (const [key, at] of lastSent) if (t - at >= minIntervalMs) lastSent.delete(key);
    lastSent.set(endpoint, t);
  };

  const routes: Record<string, { method: 'GET' | 'POST'; run: (request: Request) => Promise<Response> }> = {
    'public-key': {
      method: 'GET',
      // Not a secret: the browser needs it to subscribe. Withheld when the pair cannot sign, so a
      // device never subscribes with a key whose pushes will all be refused.
      run: async () => (vapid.ok ? json({ publicKey: deps.vapid.publicKey }) : fail('not_configured', 503)),
    },

    subscribe: {
      method: 'POST',
      run: async (request) => {
        const parsed = await readBody(request, SubscribeBody, 'invalid_subscription');
        if (!parsed.ok) return parsed.response;
        const refused = refuseHost(parsed.value.endpoint);
        if (refused) return refused;
        try {
          const result = await deps.store.put(parsed.value);
          return json({ result }, result === 'created' ? 201 : 200);
        } catch (error) {
          return error instanceof StoreFullError ? fail('store_full', 503) : fail('store_failed', 503);
        }
      },
    },

    unsubscribe: {
      method: 'POST',
      run: async (request) => {
        const parsed = await readBody(request, UnsubscribeBody, 'invalid_subscription');
        if (!parsed.ok) return parsed.response;
        try {
          return json({ removed: await deps.store.remove(parsed.value.endpoint) });
        } catch {
          return fail('store_failed', 503);
        }
      },
    },

    test: {
      method: 'POST',
      run: async (request) => {
        const parsed = await readBody(request, TestBody, 'invalid_request');
        if (!parsed.ok) return parsed.response;
        const test = parsed.value;
        const refused = refuseHost(test.endpoint);
        if (refused) return refused;
        if (!vapid.ok) return fail('not_configured', 503);

        // Three different answers, on purpose. "The store failed" must not read as "you are not
        // subscribed": the advice for the second (subscribe again) is harmful for the first.
        let subscription: StoredSubscription | undefined;
        try {
          subscription = await deps.store.get(test.endpoint);
        } catch {
          return fail('store_failed', 503);
        }
        if (!subscription) return fail('not_subscribed', 404);

        const last = lastSent.get(subscription.endpoint);
        if (last !== undefined && now() - last < minIntervalMs) {
          const wait = Math.ceil((minIntervalMs - (now() - last)) / 1000);
          return fail('too_soon', 429, { retryAfterSeconds: wait }, { 'retry-after': String(wait) });
        }
        markSent(subscription.endpoint);

        // A short wait, so the tester can leave the app or lock the screen before the push lands.
        if (test.delaySeconds) await sleep(test.delaySeconds * 1000);

        const kind = test.kind;
        const payload = payloadFor(kind, now(), test.badge ?? undefined);
        const delivery = await deliver(deps.store, deps.send, subscription, payload);
        const ttl = MESSAGE_KINDS[kind].ttl;
        if (delivery.status === 'delivered') return json({ status: 'delivered', kind, ttl });
        if (delivery.status === 'gone') {
          lastSent.delete(subscription.endpoint);
          return fail('gone', 410, { statusCode: delivery.statusCode, removed: delivery.removed });
        }
        // The endpoint is on a known push service (refuseHost), so its status says something about
        // that service and nothing about any other host.
        return fail('push_failed', 502, { statusCode: delivery.statusCode });
      },
    },

    diagnose: {
      method: 'GET',
      run: async () => {
        const problems = vapidProblems(vapid);
        // null, never 0, when the store could not be read: "no devices" and "could not count
        // them" lead to opposite fixes.
        let store: { ok: true; subscriptions: number; services: Record<string, number> } | { ok: false; subscriptions: null };
        try {
          const rows = await deps.store.list();
          const services: Record<string, number> = {};
          for (const row of rows) {
            const service = serviceOf(row.endpoint);
            services[service] = (services[service] ?? 0) + 1;
          }
          store = { ok: true, subscriptions: rows.length, services };
          if (rows.length === 0) problems.push('no_subscriptions');
        } catch {
          store = { ok: false, subscriptions: null };
          problems.push('store_failed');
        }
        const { ok, ...keys } = vapid;
        return json({ ready: ok && store.ok, vapid: keys, store, messageKinds: MESSAGE_KINDS, problems });
      },
    },

    // A 302 with no body and no content-type, the response WebKit mishandled when a service worker
    // returned it from respondWith. Our worker does not touch navigations, so this lands on the app.
    'redirect-check': {
      method: 'GET',
      run: async () => new Response(null, { status: 302, headers: { location: '../?redirected=1', 'cache-control': 'no-store' } }),
    },
  };

  return async (request) => {
    const match = /\/api\/([a-z-]+)$/u.exec(new URL(request.url).pathname);
    const route = match?.[1] === undefined ? undefined : routes[match[1]];
    if (!route) return fail('not_found', 404);
    if (request.method !== route.method) return fail('method_not_allowed', 405, {}, { allow: route.method });
    return route.run(request);
  };
}
