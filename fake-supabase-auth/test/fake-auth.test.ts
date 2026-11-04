/**
 * Every test drives the real createClient from @supabase/supabase-js 2.118.0 against the fake.
 * The assertions are on what the client returns and on the requests the fake saw, so they also
 * pin what the installed auth-js does: when it calls /user, how long it retries a refresh, when it
 * drops a session.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authError, createFakeSupabase, DEFAULT_USER, type FakeSupabase } from '../src/fake-auth.ts';
import { restTables } from '../src/rest.ts';

/** Storage the test can look into, standing in for the cookies of a server-rendered app. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

interface ClientOptions {
  readonly fetch?: typeof fetch;
  readonly storage?: ReturnType<typeof memoryStorage>;
  readonly key?: string;
}

function clientFor(fake: FakeSupabase, { fetch = fake.fetch, storage = memoryStorage(), key = fake.publishableKey }: ClientOptions = {}): SupabaseClient {
  return createClient(fake.url, key, {
    auth: { autoRefreshToken: false, persistSession: true, detectSessionInUrl: false, flowType: 'pkce', storage },
    global: { fetch },
  });
}

/** Signs in with the email code and clears the request log, so a test sees only its own calls. */
async function signIn(fake: FakeSupabase, client: SupabaseClient) {
  expect((await client.auth.signInWithOtp({ email: fake.user.email })).error).toBeNull();
  const { data, error } = await client.auth.verifyOtp({ email: fake.user.email, token: fake.otpCode, type: 'email' });
  expect(error).toBeNull();
  fake.calls.length = 0;
  fake.requests.length = 0;
  if (data.session === null) throw new Error('verifyOtp returned no session');
  return data.session;
}

const STORAGE_KEY = 'sb-supabase-auth-token';

let fake: FakeSupabase;

