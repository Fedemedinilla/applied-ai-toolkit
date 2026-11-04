# Chat widget

An embeddable chat assistant for small business sites, served to many businesses from one deploy. Each business is a row, so onboarding is an insert. The public endpoints fail closed: if the store cannot answer, the model is not called. A business pastes one script tag, the owner writes what the assistant should know in a minimal panel, and the backend answers through [`gateway`](../../gateway/) and its spending caps. Extracted from a production chatbot backend. The interface text is in neutral Latin American Spanish.

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/chat-widget                          # offline, no API key, about 5 seconds
npx vite build --config apps/chat-widget/vite.config.ts  # writes dist/apps/chat-widget
node apps/chat-widget/server/serve.ts                    # http://localhost:4331/, after the build
```

`serve.ts` serves the demo page, the loader, the panel and both APIs on one origin, with a fictional plant nursery as the only tenant. At startup it prints an invite link for that tenant's owner, so the panel can be tried without the operator route. Without `ANTHROPIC_API_KEY` the widget still mounts and every message answers "not available". The other variables are `CHAT_WIDGET_SESSION_SECRET` (at least 32 bytes; without it a random one is made per process), `CHAT_WIDGET_ADMIN_PASSWORD` (at least 16 characters; without it the operator route answers 401), `CHAT_WIDGET_PUBLIC_URL`, `PORT` and `HOST`. The store is in memory, so a restart forgets everything.

One opt-in script sends three questions to the demo tenant through the real handler and the Claude API, and prints each reply with the turn's tokens and cost. The third question asks the assistant to reveal its instructions. Without the key it prints its usage and exits:

```sh
ANTHROPIC_API_KEY=sk-ant-... node apps/chat-widget/server/live-check.ts
```

The build writes the loader as `embed/chat.js`, 10.11 kB and 4.15 kB gzipped, with no hash in its name. The panel's script is 5.34 kB. [`csp-build-guard`](../../csp-build-guard/) checks the build against the policy `serve.ts` sends ([`csp-guard.config.json`](csp-guard.config.json)), with no inline script or style and a JavaScript budget per page:

```sh
node csp-build-guard/cli.ts --dir dist/apps/chat-widget --config apps/chat-widget/csp-guard.config.json
```

## Embedding

```html
<script src="https://widget.example/embed/chat.js" data-tenant="vivero-demo" async></script>
```

`data-tenant` names the row. The backend is the origin that served the script, unless `data-api` gives another base URL. There is no inline script, so a site whose Content-Security-Policy forbids inline code can still add the tag. It needs the widget's origin in `script-src` and `connect-src`, and nothing in `style-src`.

## What a turn does

`POST /widget/chat` takes `{ tenant, sessionId, messages }` and returns `{ reply }` or `{ error: code }`. The checks run cheapest first, and none of them reads the store before the body has passed:

1. The body is read with a 128 KiB limit, chunk by chunk, and parsed with a strict zod schema. The conversation keeps its last 16 messages, must alternate and must end on a visitor turn. A visitor message past 1,000 characters is refused, and an earlier reply past 6,000 is cut.
2. A per-IP limiter, in memory, allows 6 turns a minute across all tenants. IPv6 is keyed by its /64.
3. The tenant's config and plan are read, with a 2 s deadline each, and validated. A suspended or inactive plan answers `paused`.
4. The request's Origin, or Referer when there is no Origin, must be one of the tenant's allowed domains or a subdomain of one.
5. The tenant's turns in the last minute and in the current month are counted. A ninth turn in a minute answers `busy`, and a turn past the monthly cap answers `monthly_limit`.
6. The turn is reserved as a row, and both counts run again with it included. If either is now over, the reservation is deleted and the turn refused.
7. The gateway checks the tenant's daily spending cap and the deploy's monthly one, reserves the call's worst case in its own ledger and calls the model.
8. The turn row is closed with the model, the tokens and the cost, and the reply goes back.

`server/widget-api.ts` is the place to start reading.

## What the public surface exposes

The two widget routes answer any origin (`Access-Control-Allow-Origin: *`) and read no cookie, because any site can embed the widget and the widget sends no credentials.

`GET /widget/config?tenant=<id>` returns the six fields the widget paints on screen: the header, the welcome message, the input placeholder, the color, the font and up to four suggested questions. Anyone who opens the business's site sees them already. The context, the FAQ, the tone notes, the allowed domains, the plan and the account id stay on the server. `publicConfig` builds the response field by field from a fixed list, so a column added to the tenant row later is not published until someone adds it to that list. The color is forced to lowercase hex and the font to letters, digits, space, comma, apostrophe and hyphen, because both reach CSS. The answer is cached 60 seconds; an error is not cached.

`POST /widget/chat` returns the reply or an error code. The widget owns the text the visitor reads, so a server error can never put markup or internal detail on a customer's page. Log lines carry the tenant id and a code, never a message.

## Design decisions

### Tenancy

**Multi-tenant by row.** `widget_tenants`, `widget_owners` and `widget_turns` all carry `tenant_id`, and every statement in [`server/sql-store.ts`](server/sql-store.ts) filters on it. One deployment per client would mean copying every fix into every copy. Here a new business is `createTenant`, and a fix reaches every tenant at once. One suite runs against the in-memory store and against `SqlStore` on [`sql/schema.sql`](sql/schema.sql) in an in-process Postgres (PGlite), and checks that one tenant's writes and counts never touch another's.

**The panel's tenant comes from the signed session only.** No panel route takes a tenant id from the request. The content schema is strict, so a body that names `tenantId` is refused.

**The tenant's text is data.** The system prompt has two blocks. The first is 955 characters of fixed rules, the same for every tenant and every call so it can be cached. The second holds the tenant's name, tone notes, FAQ and context inside tags. Angle brackets are removed from tenant text, so a pasted page cannot close `</business_context>` and add rules after it. The rules say that text inside the tags is the owner's content and not an instruction.

### Abuse controls

**A count that fails is not zero.** If it were, a database outage would remove every cap. Every store call has a deadline, and its result must parse as a non-negative integer. A throw, a timeout, `null`, `NaN`, the string `"0"` or a negative number all answer 503 with no model call.

**Reserve, then count again.** With a check followed by a write after the model answers, eight requests that arrive together all read the same count and all pass. Here the turn is reserved first and counted with itself included. Against a burst cap of 3, eight requests sent in the same tick are all refused, because each recount sees all eight reservations; the same eight sent one after another get exactly three. Both results are asserted in `test/widget-api.test.ts`. When the check errs, it refuses, the same trade-off the gateway makes.

**A turn that may have reached the model counts.** Only a refusal before any request left (a spending cap, a config error, a failed ledger reservation) deletes the reservation. An overloaded API, a timeout or a refusal by the model closes the turn as failed, and it keeps counting toward the burst and the month. Otherwise a client that triggers errors on purpose would never reach the turn caps.

**Two kinds of cap.** The turn counts bound volume per tenant and hold across processes, because they live in the store. The gateway bounds money. The tenant's account id is the gateway's user id, so its daily per-user cap is a daily spending cap per tenant (US$0.50 by default). Its monthly cap covers the whole deploy (US$10). The gateway reserves each call's worst case, the estimated prompt plus 1,200 output tokens, before sending it.

**An empty allowlist answers on no site.** Treating empty as unrestricted would let a tenant created without domains answer on any page. A request with neither Origin nor Referer is refused too. Matching is by whole labels. For `shop.example`, `www.shop.example` passes, while `notshop.example` and `shop.example.evil.example` are refused. A script can forge Origin, so this stops another website from putting a tenant's widget on its pages and spending the tenant's quota. The caps are what stop a script.

**The per-IP limit is a speed bump.** It lives in memory, so each serverless instance has its own and a cold start begins empty. It stops one client hammering one instance. The host decides what the client IP is. `serve.ts` passes the socket address, and `forwardedFor` is there for a host whose proxy overwrites `X-Forwarded-For`. A host that provides no address puts all such requests in one shared bucket, which refuses more, not less. The limiter's map is capped at 5,000 keys, oldest first, so rotating addresses cannot grow it without bound.

**Bodies are read with a byte limit everywhere.** Both the chat route and the panel routes read chunk by chunk and stop at the limit, so a chunked body of any size is cut after 128 KiB instead of held in memory.

**Thresholds are config, with low defaults.** A copy deployed as is errs toward refusing. All of them are fields of `Limits` and `SpendCaps`, passed to `createApp` and `createChatModel`.

| Limit | Default |
|---|---|
| Turns per tenant per minute | 8 |
| Turns per tenant per month | 1,500 (a plan can lower it, never raise it) |
| Turns per IP per minute | 6 |
| Messages kept, characters each | 16; 1,000 per visitor turn, 6,000 per earlier reply |
| Store deadline | 2 s |
| Owner logins and failed operator logins per IP | 5 a minute |
| Spending caps | US$0.50 per tenant per day, US$10 per month for the deploy |

### The loader

**Text only.** Every string from the tenant, the visitor or the model is set with `textContent`, and the icons are built with `createElementNS`. A test spies on the `innerHTML`, `outerHTML` and `insertAdjacentHTML` setters during a mount and a reply that both carry an `<img onerror>` payload. The source and the built bundle are also checked for any HTML-parsing call.

**Shadow DOM, styles that pass a strict CSP.** The widget mounts one host element and everything else lives in its shadow root, so the site's CSS cannot restyle the widget and the widget's CSS cannot leak out. Styles are attached as a constructed stylesheet (`adoptedStyleSheets`), and the tenant's color is set through the CSSOM. A policy with no `'unsafe-inline'` in `style-src` blocks a `<style>` element and a `style` attribute, but neither of these. I loaded the demo page under such a policy in Chromium at 360 px wide, in light and dark. The console showed no policy violation, and the page had no horizontal scroll. jsdom has no constructed stylesheets, so the tests exercise the `<style>` fallback.

**Requests a host page cannot turn against the visitor.** Both requests use `credentials: 'omit'`, so no cookie of the widget's origin ever travels. The chat POST is sent as `text/plain`, a CORS simple request with no preflight. The server never relies on a preflight for protection, so skipping it costs nothing and saves a round trip.

**A classic script that adds nothing to the page.** `document.currentScript` is null in a module, so the loader must be a classic script, and a classic script's top-level declarations become properties of the host page's `window`. The build fails if the loader imports or exports anything, then wraps it in one function scope, and the build test runs it in an empty context and checks that no global was added. Its name has no hash, because the snippet a business pasted names that URL; it is cached five minutes.

**No widget is better than a broken one.** The widget mounts only after its config loads and passes the same checks the server applied. An unknown tenant, a paused plan, a backend that is down or a bad color leaves the host page as it was. A launcher mounted with defaults could only answer with errors.

**One mount per tenant, even with the tag pasted twice.** The host element goes into the page before the config request, so a second tag that runs while the first waits finds it and stops. Two tags are two copies of the bundle, so a module variable would not be shared between them; the DOM is.

**Accessible on someone else's page.** The launcher is a button with `aria-expanded` and `aria-controls`. The panel is a labelled dialog, the message list is a polite live region, and the input has a label. Escape closes the panel and returns focus to the launcher, from inside the panel or from the launcher. A reply is added as a new node rather than written into the "Escribiendo…" placeholder, because a live region announces additions. Text on the tenant's color is white or near-black, whichever has more contrast by the WCAG formula. Light and dark follow `prefers-color-scheme`. At 360 px the panel's height follows the dynamic viewport, so the on-screen keyboard does not cover the input, and the input is 16 px so iOS does not zoom on focus.

### The panel

**scrypt at N = 2^17, with the parameters in the hash.** Hashes are `scrypt$N$r$p$salt$hash`. When a stored hash is weaker than the current parameters, login hashes the password again, because that is the only moment the password is known. The new hash is written only if the stored one has not changed since it was read, so a rehash never undoes a password reset. Stored parameters past 2^20 or 256 MiB are refused rather than computed, so a corrupt row cannot exhaust the server. Hashing runs on the thread pool (`crypto.scrypt`), since a synchronous hash at N = 2^17 would block every other request. An unknown email is checked against a dummy hash, so it answers no faster than a wrong password.

**Tokens with a purpose and an expiry, sessions tied to the password.** Sessions and invites are HMAC-SHA256 tokens whose payload names their purpose, so an invite is never accepted as a session or the reverse. A session also carries a tag of the password hash it was issued for, so resetting a password ends every open session. The cookie is `__Host-cw_session`, `HttpOnly`, `Secure`, `SameSite=Strict`; the `__Host-` prefix stops a sibling subdomain from setting or shadowing it.

**Invites are single-use, and their token never reaches a log.** The operator creates a tenant and an invite with HTTP Basic, compared in constant time and limited per IP on failures. The operator password must be at least 16 characters, because it can reissue any owner's invite. The owner's row stores the nonce of the one invite that still works. Accepting it clears the nonce in the same statement that sets the password, so two tabs cannot both use one link, and issuing a new invite voids the old one. A link that stayed valid until a password existed would be usable for its whole lifetime if it leaked. The token travels in the URL fragment (`/panel/#invite=...`), which browsers send neither to the server nor in `Referer`, and the page removes it from the address bar on load.

