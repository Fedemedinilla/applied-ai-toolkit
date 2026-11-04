# Fake Supabase Auth and PostgREST

Mocking `supabase.auth` replaces the code that decides whether a user is signed in (`getClaims`, refresh, sign-out) with a guess. This folder keeps the real `@supabase/supabase-js` client and fakes the wire instead: a fetch function that answers like Supabase Auth (GoTrue) and PostgREST, with no network and no Supabase project. It is the same approach as the gateway's fake Claude API ([gateway/test/helpers/fake-claude.ts](../gateway/test/helpers/fake-claude.ts)). It signs real JWTs with ES256 and HS256 through WebCrypto and serves the JWKS. Its knobs cover the failures that matter to an app server, such as an expired or tampered token, Auth down or hanging, and a deleted user. I extracted it from the test helpers of a production app, where it backs the session and middleware tests.

## Run it

From the repository root:

```sh
npm ci
npx vitest run fake-supabase-auth   # offline, no keys, about one second
npm run check                       # tsc --noEmit, strict
```

## Using it

```ts
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { createFakeSupabase } from './src/fake-auth.ts';

it('verifies the session locally with ES256', async () => {
  const fake = await createFakeSupabase();
  const supabase = createClient(fake.url, fake.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fake.fetch },
  });

  await supabase.auth.signInWithOtp({ email: fake.user.email });
  await supabase.auth.verifyOtp({ email: fake.user.email, token: fake.otpCode, type: 'email' });
  fake.calls.length = 0;

  const { data } = await supabase.auth.getClaims();
  expect(data?.claims.sub).toBe(fake.user.id);
  expect(fake.calls).toEqual(['GET /auth/v1/.well-known/jwks.json']);
});
```

supabase-js hands `global.fetch` to both the Auth client and PostgREST, so one option covers both. Code that builds its own client from the global fetch can use `vi.stubGlobal('fetch', fake.fetch)` instead.

`createFakeSupabase(options)` takes an optional `url` (default `http://supabase.test`), `publishableKey`, seed `users` and `otpCode`. It returns:

| Field | What it is |
|---|---|
| `fetch` | The fake. It throws for any origin other than `url`, so a test cannot reach the network through it. |
| `calls`, `requests` | Every request in order: `"GET /auth/v1/user"` strings, and the method, path, query, headers and parsed body. |
| `user`, `users`, `otherUserId` | The seeded user, all users by id, and the sub a tampered token claims. |
| `authorize(url)` | Plays the OAuth provider: takes the authorize URL from `signInWithOAuth` and returns the code for `exchangeCodeForSession`, bound to the PKCE challenge in that URL. |
| `deleteUser(id)` | Like `auth.admin.deleteUser`: the user and its refresh tokens are gone. |
| `knobs` | Mutable fields read on every request (below). |

### Knobs

| Knob | Effect |
|---|---|
| `expiresIn` | Lifetime in seconds of the next sessions issued. Negative means already expired. |
| `tamper` | Issued tokens carry another user's sub with the original signature. |
| `symmetric` | New tokens are HS256 with no `kid`, and the JWKS is empty, as on a project with the shared JWT secret. |
| `failWith` | Every Auth request answers this status with a body that is not JSON. PostgREST is not affected. |
| `hang` | Every request waits until its `AbortSignal` fires, then fails the way Node's fetch does. A request with no signal fails at once with an error that says so, instead of stalling until the test timeout. |
| `delays` | Milliseconds of delay per path, for example `{ '/auth/v1/verify': 300 }`, also abortable. The signal can come in `init` or on a `Request` passed as the input. |
| `override` | Answers any request before the fake does: a 429 on `/otp`, a hook rejection, a single 500. |
| `rest` | The PostgREST handler. `restTables({ notes: [...] })` in `src/rest.ts` serves GET reads with `select`, `eq`, `limit` and `.single()`. |

## Design decisions

**Real signatures, real verification.** Tokens are signed with a fresh P-256 key or HMAC secret per fake, and the fake's `/user` and `/logout` verify them as Auth does. A fake that returned any string as a token would let a test pass while the app trusted a token without checking it. Here a tampered token fails in auth-js on the ES256 path, and on the HS256 path the fake's `/user` answers 403 `bad_jwt`. Both are tested.

**A fresh `kid` per fake.** auth-js 2.118.0 caches the JWKS in a module-level object keyed by storage key, shared by every client in the process, for 10 minutes. Two fakes with the same URL and the same `kid` would let one test verify against another test's key. A random `kid` forces a fetch of the current key on first use.

**Error bodies in Auth's shape.** Errors come back as `{ code, error_code, msg }` with the status Auth uses (403 `otp_expired`, 400 `refresh_token_not_found`, 403 `user_not_found`). auth-js turns `error_code` into `error.code` and picks the error class from the status. App code that branches on `AuthRetryableFetchError` versus `AuthApiError` is therefore tested against the classification it will see in production.

