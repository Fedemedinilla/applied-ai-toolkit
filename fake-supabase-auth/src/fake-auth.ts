/**
 * A fake Supabase Auth (GoTrue) and PostgREST, as a fetch function. It is meant for the real
 * @supabase/supabase-js client: pass `fake.fetch` as `global.fetch` to createClient (or install it
 * with vi.stubGlobal('fetch', ...)), and the client's own code builds the requests, parses the
 * responses, verifies the JWTs, retries and decides when a session is gone. Nothing reaches the
 * network.
 *
 * Auth answers the routes a server-rendered app uses: /otp and /verify (email code sign-in),
 * /token with grant_type=pkce (an OAuth callback) and grant_type=refresh_token, /user, /logout and
 * /.well-known/jwks.json. Access tokens are signed with ES256, like a project with asymmetric keys,
 * or with HS256 when `knobs.symmetric` is set, like a project on the shared JWT secret. Error bodies
 * follow the shape Auth returns ({ code, error_code, msg }), so auth-js maps them to the same error
 * classes and codes it would in production.
 *
 * The knobs are plain mutable fields, read on every request, so a test can change them between
 * two calls of the same client.
 */
import {
  createSigningKeys,
  s256Challenge,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type JwtAlgorithm,
} from './jwt.ts';

export interface FakeUser {
  readonly id: string;
  readonly email: string;
}

/** One request as the fake received it. `body` is the parsed JSON, or null when there was none. */
export interface RecordedRequest {
  readonly method: string;
  /** The pathname, for example '/auth/v1/token' or '/rest/v1/notes'. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly body: unknown;
}

/** What PostgREST answers. Without one, every /rest/v1 request gets a 404. */
export type RestHandler = (request: RecordedRequest) => Response | Promise<Response>;

/** Answers a request before the fake does; undefined lets the fake answer as usual. */
export type Override = (request: RecordedRequest) => Response | undefined | Promise<Response | undefined>;

export interface Knobs {
  /** Lifetime in seconds of the next sessions Auth issues. Negative: already expired. */
  expiresIn: number;
  /**
   * While true, issued access tokens carry `otherUserId` as their sub with the signature of the
   * original payload: a token someone edited to pass as another user.
   */
  tamper: boolean;
  /**
   * While a number, every Auth request answers that status with a body that is not JSON, like
   * Auth down behind the gateway (502, 503, 504). PostgREST is not affected.
   */
  failWith: number | null;
  /** While true, every request (Auth and PostgREST) waits until its signal aborts. */
  hang: boolean;
  /**
   * Milliseconds before a route answers, keyed by pathname ('/auth/v1/verify'). A request aborted
   * during the wait fails the way Node's fetch does.
   */
  delays: Record<string, number>;
  /** While true, new sessions are signed with HS256 and no kid, and the JWKS is empty. */
  symmetric: boolean;
  /** Runs before the fake answers any route: a 429 on /otp, a hook rejection, a 500 once. */
  override: Override | null;
  /** PostgREST. See restTables() in rest.ts for a ready-made one. */
  rest: RestHandler | null;
}

export interface FakeSupabaseOptions {
  /** Defaults to http://supabase.test. Only the fake ever sees it. */
  readonly url?: string;
  /** Defaults to sb_publishable_fake. A request with any other apikey gets a 401. */
  readonly publishableKey?: string;
  /** Users that exist before the test starts. Defaults to one user. */
  readonly users?: readonly FakeUser[];
  /** The only code /verify accepts. Defaults to 123456. */
  readonly otpCode?: string;
}

export interface FakeSupabase {
  readonly fetch: typeof fetch;
  readonly url: string;
  readonly publishableKey: string;
  readonly otpCode: string;
  /** The first user in `options.users`, or the default one. */
  readonly user: FakeUser;
  /** The sub a tampered token claims: a user that does not exist. */
  readonly otherUserId: string;
  /** Users by id. /otp adds one for an unknown email unless the client sent create_user: false. */
  readonly users: Map<string, FakeUser>;
  /** "METHOD /path" of every request, in order, including rejected and aborted ones. */
  readonly calls: string[];
  readonly requests: RecordedRequest[];
  readonly knobs: Knobs;
  /**
   * Plays the provider redirect of an OAuth sign-in: takes the authorize URL that
   * signInWithOAuth returned (with its PKCE code challenge) and returns the auth code the
   * provider would put in the callback URL. /token?grant_type=pkce checks the client's code
   * verifier against that challenge.
   */
  authorize(authorizeUrl: string, userId?: string): string;
  /**
   * Deletes the user like auth.admin.deleteUser: /user and /logout answer 403 user_not_found and
   * its refresh tokens are gone (400 refresh_token_not_found). Access tokens already issued still
   * pass an ES256 getClaims, which verifies the signature without asking Auth.
   */
  deleteUser(id: string): void;
}

export const DEFAULT_USER: FakeUser = { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.test' };
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

interface RefreshToken {
  readonly userId: string;
  readonly sessionId: string;
  revoked: boolean;
}

interface AuthCode {
  readonly challenge: string;
  readonly method: 's256' | 'plain';
  readonly userId: string;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * A response that never comes, until the signal aborts: then it fails as Node's fetch does. With no
 * signal it would stall the test until the runner's timeout, so it fails at once and says why.
 */
function never(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error('knobs.hang: this request has no AbortSignal, so it would hang forever; pass a fetch with a timeout'));
      return;
    }
    if (signal.aborted) reject(abortReason(signal));
    else signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
  });
}

