// Sending one push: the payload, how long it may wait, and what to do with the answer.
//
// The cryptography (the VAPID signature and the aes128gcm payload encryption) is web-push's. A
// mistake in it is invisible until a notification does not arrive, and it is a standard with many
// steps, so it is not rewritten here.

import webpush, { type Urgency } from 'web-push';
import type { StoredSubscription, SubscriptionStore } from './store.ts';
import type { VapidConfig } from './vapid.ts';

/**
 * How long a message may wait at the push service (Apple's, Google's) while the phone is off or
 * has no signal: the Web Push `TTL` header, in seconds. After that it is dropped without a word.
 * Without the option, web-push sends four weeks (2,419,200 seconds), so every message states its
 * own.
 *
 * - `test` waits one hour. It answers "does it work now"; a test that shows up the next morning
 *   only confuses.
 * - `reminder` waits 24 hours: the shape of a real event (a new order, a booking). One that arrives
 *   late is still useful, one that never arrives is not. The source app sent everything with one
 *   hour at first, and a phone that was off overnight lost the message.
 */
export const MESSAGE_KINDS = {
  test: { ttl: 60 * 60, urgency: 'high' },
  reminder: { ttl: 24 * 60 * 60, urgency: 'normal' },
} as const satisfies Record<string, { ttl: number; urgency: Urgency }>;

export type MessageKind = keyof typeof MESSAGE_KINDS;

export const SEND_TIMEOUT_MS = 6000;

/** What the service worker receives (src/sw-core.ts parses it). */
export interface PushPayload {
  readonly kind: MessageKind;
  readonly title: string;
  readonly body: string;
  /** Opened on click, relative to the worker's scope. */
  readonly url: string;
  /** One notification per tag. Unique per test, so a second test does not silently replace the first. */
  readonly tag: string;
  /** The number for the app icon. Absent means "do not touch the badge", never zero. */
  readonly badge?: number;
  readonly sentAt: number;
}

const TEXT: Record<MessageKind, { title: string; body: string }> = {
  test: { title: 'Prueba de Push Lab', body: 'Si ves esto, las notificaciones llegan a este dispositivo.' },
  reminder: { title: 'Recordatorio de Push Lab', body: 'Este aviso podía esperar hasta 24 horas a que el teléfono se conectara.' },
};

export function payloadFor(kind: MessageKind, sentAt: number, badge: number | undefined): PushPayload {
  return {
    kind,
    ...TEXT[kind],
    url: './?from=notification',
    tag: `${kind}-${sentAt}`,
    ...(badge === undefined ? {} : { badge }),
    sentAt,
  };
}

export interface SendOptions {
  readonly ttl: number;
  readonly urgency: Urgency;
}

/** Sends one encrypted, signed message. Rejects with an error that carries `statusCode` when the push service answers outside 2xx. */
export type Sender = (subscription: StoredSubscription, payload: string, options: SendOptions) => Promise<void>;

/** The real sender. VAPID details go with each call, so no module-level state is set. */
export function webPushSender(vapid: VapidConfig, timeoutMs = SEND_TIMEOUT_MS): Sender {
  return async (subscription, payload, { ttl, urgency }) => {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
      TTL: ttl,
      urgency,
      timeout: timeoutMs,
      vapidDetails: vapid,
    });
  };
}

export type Delivery =
  | { readonly status: 'delivered' }
  /** The push service says this subscription no longer exists. */
  | { readonly status: 'gone'; readonly statusCode: 404 | 410; readonly removed: boolean }
  | { readonly status: 'failed'; readonly statusCode: number | null; readonly message: string };

function statusCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  const code = error.statusCode;
  return typeof code === 'number' ? code : null;
}

/**
 * Sends `payload` to one subscription. 404 and 410 mean the subscription died (the app was
 * removed, the permission revoked, the endpoint rotated), so it is deleted from the store; sending
 * to it again would fail the same way forever. Any other failure leaves it in place: a 5xx or a
 * timeout says nothing about the subscription. Never throws.
 */
export async function deliver(
  store: SubscriptionStore,
  send: Sender,
  subscription: StoredSubscription,
  payload: PushPayload,
): Promise<Delivery> {
  const { ttl, urgency } = MESSAGE_KINDS[payload.kind];
  try {
    await send(subscription, JSON.stringify(payload), { ttl, urgency });
    return { status: 'delivered' };
  } catch (error) {
    const statusCode = statusCodeOf(error);
    if (statusCode === 404 || statusCode === 410) {
      const removed = await store.remove(subscription.endpoint).catch(() => false);
      return { status: 'gone', statusCode, removed };
    }
    return { status: 'failed', statusCode, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The push services this server sends to, by host. Exact names or a dot-anchored suffix, so a
 * look-alike such as push.apple.com.example.test is not one of them.
 */
const PUSH_HOSTS: ReadonlyArray<{ readonly service: 'apple' | 'google' | 'mozilla' | 'windows'; readonly suffix: string; readonly exact?: boolean }> = [
  { service: 'apple', suffix: 'push.apple.com' },
  { service: 'google', suffix: 'fcm.googleapis.com', exact: true },
  { service: 'google', suffix: 'android.googleapis.com', exact: true },
  { service: 'mozilla', suffix: 'push.services.mozilla.com' },
  { service: 'windows', suffix: 'notify.windows.com' },
];

/** Which push service an endpoint belongs to, from its host. The endpoint itself is a credential and never leaves the server. */
export function serviceOf(endpoint: string): 'apple' | 'google' | 'mozilla' | 'windows' | 'other' {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'other';
  }
  // A port or credentials in the URL are never part of a push endpoint.
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return 'other';
  const host = url.hostname;
  const match = PUSH_HOSTS.find(({ suffix, exact }) => host === suffix || (!exact && host.endsWith(`.${suffix}`)));
  return match?.service ?? 'other';
}

/**
 * True when POST /api/test may send to this endpoint. The test route makes the server send a
 * request to whatever the endpoint names, so anything outside the known push services is refused:
 * otherwise a visitor could point the server at an internal host and read the status back.
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
  return serviceOf(endpoint) !== 'other';
}