**Outage bodies that are not JSON.** `failWith` answers plain text, as a gateway in front of a dead Auth does. auth-js has a separate branch for an unparseable 5xx body, and a JSON body would skip it.

**State where Auth keeps state.** Codes from `/otp` are single use. Refresh tokens rotate, and reusing a spent one gets 400 `refresh_token_already_used`. `/logout` honors `scope` (`global`, `local`, `others`), so a test can sign out one device and check another still refreshes. PKCE codes check the verifier against the S256 challenge. A stateless fake would accept a replayed code or a stolen refresh token, and the test of the code that should reject them would pass anyway.

**A gateway check on the key.** A request whose `apikey` header is not the publishable key gets the gateway's 401 before Auth or PostgREST sees it. A client built with the wrong key fails in the test instead of only in production.

**Unsupported is an error, not a plausible answer.** A route the fake does not know answers 404, and a PostgREST feature that `restTables` does not implement (a count, `order`, a filter other than `eq`, a `limit` that is not a whole number) answers 501. Both carry code `not_in_fake` and name what was asked, so a test that needs more fails loudly and gets its own `rest` or `override`. Without this, `select('*', { count: 'exact' })` would come back with `count: null` and no error.

## What the installed client does

The tests pin these behaviors of `@supabase/supabase-js` 2.118.0. Some differ from what the source app's tests assumed, and the tests here follow the installed version.

- `getClaims` with an ES256 token fetches the JWKS once and never calls `/user`. With HS256 or no `kid` it calls `/user` on every call.
- An expired access token is refreshed inside `getClaims` before the claims are read.
- A 5xx on refresh is an `AuthRetryableFetchError`, and auth-js retries with waits of 200 ms doubling each time, while the next attempt still starts within 30 seconds. That makes 8 attempts in all. The session stays in storage.
- A 400 on refresh is an `AuthApiError`. There is one attempt, and the session is removed when the access token has already expired.
- After a failed refresh, the same client returns the same error for 60 seconds to any caller with the same refresh token, without sending another `/token` request. A test that clears `failWith` and expects recovery must advance the clock past that window or use a new client.
- A deleted user's ES256 token keeps passing `getClaims` until it expires, since nothing asks Auth. `getUser` gets 403 `user_not_found`. `signOut` ignores the 403 from `/logout` and clears the local session.
- A fetch that fails, including one aborted by `AbortSignal.timeout`, comes back as `AuthRetryableFetchError` with status 0.
- postgrest-js retries a GET that gets 503 or 520 three times, with an `X-Retry-Count` header, waiting `Retry-After` seconds when the response sends it and 1, 2, 4 seconds otherwise. A 500 is not retried. `.retry(false)` turns it off. A stub that answers 503 without `Retry-After: 0` makes a test wait 7 seconds.

## What the tests cover

`test/fake-auth.test.ts` runs 31 tests, all through the real `createClient`. `test/readme-example.test.ts` runs the example above as written.

- Email code sign-in with a wrong code, the right code, a reused code, `shouldCreateUser: false`, a 429 through `override` and a wrong API key.
- The OAuth PKCE exchange, a reused code and a verifier that does not match.
- `getClaims` with ES256 (JWKS only, then cached), with HS256 (`/user` each call), a tampered token on both, Auth answering 503 to the JWKS.
- An expired token is refreshed and rotated, a spent refresh token is rejected, a 5xx is retried for 30 seconds under fake timers, and a 400 removes the session. The 60 second cooldown after a failed refresh, then recovery.
- A deleted user on the ES256 and HS256 paths and on sign-out. Logout with scope `local` and `others`, checking both the revoked and the surviving refresh token.
- Auth hanging past an `AbortSignal.timeout`, a per-route delay on either side of the deadline, a signal aborted before the call, a signal carried on a `Request`, and `hang` with no signal.
- PostgREST headers and bearer token on a select, filtering and projection, `limit`, `.single()`, an unknown table, an unsupported filter, a count and a bad `limit` rejected, the 503 retry and a 500.

## Layout

```
src/
  fake-auth.ts   createFakeSupabase: routing, Auth state, knobs
  jwt.ts         ES256 and HS256 signing and verification, the PKCE challenge
  rest.ts        restTables, a read-only PostgREST stand-in
test/
  fake-auth.test.ts
  readme-example.test.ts
```

## Limits

- Auth covers email code sign-in, PKCE exchange, refresh, `/user`, `/logout` and the JWKS. There is no password sign-in, magic link redirect, MFA, admin API, anonymous sign-in or user update.
- `/user` checks the signature, the expiry and that the user exists. It does not check that the session was not logged out, so an access token stays usable until it expires.
- The refresh token reuse interval of real Auth (a spent token accepted again for a few seconds) is not modeled, so reuse fails at once.
- `restTables` only reads. Writes, RPC, `order`, embedded resources, counts and row level security need a hand-written `rest` handler.
- Realtime, Storage and Edge Functions are not emulated.
- The response shapes were taken from a local Auth server and the source app's tests. A newer Auth release can change them; the fake is pinned to what supabase-js 2.118.0 reads.
