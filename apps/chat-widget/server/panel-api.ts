// The panel's JSON API, same-origin only. The tenant id always comes from the signed session,
// never from the request body: that is what keeps one owner out of another tenant's row.
//
//   POST /panel/api/login           {email, password} -> session cookie
//   POST /panel/api/logout
//   GET  /panel/api/me              the editable content and the install snippet
//   PUT  /panel/api/content         a ContentPatch
//   POST /panel/api/invite/check    {token} -> {email}
//   POST /panel/api/invite/accept   {token, password}
//   POST /panel/api/admin/invite    Basic auth; {tenantId, email, allowedDomains} -> {inviteUrl}
//
// Every write needs an Origin equal to the panel's own and a JSON content type, so a form or a
// fetch from another site cannot reach it even before the SameSite cookie is considered.

import { z } from 'zod';
import {
  basicAuthOk,
  clearSessionCookie,
  hashPassword,
  INVITE_MAX_AGE_S,
  readCookie,
  SCRYPT_PARAMS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  sessionCookie,
  verifyPassword,
  type Auth,
  type ScryptParams,
} from './auth.ts';
import { createRateLimiter, ipKey, readLimited, withTimeout } from './guards.ts';
import type { Limits } from './limits.ts';
import type { AccountStore, TenantStore } from './store.ts';
import { ContentPatch, DomainName, Owner, TenantConfig, TenantId } from './tenant.ts';
import type { LogFn } from './widget-api.ts';

export interface PanelDeps {
  readonly store: AccountStore & Pick<TenantStore, 'getConfig'>;
  readonly auth: Auth;
  readonly limits: Limits;
  readonly now: () => Date;
  readonly clientIp: (request: Request) => string | null;
  /** Where the deploy is served, such as https://widget.example. The snippet and invite links use it. */
  readonly publicBaseUrl: string;
  /** The operator's password for /panel/api/admin. Null turns the admin route off. */
  readonly adminPassword: string | null;
  /** Lower only in tests: the default is the OWASP minimum. */
  readonly scrypt?: ScryptParams;
  readonly newId?: () => string;
  readonly log?: LogFn;
}

export const MIN_PASSWORD = 10;
/** The operator password can create tenants and take over any owner through a new invite. */
export const MIN_ADMIN_PASSWORD = 16;
const MAX_PASSWORD = 200;
/**
 * A full content patch (20,000 characters of context, 10,000 of FAQ) is under this even in
 * three-byte UTF-8. The body is read chunk by chunk and cut here, before any of it is parsed.
 */
export const MAX_PANEL_BODY_BYTES = 128 * 1024;

/** A body past MAX_PANEL_BODY_BYTES: answered 413 before anything else is read. */
class BodyTooLarge extends Error {
  constructor() {
    super('panel request body over the limit');
    this.name = 'BodyTooLarge';
  }
}

const Login = z.strictObject({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(MAX_PASSWORD) });
const InviteCheck = z.strictObject({ token: z.string().max(2048) });
const InviteAccept = z.strictObject({ token: z.string().max(2048), password: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD) });
const AdminInvite = z.strictObject({
  tenantId: TenantId,
  email: z.email().trim().toLowerCase(),
  allowedDomains: z.array(DomainName).min(1).max(20),
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}
const fail = (status: number, code: string, headers: Record<string, string> = {}): Response => reply(status, { error: code }, headers);

/** The single line the owner pastes into their site. No inline script, so a strict CSP on their site still allows it. */
export function installSnippet(publicBaseUrl: string, tenantId: string): string {
  const base = publicBaseUrl.replace(/\/+$/u, '');
  return `<script src="${base}/embed/chat.js" data-tenant="${tenantId}" async></script>`;
}

/** The token goes in the fragment: browsers never send it to the server, in Referer or in access logs. */
export function inviteUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/u, '')}/panel/#invite=${token}`;
}

export interface PanelApi {
  handle(request: Request, route: string): Promise<Response>;
}

