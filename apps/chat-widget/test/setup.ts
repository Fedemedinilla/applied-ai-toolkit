// Builds the whole backend for a test: the in-memory store with two fictional tenants, the real
// gateway and SDK client against the fake API, a clock the test moves, and scrypt at its lowest
// accepted cost so the suite stays fast (one test checks the production parameters).

import { createApp, type Handler } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import type { Limits } from '../server/limits.ts';
import { createChatModel, type ChatModel, type SpendCaps } from '../server/model.ts';
import { MemoryStore } from '../server/store.ts';
import { fakeAnthropic, type Reply } from './fake-anthropic.ts';

export const SECRET = 'test-secret-that-is-at-least-32-bytes-long';
export const BASE = 'https://widget.example';
export const ADMIN = 'operator password for tests';
export const FAST_SCRYPT = { N: 1 << 14, r: 8, p: 1 };

export const BAKERY = {
  tenantId: 'panaderia-sol',
  accountId: '11111111-1111-4111-8111-111111111111',
  email: 'owner@panaderia-sol.example',
  botName: 'Panadería Sol',
  header: 'Panadería Sol',
  context: 'Abrimos de lunes a sábado de 7 a 20 h. Hacemos tortas por encargo con 48 h de anticipación.',
  faq: 'P: ¿Tienen opciones sin gluten?\nR: Sí, pan y galletas, todos los días.',
  allowedDomains: ['panaderia-sol.example'],
};

export const WORKSHOP = {
  tenantId: 'taller-rueda',
  accountId: '22222222-2222-4222-8222-222222222222',
  email: 'owner@taller-rueda.example',
  botName: 'Taller Rueda',
  header: 'Taller Rueda',
  context: 'Arreglamos bicicletas de martes a sábado.',
  allowedDomains: ['taller-rueda.example'],
};

export interface Clock {
  now: Date;
  advance(ms: number): void;
}

export interface Setup {
  readonly app: Handler;
  readonly store: MemoryStore;
  readonly api: ReturnType<typeof fakeAnthropic>;
  readonly model: ChatModel;
  readonly clock: Clock;
  readonly logged: Array<{ event: string; data: Readonly<Record<string, unknown>> }>;
}

export interface SetupOptions {
  readonly replies?: readonly Reply[];
  readonly limits?: Partial<Limits>;
  readonly caps?: SpendCaps;
  readonly store?: MemoryStore;
  readonly ip?: (request: Request) => string | null;
}

export function setup(options: SetupOptions = {}): Setup {
  let now = new Date('2026-11-04T15:00:00Z');
  const clock: Clock = {
    get now() {
      return now;
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
  const store = options.store ?? new MemoryStore();
  if (!options.store) {
    store.putTenant(BAKERY);
    store.putTenant(WORKSHOP);
  }
  const api = fakeAnthropic(options.replies ?? []);
  const model = createChatModel({
    apiKey: 'sk-fake',
    fetch: api.fetch,
    clock: { now: () => now, monotonicMs: () => now.getTime() },
    timeZone: 'UTC',
    log: () => undefined,
    ...(options.caps ? { caps: options.caps } : {}),
  });
  const logged: Setup['logged'] = [];
  const app = createApp({
    store,
    gateway: model.gateway,
    auth: createAuth(SECRET, () => now),
    publicBaseUrl: BASE,
    adminPassword: ADMIN,
    clientIp: options.ip ?? ((request) => request.headers.get('x-test-ip') ?? '192.0.2.10'),
    now: () => now,
    scrypt: FAST_SCRYPT,
    ...(options.limits ? { limits: options.limits } : {}),
    log: (event, data) => logged.push({ event, data }),
  });
  return { app, store, api, model, clock, logged };
}

export interface ChatInit {
  readonly tenant?: string;
  readonly origin?: string | null;
  readonly referer?: string;
  readonly ip?: string;
  readonly messages?: unknown;
  readonly sessionId?: string;
  readonly raw?: string;
  readonly contentType?: string;
}

export function chat(init: ChatInit = {}): Request {
  const headers: Record<string, string> = { 'content-type': init.contentType ?? 'text/plain;charset=UTF-8' };
  const origin = init.origin === undefined ? 'https://www.panaderia-sol.example' : init.origin;
  if (origin !== null) headers['origin'] = origin;
  if (init.referer) headers['referer'] = init.referer;
  if (init.ip) headers['x-test-ip'] = init.ip;
  const body =
    init.raw ??
    JSON.stringify({
      tenant: init.tenant ?? BAKERY.tenantId,
      sessionId: init.sessionId ?? '33333333-3333-4333-8333-333333333333',
      messages: init.messages ?? [{ role: 'user', content: '¿Hacen tortas por encargo?' }],
    });
  return new Request(`${BASE}/widget/chat`, { method: 'POST', headers, body });
}

export const config = (tenant: string): Request => new Request(`${BASE}/widget/config?tenant=${encodeURIComponent(tenant)}`);

/** Each listed method of the store throws (or answers `value`) instead of doing its work. */
export function breakStore<K extends keyof MemoryStore>(store: MemoryStore, method: K, behaviour: 'throw' | 'hang' | { value: unknown }): void {
  const replacement = async (): Promise<unknown> => {
    if (behaviour === 'throw') throw new Error('database is down');
    if (behaviour === 'hang') return new Promise(() => undefined);
    return behaviour.value;
  };
  Object.defineProperty(store, method, { value: replacement, configurable: true });
}
