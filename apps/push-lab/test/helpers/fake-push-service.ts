// The last step before the network, replaced. web-push does all of its own work for real
// (validates the options, encrypts the payload, signs the VAPID JWT) and calls https.request; this
// records the request it would have sent and answers with a status chosen per endpoint path.
//
// Replacing webpush.sendNotification instead would test what our code passes to the library, not
// what leaves the machine. A misspelled option (`ttl`) is refused by web-push, and a forgotten one
// goes out as four weeks; both are visible here, and the first tests in ttl.test.ts show it.

import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createECDH, randomBytes } from 'node:crypto';
import type { NewSubscription } from '../../server/store.ts';

export interface SentRequest {
  readonly host: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: number;
}

type RequestFn = typeof https.request;

export interface FakePushService {
  readonly sent: SentRequest[];
  /** Status code to answer for an endpoint path; 201 when absent. */
  readonly statusFor: Map<string, number>;
  restore(): void;
}

export function installFakePushService(): FakePushService {
  const sent: SentRequest[] = [];
  const statusFor = new Map<string, number>();
  const real: RequestFn = https.request;

  const fake = (options: { hostname?: string; path?: string; headers?: Record<string, unknown> }, onResponse: (res: EventEmitter & { statusCode: number; headers: object }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write(b: Buffer): boolean; end(): void; destroy(): void };
    let bytes = 0;
    req.write = (b: Buffer) => {
      bytes += b.length;
      return true;
    };
    req.destroy = () => undefined;
    req.end = () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.headers ?? {})) headers[k] = String(v);
      const path = String(options.path);
      sent.push({ host: String(options.hostname), path, headers, bytes });
      const res = Object.assign(new EventEmitter(), { statusCode: statusFor.get(path) ?? 201, headers: {} });
      setImmediate(() => {
        onResponse(res);
        res.emit('end');
      });
    };
    return req;
  };

  // web-push calls https.request on the module object at send time, so a property swap reaches it.
  Object.assign(https, { request: fake });
  return {
    sent,
    statusFor,
    restore: () => {
      Object.assign(https, { request: real });
    },
  };
}

/** A browser subscription with valid keys, so web-push really encrypts against it. Host under .test. */
export function fakeDevice(id: string): NewSubscription {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://push.example.test/device-${id}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}
