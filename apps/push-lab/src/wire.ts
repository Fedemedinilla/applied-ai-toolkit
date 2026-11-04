// What the page, the worker and the server say to each other. Browser-safe: no Node built-ins.

/** API paths, relative to the app's own URL, so the app works under any prefix. */
export const API = {
  publicKey: 'api/public-key',
  subscribe: 'api/subscribe',
  unsubscribe: 'api/unsubscribe',
  test: 'api/test',
  diagnose: 'api/diagnose',
  redirectCheck: 'api/redirect-check',
} as const;

export interface SubscriptionBody {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** The body for POST api/subscribe, from `PushSubscription.toJSON()`; null when a field is missing. */
export function subscriptionBody(json: PushSubscriptionJSON): SubscriptionBody | null {
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** Worker to page. */
export type WorkerMessage =
  | { readonly type: 'push'; readonly kind: string; readonly sentAt: number | null; readonly badge: number | null }
  | { readonly type: 'worker-info'; readonly badgeApi: boolean };

/** Page to worker. */
export type PageMessage = { readonly type: 'worker-info?' };

export function isWorkerMessage(data: unknown): data is WorkerMessage {
  if (typeof data !== 'object' || data === null || !('type' in data)) return false;
  return data.type === 'push' || data.type === 'worker-info';
}

/** The VAPID public key travels as base64url; `pushManager.subscribe` wants bytes. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