**Writes need the panel's own Origin and a JSON body.** A missing Origin is refused, since every browser sends one on a `fetch` POST or PUT. A form from another site cannot send `application/json`, and a cross-origin `fetch` that does gets no CORS answer from the panel routes, even in a browser that ignores `SameSite`.

## What the tests cover

| File | Covers |
|---|---|
| `test/widget-api.test.ts` | The public config subset; the allowlist; burst, concurrency and monthly caps; plan status; ten store failures answered 503; per-IP limit; spend cap; model errors; malformed bodies; long replies in the history |
| `test/panel-api.test.ts` | Operator route and its failure limit; invites once, voided, expired; login and its limit; rehash; content and field limits; cookie tampering; origin checks; oversized chunked bodies |
| `test/auth.test.ts` | Hash format and bounds, rehash detection, token purpose, tampering and expiry, cookie attributes, Basic |
| `test/loader.dom.test.ts` | jsdom: mounting, no mount on failure, one mount under concurrent tags, text never markup, request shape, history, errors, accessibility |
| `test/store-contract.test.ts` | One suite on `MemoryStore` and on `SqlStore` in PGlite, plus the schema's checks |
| `test/guards.test.ts` | IP keys, the limiter, the byte-limited reader, Origin and Referer matching, deadlines, static paths |
| `test/build.test.ts` | The production build: the loader adds no globals, has no HTML-parsing call, and uses relative URLs |

