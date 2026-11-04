# Supabase Auth hardening

SQL migrations that close four gaps Supabase Auth leaves open in an app that signs in by email code. They are open sign-ups (including `auth.admin.createUser`, which skips the sign-up hook), passwords a stranger can pre-register, email changes, and unlimited guesses at a code. Supabase has no setting for any of them, so the database enforces them with a hook, triggers on `auth.users` and one function. I extracted them from a production app with invitation-only accounts. There, each gap was reproduced against Supabase Auth v2.197.0 (local stack, Supabase CLI 2.121.0) before the fix and checked again after it. The tests run the real SQL in PGlite against Supabase's default grants, with a test per control that reproduces the gap without it.

## Run it

From the repository root:

```sh
npm ci
npx vitest run supabase-auth-hardening   # offline: the real SQL in PGlite, no Supabase project
npm run check                            # tsc --noEmit (strict)
```

The tests load `test/helpers/auth-stub.sql` into [PGlite](https://pglite.dev), a WASM build of Postgres, and then apply `sql/0001` to `sql/0005` in order. The stub creates the four roles Supabase uses (`anon`, `authenticated`, `service_role`, `supabase_auth_admin`), Supabase's default grants on `public`, and the parts of the `auth` schema the SQL touches. Users are inserted as `supabase_auth_admin`, the role Auth connects as, and the hook is called as that role through RLS.

## The controls

| Migration | Closes | Mechanism |
|---|---|---|
| `0001_conventions.sql` | (shared) | The rules the later files follow, written once; `set_updated_at()` |
| `0002_closed_signups.sql` | Anyone with the publishable key signing up | `allowed_emails` with `account_role`, the Before User Created hook, and a trigger that refuses any user not on the list |
| `0003_no_passwords.sql` | A stranger pre-registering a listed address with a password | A trigger that empties `encrypted_password` on every write |
| `0004_no_email_change.sql` | One allowlist row turning into several accounts | A trigger that refuses changes to `email` and `email_change` |
| `0005_otp_attempt_cap.sql` | Unlimited guesses at a sign-in code | `reserve_otp_attempt(email)`, called by the server before `verifyOtp` |
| `audit.sql` | A later object that skips the rules | A read-only query that lists violations across all of `public` |

### Closed sign-ups

**The threat.** The publishable key ships in the browser bundle, and with it anyone can call `/auth/v1/otp` or `/auth/v1/signup` for any address.

**What Auth does.** The Before User Created hook runs for sign-ups through the public API (email code, password, OAuth) and for `auth.admin.generateLink`. On Auth v2.197.0 a rejection from the hook reaches the client as HTTP 403 with `{"code":403,"error_code":"unknown","msg":<the hook's message>}`; supabase-js returns an `AuthApiError` with `status` 403 and `code` `"unknown"`. There is no dedicated error code, so a client has to recognize the rejection by its status. `auth.admin.createUser` does not call the hook.

**What the SQL does.** `before_user_created_hook(event)` returns `{}` for an address in `allowed_emails` and a 403 for anything else, including an event with no address. The `create_account` trigger runs after every insert into `auth.users`. It refuses a row whose address is not on the list and creates the `accounts` row with the listed role. With the trigger in place, `createUser` for an unlisted address fails, and Auth answers 500 "Database error creating new user". The trigger is the guarantee and the hook is the readable error: whatever path a sign-up takes, there is no user without a row on the list.

### No passwords

**The threat.** The app signs in by email code only. A stranger calls `/auth/v1/signup` with a listed address that has not signed in yet and a password of their choosing. The hook lets it through, because Auth sends it the same event as a sign-up by code. With "Confirm email" on, the call returns no session and the user stays unconfirmed. Later the owner signs in with their code. Auth confirms the address on the same user and keeps the stranger's password. On Auth v2.197.0, `signInWithPassword` with that password then returned a session for the owner's account, which in the source app was an admin. A stolen session gives the same foothold: `PUT /auth/v1/user` with a new password grants access that survives sign-out.

**What Auth does.** There is no switch that turns off passwords for the email provider while keeping the email code.

**What the SQL does.** `discard_password` runs before every insert or update of `encrypted_password` and stores an empty string. After it, the stranger's password and a password set with a session both get 400 `invalid_credentials`. `updateUser({ password })` still answers success, but nothing is stored. The email code keeps working. It depends on "Confirm email" being on. Without confirmation, a password sign-up returns a session in the same response, before any later sign-in.

### No email change

**The threat.** The hook runs only when a user is created. A user with a session can request a new address (`PUT /auth/v1/user`; the publishable key is enough), and the server can move it with `auth.admin.updateUserById` or `generateLink` of type `email_change_*`. On Auth v2.197.0 the request succeeded and, with the two codes, the user ended up on the new address. The original listed address was then free to sign up again, and the trigger gave it a second admin account. One row of the list became as many accounts as the person had addresses.

**What the SQL does.** `block_email_change` refuses any change to `email` and any non-empty change to `email_change`, which is where Auth stores a pending request. It refuses a move to another listed address too, because the account would keep the old row's role and the old row could then make a second user. Writes that name the columns without changing them, and the write that clears a request, pass. It also refuses Auth's soft delete (`deleteUser(id, true)`), which rewrites the address; users are deleted for real. With the trigger, Auth v2.197.0 answers 500: "Error sending email change email" to the request, "Error updating user" to `updateUserById`, "Error soft deleting user" to the soft delete. supabase-js returns them as `AuthRetryableFetchError`.

### OTP attempt cap

**The threat.** On Auth v2.197.0, the correct code still signed in after 120 failed verifications of the same code. The only brake is Auth's per-IP limit on token verifications. When sign-in runs on a server, every request reaches Auth from the host's IPs, so that limit is shared by all users. At 30 verifications per 5 minutes, that is 8,640 guesses a day against any listed address for which someone requested a code.

**What the SQL does.** The server calls `reserve_otp_attempt(email)` with the secret key before `verifyOtp` and acts on one of three outcomes:

| Outcome | Meaning | What the server does |
|---|---|---|
| `recorded` | The attempt is counted. | Calls `verifyOtp`. |
| `exhausted` | The address already has 20 attempts in the last 24 hours. Nothing is recorded. | Does not call Auth. Asks the user to wait or use another sign-in method. |
| `no_code` | The address is neither on the list nor a user, so no code can be valid. Nothing is recorded. | Does not call Auth. Answers exactly as it does to a wrong code. |

With 20 attempts a day, guessing an 8-digit code has about 7 chances in 100,000 a year (20 x 365 / 100,000,000).

```ts
// Server side, with a client built from the secret key.
const { data, error } = await admin.rpc('reserve_otp_attempt', { p_email: email });
if (error) return unavailable();
switch (data) {
  case 'recorded': return verify(email, code);   // supabase.auth.verifyOtp(...)
  case 'exhausted': return tooManyAttempts();
  case 'no_code': return wrongCode();             // same response as a rejected code, without asking Auth
}
```

## Design decisions

**Two layers for sign-ups, and the trigger is the one that holds.** The hook gives the client a 403 it can show. The trigger catches the paths that never call the hook: `auth.admin.createUser`, a direct insert, a future admin panel. A test inserts an unlisted user as `supabase_auth_admin` and checks that no row is left.

**The hook is security invoker, and its table has a policy for `supabase_auth_admin`.** Supabase's hook documentation advises against `security definer`, so the hook runs as `supabase_auth_admin` with SELECT on one table. That role does not bypass RLS. Without the policy the hook reads an empty list and refuses every sign-up. A test drops the policy and checks exactly that.

**Addresses are normalized once, and the list rejects anything else.** A check constraint keeps `allowed_emails.email` lowercase and trimmed. The hook, the trigger and the attempt cap lowercase and trim the incoming address before comparing it. `auth.users` does not require a normalized address, so the cap compares `lower(u.email)` there.

**Every name is qualified and every function sets `search_path = ''`.** A definer function with a mutable search path can be redirected to a table someone else created. Qualified names also avoid a trap the source app hit. The "Allow by Domain" example in Supabase's hook documentation failed with `column reference "domain" is ambiguous` on PostgreSQL 16.

**Error messages carry the user id, never the address.** A raise from a trigger ends up in the Auth logs. A test checks that the refusal message contains the id and not the address.

**Passwords are discarded, not rejected.** Raising on a password would break the sign-up by code, which also writes a random password. Emptying it keeps every Auth flow working and leaves nothing to sign in with.

**Every attempt counts, including the one that succeeds.** The reservation happens before Auth is asked, so it cannot depend on the result. Counting only failures would need a second call after `verifyOtp`, and two verifications at once could both pass the cap before either was marked. The cost: a legitimate user who signs in by code more than 20 times in 24 hours is locked out until the oldest attempt ages out. With sessions that last weeks this does not happen in practice. Change `c_cap` in a new migration if your sessions are short.

**One advisory lock per address, held until the transaction ends.** Two concurrent reservations for the same address would otherwise both count 19 and both insert. The lock key is a 64-bit hash of the address hash; a collision only makes two unrelated addresses wait on each other.

**The table holds a sha256 of the address, and only for addresses that can hold a code.** The address comes from the client and can be any text. Recording every input would let anonymous requests with made-up addresses grow the table without bound, 20 rows per address. Recording only listed addresses and existing users bounds it, and a test checks that 30 made-up addresses leave no row. Listed addresses with no user yet are counted, so the first code is not an uncounted window.

**`no_code` does not call Auth.** Every `verifyOtp` spends the shared per-IP limit. Requests with made-up addresses would otherwise exhaust it and lock out every user.

**Cleanup happens in the reservation.** Each call deletes rows older than the window before counting. There is no scheduled job to forget, and the table stays bounded by active addresses.

**No role touches `otp_attempts` directly.** Not even `service_role` has one. The server can reserve an attempt but cannot read, forge or reset the count. The table's id is a uuid rather than an identity column, because a sequence in `public` would pick up Supabase's default grants to `anon` and `authenticated`.

**Grants are revoked role by role, then granted back.** Supabase grants `anon`, `authenticated` and `service_role` everything on new objects in `public`, and Postgres grants EXECUTE on new functions to `PUBLIC`. Each object revokes from PUBLIC, anon, authenticated and service_role, then grants back only what a role uses. On PostgreSQL 17, which Supabase runs, the default `grant all` also includes MAINTAIN. The stub reproduces those default grants, so the tests check the revokes against the grants they undo. `audit.sql` repeats rules 1 to 5 of `0001_conventions.sql` over the whole schema. One test creates a table, a sequence and a function the default way and expects all nine violations. Another leaves only MAINTAIN on a closed table and expects it reported for each role.

### Departures from the source app

The source's pgTAP tests ran as `postgres`, which cannot take the `supabase_auth_admin` role, so they called the hook and inserted users as `postgres`. The Vitest suite here does both as `supabase_auth_admin`, through RLS. `audit.sql` is new.

## How to apply it

1. Copy the five migrations into `supabase/migrations/`, with timestamps after your latest migration so they apply in order. From your project root, with `src` pointing at this folder's `sql/`:

   ```sh
   src=path/to/supabase-auth-hardening/sql
   i=1; for f in "$src"/000*.sql; do
     n=$(basename "$f"); cp "$f" "supabase/migrations/$(date -u +%Y%m%d%H%M)0${i}_${n#*_}"; i=$((i+1))
   done
   ```

2. Apply them with `supabase db reset` on a local stack, then `supabase db push` (or your usual path) to the project.
3. Turn on "Confirm email" in the Email provider settings (`enable_confirmations = true` under `[auth.email]` in `config.toml`). The password control depends on it.
4. Register the hook after the migrations, since the function must exist first: Authentication, Hooks, Before User Created, type Postgres, function `public.before_user_created_hook`. Locally:

   ```toml
   [auth.hook.before_user_created]
   enabled = true
   uri = "pg-functions://postgres/public/before_user_created_hook"
   ```

5. Load the list from the SQL editor, never from a migration: `insert into public.allowed_emails (email, role) values ('<address>', 'admin');`
6. Call `reserve_otp_attempt` before every `verifyOtp` on the server, as above.
7. Run `sql/audit.sql` in the SQL editor. An empty result means every object in `public` follows rules 1 to 5 of `0001_conventions.sql`. Run it again after adding tables. The audit encodes this folder's strict profile: authenticated never writes and never executes a function, and every table has a comment. If your app grants authenticated an INSERT behind a policy, or exposes an RPC to it, delete the `authenticated can write` and `anon or authenticated can execute` branches, or filter their rows by object name.

`pgtap/` holds the same checks as pgTAP files for a real Supabase database. Copy them to `supabase/tests/database/` and run `supabase test db`. They are not part of CI here; see Limits for where they have run.

## What the tests cover

78 tests, all offline.

`test/closed-signups.test.ts`
- The list's normalization constraint and default role.
- The hook, called as `supabase_auth_admin`, for listed, unlisted, mixed-case, empty and missing addresses; and refusing everyone once its policy is dropped.
- The hook closed to `anon`, `authenticated` and `service_role`.
- The trigger: accounts created with the listed role; unlisted and address-less users refused with no row left; the message names the id, not the address.
- A user kept after its address leaves the list.
- RLS on `accounts` for two users and for a token without `sub`; what `service_role` may change.
- Any user getting in on a database without the trigger.

`test/no-passwords.test.ts`
- The pre-registered password kept on a database without the trigger.
- A password emptied at sign-up, after confirmation and when set later; a sign-up without one left alone.
- Other writes unchanged; no stored password anywhere.

`test/no-email-change.test.ts`
- One listed row becoming two admin accounts on a database without the trigger.
- Every kind of change refused: off the list, to another listed address, another spelling, null, by a privileged role.
- Change requests in one row and in several; the soft delete.
- Writes that do not change the address landing as written; a real delete taking the account with it.

`test/otp-attempt-cap.test.ts`
- 20 attempts `recorded`, then `exhausted` with nothing recorded; case and spacing; separate counts per address.
- `no_code` for 30 made-up addresses, with no rows; a listed address with no user; a user whose address left the list, matched in lowercase.
- The sha256 of the normalized address, its length check, and no column that could hold the address.
- The 24-hour window, its cleanup and the exact edge; the advisory lock held until commit; 22004 for a missing address; privileges for every role.

`test/conventions.test.ts`
- The exact tables, functions, enums and triggers the migrations create.
- `audit.sql`: no rows on the migrated schema, all nine violations on objects created the default way, and MAINTAIN left to any one role.
- Table and column privileges per role; EXECUTE per role and for `PUBLIC`; which functions are security definer; the RLS policies.

`test/mutations.ts` is an opt-in mutation check, not part of `npm test`. It copies `sql/`, reintroduces one gap at a time, and runs the suite against the copy. The six gaps are matching `auth.users` without `lower()`, removing the hook's revoke, dropping the `email_change` clause from the trigger, firing the password trigger on insert only, `>` instead of `>=` for the cap, and a `using (true)` policy on `accounts`. An unchanged copy runs first as a control. Every mutation fails the suite. To repeat it (about two minutes):

```sh
node supabase-auth-hardening/test/mutations.ts
```

## Layout

```
sql/
  0001_conventions.sql         the rules, set_updated_at()
  0002_closed_signups.sql      account_role, allowed_emails, the hook, accounts, create_account
  0003_no_passwords.sql        discard_password
  0004_no_email_change.sql     block_email_change
  0005_otp_attempt_cap.sql     otp_attempts, reserve_otp_attempt
  audit.sql                    read-only check of rules 1 to 5 over public
pgtap/                         the same checks for supabase test db, optional
test/
  helpers/auth-stub.sql        Supabase roles, default grants, auth.users, auth.uid()
  helpers/db.ts                PGlite with the stub and the migrations, role switching
  mutations.ts                 opt-in mutation check
```

## Limits

- **A direct call to `/auth/v1/verify` is bounded only by the code length.** Anyone with the publishable key can verify codes against Auth without going through the server, so `reserve_otp_attempt` never sees those attempts. Against that path the defense is `otp_length` (6 to 10 digits; the source app uses 8) and Auth's per-IP limit, which an attacker spreads over as many IPs as they control.
- **Per-IP limits are shared behind a serverless host.** Requests that do reach Auth through the server all come from the host's IPs, so `sign_in_sign_ups` and `token_verifications` are one limit for every user. Thirty anonymous code requests can stop everyone from requesting a code for five minutes. The documented fix is to send the client IP in the `Sb-Forwarded-For` header with the secret key and turn on IP address forwarding in the project. It is not part of this folder and cannot be tested locally.
- **The cap tells whether an address can sign in.** An address with no possible code never reaches `exhausted`, and `no_code` answers without waiting for Auth. With Auth returning 429, the two branches answer differently. A per-IP limit in the application, before the reservation and with the same answer for both branches, narrows this; it is not here.
- **Removing an address from the list does not lock out its user.** The list gates sign-ups. Revoking access means deleting the user or adding a check in the app.
- **A stranger's sign-up still writes `raw_user_meta_data`.** The password is discarded, the metadata is not. Do not trust it for anything.
- **The tests cannot race.** PGlite has one backend, so the advisory lock is checked by its presence in `pg_locks`, not by two sessions waiting on it.
- **The cap's lookup in `auth.users` scans the table.** `lower(email)` does not use Auth's index on `email`. It runs only when the address is not on the list.
- **The stub is not Auth.** It reproduces the roles, grants and columns the SQL depends on, on PostgreSQL 18.6 in PGlite; Supabase runs 17. The Auth behaviour in this README was observed on v2.197.0 and can change in a later version.
- **The pgTAP files have run on PostgreSQL, not on Supabase.** All five pass (102 assertions) on PostgreSQL 17.11 with pgTAP 1.3.3, loaded with `test/helpers/auth-stub.sql`, the migrations, and a schema `extensions` that `anon`, `authenticated` and `service_role` can use, as on Supabase. A Supabase stack has more in `auth` and `public` than the stub; on a project with objects of its own, adjust `tables_are`, `functions_are` and `enums_are` in file 00. `audit.sql` returns no rows on the same database, and also runs on PostgreSQL 16.15.
- **OAuth linking is not covered.** Whether a user created by email code who later signs in with Google is linked without calling the hook was not verified in the source app.