function wait(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** An Auth error in the shape GoTrue returns it. auth-js reads `error_code`. */
export function authError(status: number, errorCode: string, msg: string): Response {
  return Response.json({ code: status, error_code: errorCode, msg }, { status });
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function bearer(headers: Headers): string | null {
  const value = headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

export async function createFakeSupabase(options: FakeSupabaseOptions = {}): Promise<FakeSupabase> {
  const url = (options.url ?? 'http://supabase.test').replace(/\/$/, '');
  const origin = new URL(url).origin;
  const publishableKey = options.publishableKey ?? 'sb_publishable_fake';
  const otpCode = options.otpCode ?? '123456';
  const seeded = options.users ?? [DEFAULT_USER];
  const firstUser = seeded[0];
  if (firstUser === undefined) throw new Error('createFakeSupabase needs at least one user');
  const keys = await createSigningKeys();

  const users = new Map(seeded.map((u) => [u.id, u]));
  const pendingOtp = new Set<string>();
  const refreshTokens = new Map<string, RefreshToken>();
  const authCodes = new Map<string, AuthCode>();

  const knobs: Knobs = {
    expiresIn: 3600,
    tamper: false,
    failWith: null,
    hang: false,
    delays: {},
    symmetric: false,
    override: null,
    rest: null,
  };

  const findByEmail = (email: string): FakeUser | undefined => [...users.values()].find((u) => u.email === email);

  function userJson(user: FakeUser) {
    return {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      email_confirmed_at: '2026-01-01T00:00:00Z',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      is_anonymous: false,
    };
  }

  async function issueSession(user: FakeUser, sessionId: string, method: string): Promise<Response> {
    const now = nowSeconds();
    const alg: JwtAlgorithm = knobs.symmetric ? 'HS256' : 'ES256';
    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      role: 'authenticated',
      aud: 'authenticated',
      iat: now,
      exp: now + knobs.expiresIn,
      session_id: sessionId,
      aal: 'aal1',
      amr: [{ method, timestamp: now }],
    };
    const refreshToken = crypto.randomUUID();
    refreshTokens.set(refreshToken, { userId: user.id, sessionId, revoked: false });
    return Response.json({
      access_token: await signAccessToken(keys, alg, claims, knobs.tamper ? OTHER_USER_ID : undefined),
      token_type: 'bearer',
      expires_in: knobs.expiresIn,
      expires_at: claims.exp,
      refresh_token: refreshToken,
      user: userJson(user),
    });
  }

  /** The user behind a bearer token, or the error Auth gives for it. */
  async function authenticate(headers: Headers): Promise<{ user: FakeUser; claims: AccessTokenClaims } | Response> {
    const token = bearer(headers);
    if (token === null || token === publishableKey) return authError(401, 'no_authorization', 'This endpoint requires a valid Bearer token');
    const result = await verifyAccessToken(keys, token, nowSeconds());
    if (!result.ok) {
      const detail = result.reason === 'expired' ? 'token has invalid claims: token is expired' : 'token signature is invalid';
      return authError(403, 'bad_jwt', `invalid JWT: unable to parse or verify signature, ${detail}`);
    }
    const user = users.get(result.claims.sub);
    if (user === undefined) return authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    return { user, claims: result.claims };
  }

  async function otp(body: unknown): Promise<Response> {
    const email = field(body, 'email');
    if (typeof email !== 'string' || email === '') return authError(400, 'validation_failed', 'An email address is required');
    if (findByEmail(email) === undefined) {
      if (field(body, 'create_user') === false) return authError(422, 'otp_disabled', 'Signups not allowed for otp');
      const created = { id: crypto.randomUUID(), email };
      users.set(created.id, created);
    }
    pendingOtp.add(email);
    return Response.json({});
  }

  async function verify(body: unknown): Promise<Response> {
    const email = field(body, 'email');
    const user = typeof email === 'string' ? findByEmail(email) : undefined;
    // Auth gives the same answer for a wrong code, a used one and an email that never asked.
    if (user === undefined || !pendingOtp.has(user.email) || field(body, 'token') !== otpCode) {
      return authError(403, 'otp_expired', 'Token has expired or is invalid');
    }
    pendingOtp.delete(user.email);
    return issueSession(user, crypto.randomUUID(), 'otp');
  }

  async function exchangePkce(body: unknown): Promise<Response> {
    const code = field(body, 'auth_code');
    const verifier = field(body, 'code_verifier');
    const flow = typeof code === 'string' ? authCodes.get(code) : undefined;
    if (flow === undefined) return authError(404, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
    authCodes.delete(code as string);
    const expected = typeof verifier !== 'string' ? null : flow.method === 's256' ? await s256Challenge(verifier) : verifier;
    if (expected !== flow.challenge) return authError(403, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
    const user = users.get(flow.userId);
    if (user === undefined) return authError(404, 'user_not_found', 'User not found');
    return issueSession(user, crypto.randomUUID(), 'oauth');
  }

  async function refresh(body: unknown): Promise<Response> {
    const token = field(body, 'refresh_token');
    const stored = typeof token === 'string' ? refreshTokens.get(token) : undefined;
    if (stored === undefined) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    if (stored.revoked) return authError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
    const user = users.get(stored.userId);
    if (user === undefined) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    // Rotation: the token just used is spent.
    stored.revoked = true;
    return issueSession(user, stored.sessionId, 'token_refresh');
  }

  async function logout(request: RecordedRequest): Promise<Response> {
    const who = await authenticate(request.headers);
    if (who instanceof Response) return who;
    const scope = request.query.get('scope') ?? 'global';
    for (const [token, stored] of refreshTokens) {
      if (stored.userId !== who.user.id) continue;
      const sameSession = stored.sessionId === who.claims.session_id;
      if (scope === 'global' || (scope === 'local' && sameSession) || (scope === 'others' && !sameSession)) refreshTokens.delete(token);
    }
    return new Response(null, { status: 204 });
  }

  async function answerAuth(request: RecordedRequest): Promise<Response> {
    const route = request.path.slice('/auth/v1'.length);
    const grant = request.query.get('grant_type');
    switch (`${request.method} ${route}`) {
      case 'POST /otp':
        return otp(request.body);
      case 'POST /verify':
        return verify(request.body);
      case 'POST /token':
        if (grant === 'pkce') return exchangePkce(request.body);
        if (grant === 'refresh_token') return refresh(request.body);
        return authError(400, 'unsupported_grant_type', 'unsupported_grant_type');
      case 'GET /user': {
        const who = await authenticate(request.headers);
        return who instanceof Response ? who : Response.json(userJson(who.user));
      }
      case 'POST /logout':
        return logout(request);
      case 'GET /.well-known/jwks.json':
        return Response.json({ keys: knobs.symmetric ? [] : [keys.publicJwk] });
      default:
        return Response.json({ code: 'not_in_fake', message: `The fake has no route ${request.method} ${request.path}` }, { status: 404 });
    }
  }

  async function record(request: Request, target: URL): Promise<RecordedRequest> {
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { method: request.method, path: target.pathname, query: target.searchParams, headers: request.headers, body };
  }

  const fake: FakeSupabase = {
    url,
    publishableKey,
    otpCode,
    user: firstUser,
    otherUserId: OTHER_USER_ID,
    users,
    calls: [],
    requests: [],
    knobs,
    authorize(authorizeUrl, userId = firstUser.id) {
      const params = new URL(authorizeUrl).searchParams;
      const challenge = params.get('code_challenge');
      const method = (params.get('code_challenge_method') ?? 'plain').toLowerCase();
      if (challenge === null) throw new Error('authorize(): the URL has no code_challenge; is the client using flowType "pkce"?');
      if (method !== 's256' && method !== 'plain') throw new Error(`authorize(): unknown code_challenge_method ${method}`);
      const code = crypto.randomUUID();
      authCodes.set(code, { challenge, method, userId });
      return code;
    },
    deleteUser(id) {
      const user = users.get(id);
      users.delete(id);
      if (user !== undefined) pendingOtp.delete(user.email);
      for (const [token, stored] of refreshTokens) if (stored.userId === id) refreshTokens.delete(token);
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      // The Request merges the signal of `init` and of a Request passed as `input`. A constructed
      // Request always has one; it is the caller's only when init or input carried a signal.
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
      const signal = callerSignal === null ? null : request.signal;
      // Like Node's fetch: with the signal already aborted, nothing goes out.
      if (signal?.aborted) throw abortReason(signal);
      const target = new URL(request.url);
      if (target.origin !== origin) throw new TypeError(`fetch failed: the fake only answers ${origin}, not ${target.origin}`);
      fake.calls.push(`${request.method} ${target.pathname}`);
      const recorded = await record(request, target);
      fake.requests.push(recorded);

      if (knobs.hang) return never(signal);
      const delay = knobs.delays[target.pathname];
      if (delay !== undefined) await wait(delay, signal);

      const overridden = await knobs.override?.(recorded);
      if (overridden !== undefined) return overridden;

      // The API gateway in front of both services rejects an unknown key before either sees it.
      if (request.headers.get('apikey') !== publishableKey) {
        return Response.json({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }, { status: 401 });
      }
      if (target.pathname.startsWith('/rest/v1/')) {
        return knobs.rest ? knobs.rest(recorded) : Response.json({ code: 'not_in_fake', message: 'No rest handler set' }, { status: 404 });
      }
      if (target.pathname.startsWith('/auth/v1/')) {
        if (knobs.failWith !== null) return new Response('upstream unavailable', { status: knobs.failWith, headers: { 'content-type': 'text/plain' } });
        return answerAuth(recorded);
      }
      return Response.json({ code: 'not_in_fake', message: `The fake has no route ${request.method} ${target.pathname}` }, { status: 404 });
    },
  };
  return fake;
}