export function createPanelApi(deps: PanelDeps): PanelApi {
  const { store, auth, limits } = deps;
  if (deps.adminPassword !== null && deps.adminPassword.length < MIN_ADMIN_PASSWORD) {
    // Refused at startup: a short operator password is a misconfiguration, not a runtime case.
    throw new Error(`chat-widget: the admin password needs at least ${MIN_ADMIN_PASSWORD} characters`);
  }
  const log: LogFn = deps.log ?? (() => undefined);
  const params = deps.scrypt ?? SCRYPT_PARAMS;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const panelOrigin = new URL(deps.publicBaseUrl).origin;
  const logins = createRateLimiter(limits.loginAttempts, limits.ipWindowMs, () => deps.now().getTime());
  // Failed operator logins, apart from owner logins: the operator password can create tenants and
  // reissue any owner's invite, so guessing it must be as slow as guessing an owner's.
  const adminFailures = createRateLimiter(limits.loginAttempts, limits.ipWindowMs, () => deps.now().getTime());
  const ipOf = (request: Request): string => {
    const ip = deps.clientIp(request);
    return ip === null ? 'unknown' : ipKey(ip);
  };
  const timed = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, limits.storeTimeoutMs);
  // Unknown emails are checked against this hash, so a miss takes as long as a wrong password.
  let dummy: Promise<string> | null = null;
  const dummyHash = (): Promise<string> => (dummy ??= hashPassword('not a password', params));

  async function readJson(request: Request): Promise<unknown> {
    const type = request.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) return undefined;
    const text = await readLimited(request, MAX_PANEL_BODY_BYTES).catch(() => '');
    if (text === null) throw new BodyTooLarge();
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** The Origin must be the panel's own. A missing Origin is refused: every browser sends one on these requests. */
  const sameOrigin = (request: Request): boolean => request.headers.get('origin') === panelOrigin;

  async function owner(tenantId: string): Promise<Owner | null> {
    const row = await timed(store.ownerOf(tenantId));
    const parsed = Owner.safeParse(row);
    return parsed.success ? parsed.data : null;
  }

  /** The session's tenant, if the cookie is valid and was issued for the current password. */
  async function session(request: Request): Promise<string | null> {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return null;
    const claim = auth.verify(token, 'session');
    if (!claim) return null;
    const current = await owner(claim.tenantId);
    if (!current?.passwordHash || !auth.same(claim.n, auth.hashTag(current.passwordHash))) return null;
    return claim.tenantId;
  }

  async function login(request: Request): Promise<Response> {
    if (!logins.allow(ipOf(request))) return fail(429, 'rate_limited');
    const body = Login.safeParse(await readJson(request));
    if (!body.success) return fail(400, 'bad_request');
    const found = Owner.safeParse(await timed(store.ownerByEmail(body.data.email)));
    const stored = found.success ? found.data.passwordHash : null;
    const result = await verifyPassword(body.data.password, stored ?? (await dummyHash()), params);
    if (!found.success || stored === null || !result.ok) return fail(401, 'bad_credentials');
    let hash = stored;
    if (result.needsRehash) {
      // The password is known only now, so this is the one moment a weaker hash can be replaced.
      const next = await hashPassword(body.data.password, params);
      if (await timed(store.replacePasswordHash(found.data.tenantId, stored, next)).catch(() => false)) hash = next;
      log('password_rehashed', { tenant: found.data.tenantId, replaced: hash === next });
    }
    const token = auth.sign('session', found.data.tenantId, auth.hashTag(hash), SESSION_MAX_AGE_S);
    return reply(200, { ok: true }, { 'set-cookie': sessionCookie(token) });
  }

  async function me(tenantId: string): Promise<Response> {
    const config = TenantConfig.safeParse(await timed(store.getConfig(tenantId)));
    if (!config.success) return fail(503, 'unavailable');
    const { botName, welcome, suggestedQuestions, tonePreset, tone, context, faq } = config.data;
    return reply(200, {
      tenantId,
      content: { botName, welcome, suggestedQuestions, tonePreset, tone, context, faq },
      snippet: installSnippet(deps.publicBaseUrl, tenantId),
    });
  }

  async function saveContent(request: Request, tenantId: string): Promise<Response> {
    const patch = ContentPatch.safeParse(await readJson(request));
    if (!patch.success) return reply(400, { error: 'bad_request', fields: patch.error.issues.map((i) => i.path.join('.')) });
    await timed(store.saveContent(tenantId, patch.data));
    log('content_saved', { tenant: tenantId, fields: Object.keys(patch.data).join(',') });
    return reply(200, { ok: true });
  }

  /** A valid invite for an owner whose stored nonce still matches. */
  async function checkInvite(token: string): Promise<{ tenantId: string; nonce: string; email: string } | null> {
    const claim = auth.verify(token, 'invite');
    if (!claim) return null;
    const current = await owner(claim.tenantId);
    if (!current?.inviteNonce || !auth.same(current.inviteNonce, claim.n)) return null;
    return { tenantId: claim.tenantId, nonce: claim.n, email: current.email };
  }

  async function adminInvite(request: Request): Promise<Response> {
    const ip = ipOf(request);
    if (adminFailures.atLimit(ip)) return fail(429, 'rate_limited', { 'retry-after': String(Math.ceil(limits.ipWindowMs / 1000)) });
    if (!basicAuthOk(request, deps.adminPassword, auth)) {
      adminFailures.allow(ip); // counts this failure
      log('admin_auth_failed', {});
      return fail(401, 'unauthorized', { 'www-authenticate': 'Basic realm="chat-widget admin"' });
    }
    const body = AdminInvite.safeParse(await readJson(request));
    if (!body.success) return fail(400, 'bad_request');
    const { tenantId, email, allowedDomains } = body.data;
    const created = await timed(store.createTenant({ tenantId, accountId: newId(), email, allowedDomains }));
    const current = await owner(tenantId);
    if (!current || current.email !== email) return fail(409, 'conflict');
    // A new nonce voids every earlier link for this owner. Accepting it sets or resets the password,
    // and a reset password ends every open session (see session()).
    const nonce = newId();
    await timed(store.setInviteNonce(tenantId, nonce));
    log('invite_issued', { tenant: tenantId, created: created === 'created' });
    return reply(200, { inviteUrl: inviteUrl(deps.publicBaseUrl, auth.sign('invite', tenantId, nonce, INVITE_MAX_AGE_S)) });
  }

  async function route(request: Request, path: string): Promise<Response> {
    const method = request.method;
    const writes = method !== 'GET' && method !== 'HEAD';
    if (writes && !sameOrigin(request)) return fail(403, 'cross_origin');

    if (path === 'login') return method === 'POST' ? login(request) : fail(405, 'method_not_allowed');
    if (path === 'logout') return method === 'POST' ? reply(200, { ok: true }, { 'set-cookie': clearSessionCookie() }) : fail(405, 'method_not_allowed');
    if (path === 'admin/invite') return method === 'POST' ? adminInvite(request) : fail(405, 'method_not_allowed');
    if (path === 'invite/check' || path === 'invite/accept') {
      if (method !== 'POST') return fail(405, 'method_not_allowed');
      if (path === 'invite/check') {
        const body = InviteCheck.safeParse(await readJson(request));
        const invite = body.success ? await checkInvite(body.data.token) : null;
        return invite ? reply(200, { email: invite.email }) : fail(410, 'invite_invalid');
      }
      const body = InviteAccept.safeParse(await readJson(request));
      if (!body.success) return fail(400, 'bad_request');
      const invite = await checkInvite(body.data.token);
      if (!invite) return fail(410, 'invite_invalid');
      const hash = await hashPassword(body.data.password, params);
      // The store compares the nonce again as it writes, so two tabs cannot both use one link.
      if (!(await timed(store.acceptInvite(invite.tenantId, invite.nonce, hash)))) return fail(410, 'invite_invalid');
      const token = auth.sign('session', invite.tenantId, auth.hashTag(hash), SESSION_MAX_AGE_S);
      return reply(200, { ok: true }, { 'set-cookie': sessionCookie(token) });
    }

    const tenantId = await session(request);
    if (tenantId === null) return fail(401, 'unauthorized', { 'set-cookie': clearSessionCookie() });
    if (path === 'me') return method === 'GET' ? me(tenantId) : fail(405, 'method_not_allowed');
    if (path === 'content') return method === 'PUT' ? saveContent(request, tenantId) : fail(405, 'method_not_allowed');
    return fail(404, 'not_found');
  }

  return {
    async handle(request, path) {
      try {
        return await route(request, path);
      } catch (e) {
        if (e instanceof BodyTooLarge) return fail(413, 'too_large');
        log('panel_failed', { route: path, error: e instanceof Error ? e.name : 'unknown' });
        return fail(503, 'unavailable');
      }
    },
  };
}