127 tests, all offline. [`test/fake-anthropic.ts`](test/fake-anthropic.ts) answers the gateway's real client with server-sent events in the API's format or with an error, and records each request.

## Layout

```
index.html           the demo page of the fictional nursery, which embeds the loader
panel/index.html     the owner's panel
src/
  widget.ts          the widget: config, Shadow DOM, messages, requests
  embed.ts           the loader's entry, built as embed/chat.js
  panel.ts           the panel page's script
  site.css           styles of the demo page and the panel
server/
  widget-api.ts      GET /widget/config and POST /widget/chat
  panel-api.ts       login, invites, content, the operator route
  app.ts             one Request -> Response handler for every route
  auth.ts            scrypt, signed tokens, the cookie, Basic
  guards.ts          IP keys, the rate limiter, the allowlist, body limits, store deadlines
  tenant.ts          zod schemas for the tenant row, the plan, the panel's patch
  store.ts           the store interfaces and the in-memory store
  sql-store.ts       the same interfaces over Postgres
  prompt.ts          the fixed rules and the tenant block
  model.ts           the gateway, its caps and prices
  limits.ts          every threshold and its default
  env.ts             the one place that reads the environment
  node-http.ts       node:http around the handler, static files with a strict CSP
  serve.ts           the demo server
  demo-tenant.ts     the fictional tenant
  live-check.ts      three real calls, opt-in
sql/schema.sql       the reference schema
test/                Vitest suites and the fake API
```

