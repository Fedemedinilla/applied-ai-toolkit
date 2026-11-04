// One handler for every route of the backend: a Request goes in, a Response comes out, so it runs
// under any host with the Fetch API. serve.ts wraps it for node:http and serves the build next to it.

import type { Gateway } from '../../../gateway/src/index.ts';
import type { Auth } from './auth.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { createPanelApi, type PanelDeps } from './panel-api.ts';
import type { AccountStore, TenantStore } from './store.ts';
import { createWidgetApi, type LogFn } from './widget-api.ts';

export interface AppDeps {
  readonly store: TenantStore & AccountStore;
  readonly gateway: Gateway | null;
  readonly auth: Auth;
  readonly publicBaseUrl: string;
  readonly adminPassword: string | null;
  readonly clientIp: (request: Request) => string | null;
  readonly limits?: Partial<Limits>;
  readonly now?: () => Date;
  readonly scrypt?: PanelDeps['scrypt'];
  readonly newId?: () => string;
  readonly log?: LogFn;
}

export type Handler = (request: Request) => Promise<Response>;

const notFound = (): Response =>
  new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const methodNotAllowed = (): Response =>
  new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });

export function createApp(deps: AppDeps): Handler {
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const shared = { limits, now, clientIp: deps.clientIp, ...(deps.newId ? { newId: deps.newId } : {}), ...(deps.log ? { log: deps.log } : {}) };
  const widget = createWidgetApi({ ...shared, store: deps.store, gateway: deps.gateway });
  const panel = createPanelApi({
    ...shared,
    store: deps.store,
    auth: deps.auth,
    publicBaseUrl: deps.publicBaseUrl,
    adminPassword: deps.adminPassword,
    ...(deps.scrypt ? { scrypt: deps.scrypt } : {}),
  });

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/widget/config' || path === '/widget/chat') {
      if (request.method === 'OPTIONS') return widget.preflight();
      if (path === '/widget/config') return request.method === 'GET' ? widget.config(request) : methodNotAllowed();
      return request.method === 'POST' ? widget.chat(request) : methodNotAllowed();
    }
    if (path.startsWith('/panel/api/')) return panel.handle(request, path.slice('/panel/api/'.length));
    return notFound();
  };
}