beforeEach(async () => {
  fake = await createFakeSupabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('email code sign-in', () => {
  it('sends the code request, rejects a wrong code, accepts the right one once', async () => {
    const client = clientFor(fake);
    expect((await client.auth.signInWithOtp({ email: fake.user.email })).error).toBeNull();
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/auth/v1/otp', body: { email: fake.user.email, create_user: true } });

    const wrong = await client.auth.verifyOtp({ email: fake.user.email, token: '000000', type: 'email' });
    expect(wrong.error).toMatchObject({ name: 'AuthApiError', status: 403, code: 'otp_expired' });

    const right = await client.auth.verifyOtp({ email: fake.user.email, token: fake.otpCode, type: 'email' });
    expect(right.error).toBeNull();
    expect(right.data.user?.id).toBe(fake.user.id);

    const reused = await client.auth.verifyOtp({ email: fake.user.email, token: fake.otpCode, type: 'email' });
    expect(reused.error).toMatchObject({ status: 403, code: 'otp_expired' });
    expect(fake.calls).toEqual(['POST /auth/v1/otp', 'POST /auth/v1/verify', 'POST /auth/v1/verify', 'POST /auth/v1/verify']);
  });

  it('with shouldCreateUser false, an unknown email gets 422 otp_disabled and no user is created', async () => {
    const client = clientFor(fake);
    const { error } = await client.auth.signInWithOtp({ email: 'nobody@example.test', options: { shouldCreateUser: false } });
    expect(error).toMatchObject({ status: 422, code: 'otp_disabled' });
    expect(fake.users.size).toBe(1);
  });

  it('an override answers before the fake: a 429 from the email rate limit', async () => {
    fake.knobs.override = (request) =>
      request.path === '/auth/v1/otp' ? authError(429, 'over_email_send_rate_limit', 'email rate limit exceeded') : undefined;
    const { error } = await clientFor(fake).auth.signInWithOtp({ email: fake.user.email });
    expect(error).toMatchObject({ name: 'AuthApiError', status: 429, code: 'over_email_send_rate_limit' });
  });

  it('a client built with the wrong key gets the gateway 401 before Auth sees the request', async () => {
    const { error } = await clientFor(fake, { key: 'sb_publishable_wrong' }).auth.signInWithOtp({ email: fake.user.email });
    expect(error).toMatchObject({ status: 401 });
    expect(fake.users.size).toBe(1);
  });
});

describe('OAuth with PKCE', () => {
  it('exchanges the code from the provider redirect for a session, once', async () => {
    const client = clientFor(fake);
    const started = await client.auth.signInWithOAuth({ provider: 'google', options: { skipBrowserRedirect: true } });
    expect(started.error).toBeNull();
    if (started.data.url === null) throw new Error('no authorize URL');
    const code = fake.authorize(started.data.url);

    const { data, error } = await client.auth.exchangeCodeForSession(code);
    expect(error).toBeNull();
    expect(data.user?.id).toBe(fake.user.id);
    const sent = fake.requests.find((r) => r.path === '/auth/v1/token');
    expect(sent?.query.get('grant_type')).toBe('pkce');

    // The code is spent: a second flow on the same client has a fresh verifier, and the old code
    // is no longer known.
    await client.auth.signInWithOAuth({ provider: 'google', options: { skipBrowserRedirect: true } });
    const again = await client.auth.exchangeCodeForSession(code);
    expect(again.error).toMatchObject({ status: 404, code: 'flow_state_not_found' });
  });

  it('a verifier that does not match the challenge gets 403 bad_code_verifier', async () => {
    const client = clientFor(fake);
    const started = await client.auth.signInWithOAuth({ provider: 'google', options: { skipBrowserRedirect: true } });
    if (started.data.url === null) throw new Error('no authorize URL');
    const url = new URL(started.data.url);
    url.searchParams.set('code_challenge', 'not-the-challenge');
    const { error } = await client.auth.exchangeCodeForSession(fake.authorize(url.href));
    expect(error).toMatchObject({ status: 403, code: 'bad_code_verifier' });
  });
});

describe('getClaims', () => {
  it('with ES256, verifies the signature against the JWKS and never calls /user', async () => {
    const client = clientFor(fake);
    await signIn(fake, client);

    const { data, error } = await client.auth.getClaims();
    expect(error).toBeNull();
    expect(data?.claims.sub).toBe(fake.user.id);
    expect(fake.calls).toEqual(['GET /auth/v1/.well-known/jwks.json']);

    // auth-js caches the JWKS for 10 minutes: the second call stays off the network.
    await client.auth.getClaims();
    expect(fake.calls).toEqual(['GET /auth/v1/.well-known/jwks.json']);
  });

  it('with ES256, a tampered token fails on the signature, with no call but the JWKS', async () => {
    fake.knobs.tamper = true;
    const client = clientFor(fake);
    await signIn(fake, client);

    const { data, error } = await client.auth.getClaims();
    expect(data).toBeNull();
    expect(error).toMatchObject({ name: 'AuthInvalidJwtError' });
    expect(error?.message).toMatch(/signature/i);
    expect(fake.calls).toEqual(['GET /auth/v1/.well-known/jwks.json']);
  });

  it('with HS256, cannot verify locally and asks Auth through /user on every call', async () => {
    fake.knobs.symmetric = true;
    const client = clientFor(fake);
    await signIn(fake, client);

    const { data, error } = await client.auth.getClaims();
    expect(error).toBeNull();
    expect(data?.header.alg).toBe('HS256');
    expect(data?.claims.sub).toBe(fake.user.id);
    await client.auth.getClaims();
    expect(fake.calls).toEqual(['GET /auth/v1/user', 'GET /auth/v1/user']);
  });

  it('with HS256, a tampered token is rejected by /user with 403 bad_jwt', async () => {
    fake.knobs.symmetric = true;
    fake.knobs.tamper = true;
    const client = clientFor(fake);
    await signIn(fake, client);

    const { data, error } = await client.auth.getClaims();
    expect(data).toBeNull();
    expect(error).toMatchObject({ name: 'AuthApiError', status: 403, code: 'bad_jwt' });
    expect(fake.calls).toEqual(['GET /auth/v1/user']);
  });

  it('with Auth answering 503 to the JWKS, returns a retryable error and keeps the session', async () => {
    const storage = memoryStorage();
    const client = clientFor(fake, { storage });
    await signIn(fake, client);
    fake.knobs.failWith = 503;

    const { data, error } = await client.auth.getClaims();
    expect(data).toBeNull();
    expect(error).toMatchObject({ name: 'AuthRetryableFetchError', status: 503 });
    expect(storage.items.has(STORAGE_KEY)).toBe(true);
  });
});

describe('refresh', () => {
  it('an expired access token is refreshed before the claims are read, and the refresh token rotates', async () => {
    fake.knobs.expiresIn = -60;
    const client = clientFor(fake);
    const expired = await signIn(fake, client);
    fake.knobs.expiresIn = 3600;

    const { data, error } = await client.auth.getClaims();
    expect(error).toBeNull();
    expect(data?.claims.sub).toBe(fake.user.id);
    expect(fake.calls).toEqual(['POST /auth/v1/token', 'GET /auth/v1/.well-known/jwks.json']);
    expect(fake.requests[0]?.query.get('grant_type')).toBe('refresh_token');

    const session = (await client.auth.getSession()).data.session;
    expect(session?.refresh_token).not.toBe(expired.refresh_token);
    expect(session?.access_token).not.toBe(expired.access_token);

    const reused = await clientFor(fake).auth.refreshSession({ refresh_token: expired.refresh_token });
    expect(reused.error).toMatchObject({ status: 400, code: 'refresh_token_already_used' });
  });

  it('a 5xx on refresh is retried with backoff for about 30 seconds, then returned, and the session stays', async () => {
    fake.knobs.expiresIn = -60;
    const storage = memoryStorage();
    const client = clientFor(fake, { storage });
    await signIn(fake, client);
    fake.knobs.failWith = 503;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    let settled = false;
    const result = client.auth.getClaims().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    const { data, error } = await result;

    expect(data).toBeNull();
    expect(error).toMatchObject({ name: 'AuthRetryableFetchError', status: 503 });
    const attempts = fake.calls.filter((c) => c === 'POST /auth/v1/token').length;
    // Waits of 200, 400 ... 12,800 ms add up to 25.4 s; the next wait would end past 30 s.
    expect(attempts).toBe(8);
    expect(storage.items.has(STORAGE_KEY)).toBe(true);
  });

  it('a 400 on refresh is final: one attempt, and the session is removed from storage', async () => {
    fake.knobs.expiresIn = -60;
    const storage = memoryStorage();
    const client = clientFor(fake, { storage });
    await signIn(fake, client);
    fake.deleteUser(fake.user.id);

    const { data, error } = await client.auth.getClaims();
    expect(data).toBeNull();
    expect(error).toMatchObject({ name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' });
    expect(fake.calls).toEqual(['POST /auth/v1/token']);
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
  });
});

describe('refresh failure cooldown', () => {
  it('after a failed refresh, the same refresh token gets the cached error for 60 seconds with no /token call', async () => {
    fake.knobs.expiresIn = -60;
    const client = clientFor(fake);
    await signIn(fake, client);
    fake.knobs.expiresIn = 3600;
    fake.knobs.failWith = 503;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const first = client.auth.getClaims();
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await first).error).toMatchObject({ name: 'AuthRetryableFetchError', status: 503 });

    fake.knobs.failWith = null;
    fake.calls.length = 0;
    expect((await client.auth.getClaims()).error).toMatchObject({ name: 'AuthRetryableFetchError', status: 503 });
    expect(fake.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    const recovered = await client.auth.getClaims();
    expect(recovered.error).toBeNull();
    expect(recovered.data?.claims.sub).toBe(fake.user.id);
    expect(fake.calls[0]).toBe('POST /auth/v1/token');
  });
});

describe('a deleted user', () => {
  it('still passes an ES256 getClaims until the token expires; /user says user_not_found', async () => {
    const client = clientFor(fake);
    await signIn(fake, client);
    fake.deleteUser(fake.user.id);

    expect((await client.auth.getClaims()).data?.claims.sub).toBe(fake.user.id);
    const { data, error } = await client.auth.getUser();
    expect(data.user).toBeNull();
    expect(error).toMatchObject({ status: 403, code: 'user_not_found' });
  });

  it('signOut gets 403 from /logout, which auth-js ignores, and the local session is removed', async () => {
    const storage = memoryStorage();
    const client = clientFor(fake, { storage });
    await signIn(fake, client);
    fake.deleteUser(fake.user.id);

    const { error } = await client.auth.signOut();
    expect(error).toBeNull();
    expect(fake.calls).toEqual(['POST /auth/v1/logout']);
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
  });

  it('with HS256, getClaims surfaces the user_not_found from /user', async () => {
    fake.knobs.symmetric = true;
    const client = clientFor(fake);
    await signIn(fake, client);
    fake.deleteUser(fake.user.id);

    const { data, error } = await client.auth.getClaims();
    expect(data).toBeNull();
    expect(error).toMatchObject({ status: 403, code: 'user_not_found' });
  });
});

describe('logout', () => {
  const refreshWith = (refreshToken: string) => clientFor(fake).auth.refreshSession({ refresh_token: refreshToken });

  it('scope local revokes only this session; the other device can still refresh', async () => {
    const phone = clientFor(fake);
    const laptop = clientFor(fake);
    const phoneSession = await signIn(fake, phone);
    const laptopSession = await signIn(fake, laptop);

    expect((await phone.auth.signOut({ scope: 'local' })).error).toBeNull();
    expect(fake.requests.at(-1)?.query.get('scope')).toBe('local');
    expect((await refreshWith(phoneSession.refresh_token)).error).toMatchObject({ status: 400, code: 'refresh_token_not_found' });
    expect((await refreshWith(laptopSession.refresh_token)).error).toBeNull();
  });

  it('scope others keeps this session and revokes every other one', async () => {
    const phone = clientFor(fake);
    const laptop = clientFor(fake);
    const phoneSession = await signIn(fake, phone);
    const laptopSession = await signIn(fake, laptop);

    expect((await laptop.auth.signOut({ scope: 'others' })).error).toBeNull();
    expect((await refreshWith(phoneSession.refresh_token)).error).toMatchObject({ status: 400, code: 'refresh_token_not_found' });
    expect((await refreshWith(laptopSession.refresh_token)).error).toBeNull();
  });
});

describe('Auth that hangs', () => {
  /** A fetch with a deadline, as a server would pass to createClient. */
  const withTimeout = (ms: number): typeof fetch => (input, init) => fake.fetch(input, { ...init, signal: AbortSignal.timeout(ms) });

  it('a hung /user fails at the AbortSignal timeout with a retryable error, status 0', async () => {
    const client = clientFor(fake, { fetch: withTimeout(50) });
    await signIn(fake, client);
    fake.knobs.hang = true;

    const started = performance.now();
    const { data, error } = await client.auth.getUser();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(data.user).toBeNull();
    expect(error).toMatchObject({ name: 'AuthRetryableFetchError', status: 0 });
    expect(fake.calls).toEqual(['GET /auth/v1/user']);
  });

  it('a per-route delay longer than the deadline fails the same way; a shorter one answers', async () => {
    const client = clientFor(fake, { fetch: withTimeout(100) });
    fake.knobs.delays['/auth/v1/otp'] = 300;
    expect((await client.auth.signInWithOtp({ email: fake.user.email })).error).toMatchObject({ name: 'AuthRetryableFetchError' });
    fake.knobs.delays['/auth/v1/otp'] = 10;
    expect((await client.auth.signInWithOtp({ email: fake.user.email })).error).toBeNull();
  });

  it('honors the signal of a Request passed with no init', async () => {
    fake.knobs.hang = true;
    const request = new Request(`${fake.url}/auth/v1/user`, { signal: AbortSignal.timeout(50) });
    await expect(fake.fetch(request)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('a hung request with no signal fails at once instead of stalling the test', async () => {
    fake.knobs.hang = true;
    await expect(fake.fetch(`${fake.url}/auth/v1/user`)).rejects.toThrow(/no AbortSignal/);
  });

  it('a signal aborted before the call sends nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = clientFor(fake, { fetch: (input, init) => fake.fetch(input, { ...init, signal: controller.signal }) });
    expect((await client.auth.signInWithOtp({ email: fake.user.email })).error).toMatchObject({ name: 'AuthRetryableFetchError' });
    expect(fake.calls).toEqual([]);
  });
});

describe('PostgREST', () => {
  const NOTES = [
    { id: 1, owner_id: DEFAULT_USER.id, title: 'First note', body: 'one' },
    { id: 2, owner_id: DEFAULT_USER.id, title: 'Second note', body: 'two' },
    { id: 3, owner_id: '33333333-3333-4333-8333-333333333333', title: 'Not mine', body: 'three' },
  ];

  it('a select goes out with the apikey and the user access token, and the stub filters and projects', async () => {
    fake.knobs.rest = restTables({ notes: NOTES });
    const client = clientFor(fake);
    const session = await signIn(fake, client);

    const { data, error } = await client.from('notes').select('id,title').eq('owner_id', fake.user.id);
    expect(error).toBeNull();
    expect(data).toEqual([
      { id: 1, title: 'First note' },
      { id: 2, title: 'Second note' },
    ]);
    const sent = fake.requests.at(-1);
    expect(sent?.path).toBe('/rest/v1/notes');
    expect(sent?.query.get('owner_id')).toBe(`eq.${fake.user.id}`);
    expect(sent?.headers.get('apikey')).toBe(fake.publishableKey);
    expect(sent?.headers.get('authorization')).toBe(`Bearer ${session.access_token}`);
  });

  it('single() with no match gets PGRST116; an unknown table PGRST205; an unsupported filter not_in_fake', async () => {
    fake.knobs.rest = restTables({ notes: NOTES });
    const client = clientFor(fake);

    expect((await client.from('notes').select('*').eq('id', 1).single()).data).toMatchObject({ title: 'First note' });
    expect((await client.from('notes').select('*').eq('id', 99).single()).error).toMatchObject({ code: 'PGRST116' });
    expect((await client.from('missing').select('*')).error).toMatchObject({ code: 'PGRST205' });
    expect((await client.from('notes').select('*').gt('id', 1)).error).toMatchObject({ code: 'not_in_fake' });
  });

  it('limit cuts the rows; a count or a limit that is not a number gets not_in_fake, not a silent answer', async () => {
    fake.knobs.rest = restTables({ notes: NOTES });
    const client = clientFor(fake);

    expect((await client.from('notes').select('id').limit(2)).data).toEqual([{ id: 1 }, { id: 2 }]);
    const counted = await client.from('notes').select('*', { count: 'exact' });
    expect(counted).toMatchObject({ status: 501, count: null, error: { code: 'not_in_fake' } });
    const bad = await fake.fetch(`${fake.url}/rest/v1/notes?limit=abc`, { headers: { apikey: fake.publishableKey } });
    expect(bad.status).toBe(501);
  });

  it('a GET that gets 503 is retried three times by postgrest-js, honoring Retry-After; Auth failWith does not touch it', async () => {
    fake.knobs.failWith = 503;
    fake.knobs.rest = () => new Response('schema cache loading', { status: 503, headers: { 'retry-after': '0' } });
    const client = clientFor(fake);

    const result = await client.from('notes').select('*');
    expect(result).toMatchObject({ data: null, status: 503, error: { message: 'schema cache loading' } });
    expect(fake.calls).toEqual(Array(4).fill('GET /rest/v1/notes'));
    expect(fake.requests.map((r) => r.headers.get('x-retry-count'))).toEqual([null, '1', '2', '3']);

    fake.calls.length = 0;
    await client.from('notes').select('*').retry(false);
    expect(fake.calls).toEqual(['GET /rest/v1/notes']);
  });

  it('a 500 is not retried', async () => {
    fake.knobs.rest = () => Response.json({ code: 'XX000', message: 'internal error' }, { status: 500 });
    const { error } = await clientFor(fake).from('notes').select('*');
    expect(error).toMatchObject({ code: 'XX000' });
    expect(fake.calls).toEqual(['GET /rest/v1/notes']);
  });
});

describe('the fake itself', () => {
  it('refuses any other origin, so a test cannot reach the network through it by mistake', async () => {
    await expect(fake.fetch('https://api.example.test/v1')).rejects.toThrow(/only answers http:\/\/supabase.test/);
    expect(fake.calls).toEqual([]);
  });
});