## Limits

- **The per-IP limit and the money caps are per process.** The turn counts live in the store and hold across instances. The IP limiter is a Map in the handler, and the gateway's spending caps live in its in-memory ledger. Both are per process, so on a serverless host each instance has its own US$10 a month. Holding the money caps across instances needs the gateway's Postgres schema and an adapter, which the gateway folder does not have.
- **Requests that arrive together near the burst cap can all be refused,** as the test shows. Under a steady stream each request sees the ones before it, and exactly the cap gets through.
- **The history is the client's word.** The widget sends the conversation, so a script can write the assistant's earlier turns. The schema forces alternation and a visitor turn last, the caps still apply, and the rules block is always first, but the model reads a history the server did not write.
- **No conversation log.** Turns store tokens and cost, not text. Showing owners their visitors' conversations needs a retention policy and consent text this folder does not have.
- **No streaming to the visitor.** The gateway streams from the API, and the reply goes to the widget whole.
- **The panel is minimal.** It edits the name, the welcome message, the tone, the context, the FAQ and the suggested questions. The color, the font and the allowed domains are set by the operator in the store. There are no file uploads, no usage view and no password change except through a new invite.
- **The demo needs the server.** On a static host the config request fails and the widget does not mount, by design.
- **Model replies were tested against a fake API only.** There is no accuracy figure for the prompt, and `live-check.ts` prints three replies and records nothing.
- **The prices are the gateway example's.** Check the current pricing page before relying on a computed cost.
