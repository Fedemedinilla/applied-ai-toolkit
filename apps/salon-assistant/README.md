# Salon assistant

A chat page and a small server for a booking assistant at a fictional hair salon in Buenos Aires. The visitor asks about prices, hours and staff, or asks for an appointment, and gets a reply and, when the request is possible, a card with the service, price, day, time and who does it. The server calls Claude through [`gateway`](../../gateway/), with a monthly spending cap. Everything the model writes then goes through [`grounded-assistant`](../../grounded-assistant/), which decides whether the booking can happen, checks every `$` figure against the price table, and signs the history. The page renders replies with [`safe-markdown`](../../safe-markdown/), so model text is escaped before any formatting and no link is rendered. The interface is in Spanish; the assistant answers in Rioplatense Spanish, as the salon would.

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/salon-assistant                        # offline, no key: the server over a fake Anthropic API, and the build
npx vite build --config apps/salon-assistant/vite.config.ts   # writes dist/apps/salon-assistant
node csp-build-guard/cli.ts --dir dist/apps/salon-assistant --config apps/salon-assistant/csp-guard.config.json
ASSISTANT_HISTORY_SECRET=$(openssl rand -hex 32) node apps/salon-assistant/server/serve.ts   # http://127.0.0.1:8791
```

Without `ANTHROPIC_API_KEY` the server starts, `/api/health` and `/api/assistant` answer 503 with no model call, and the page says the assistant is not available. With the key, each turn is one real call. Without a history secret of at least 32 bytes the server refuses to start.

The build writes 7.47 kB of JavaScript (3.44 kB gzipped) and 2.42 kB of CSS. csp-build-guard measures 3.4 kB gzipped and 3.1 kB brotli for `index.html`, against a 10 kB budget. It also finds no regex lookbehind and no inline script or style, so the build needs nothing beyond the `'self'`-only policy in `csp-guard.config.json`. `server/serve.ts` sends that same policy as a `Content-Security-Policy` header on every static file.

## Design decisions

**The server trusts the model with no field of the card.** `server/model.ts` passes `grounded-assistant`'s zod schema to `gateway.structured`, so the reply is validated on the way in. The handler then runs `decide()` and the money guard before anything is signed. The price, duration and stylist on the card come from the salon's tables.

**The gateway's errors map to three answers.** A reached cap is 503 `unavailable` before any request leaves. A retryable API error (429, 529, an outage) is 429 `busy`. A refusal, a `max_tokens` stop, output that fails the schema and any other error is 502 `model_failed`. None of them carries a `reply`. The page shows its own text for each and leaves the failed turn out of the conversation it sends next.

**A history secret of its own.** `server/env.ts` reads `ASSISTANT_HISTORY_SECRET` and the API key separately. The source derived the signing key from the API key, so rotating the key ended every conversation.

**JSON only, small bodies, a per-IP minute.** The handler refuses anything but `application/json` (a cross-site page can POST `text/plain` without a preflight), bodies above 24 KiB, and a thirteenth turn from one IP within a minute, counting only accepted ones. The limiter lives in one process.

**One turn at a time.** The page keeps a pending flag and ignores Enter and the reset button while a turn is in flight. `requestSubmit()` does not check a disabled submit button, so without the flag a second Enter started another request from the same history. Whichever reply landed last then dropped the other exchange from what the page sent next. A turn that fails puts its text back in the box and marks its bubble "(no enviado)", because it is not part of the conversation any more.

**The local server never hands the app a request it cannot build.** Node accepts methods such as `TRACE` that `new Request` throws on, so `serve.ts` answers those 405 before building one. A body above the 32 KiB limit gets 413 instead of being cut and parsed as broken JSON, and any rejection in the chain answers 500 rather than ending the process with an unhandled rejection.

**Replies render as text.** The page uses `renderMarkdown` with no internal or external hosts and `mailto` off, so lists and bold work and nothing in a reply becomes a link. User turns are set with `textContent`.

**The page works from the keyboard and a screen reader.** Replies are announced through a visually hidden `aria-live` region, because a reply that appears without an announcement goes unheard, and only replies: a live log would read the visitor's own message back to them. Enter sends and Shift+Enter adds a line. Enter that confirms an IME composition does not send. Focus returns to the box after each reply, so a keyboard user never has to find it again. Every control has a visible focus ring. Code blocks and tables from the renderer scroll inside their bubble, so the layout holds at 360 px. Colours follow `prefers-color-scheme`.

**The missing-key notice means a missing key.** The page says the API key is missing only when `/api/health` answers 503 with `{"ok":false}`, which is this server's own answer. A network error or a proxy's 5xx shows a generic connection notice instead.

## What the tests cover

| File | Covers |
|---|---|
| `test/app.test.ts` | A turn over the real gateway and SDK client against a fake Messages API: the request body (model, `max_tokens`, no `temperature`, two system blocks with the clock line, a JSON schema with `booking` before `reply`), the card from `decide()`; a signed second turn; a forged turn that never reaches the API; the cap refusing the second call; 529, 400, schema failure and `max_tokens` mapped to their answers; no key; the env readers; the per-minute limiter, including that past 10,000 addresses it drops an idle one and keeps an active one |
| `test/build.test.ts` | The production build: relative URLs, one script and one stylesheet, the renderer included, and no server code, secret name or prompt in the bundle |

## Limits

- The salon has no agenda: a card is a request the salon confirms, and a real deploy would send it somewhere.
- The gateway's stores are in memory, so the cap resets when the server restarts. A deploy would use the gateway's Postgres schema.
- The rate limit and the cap are per process.
- The real cost per turn was not measured, so there is no figure for turns per month under the cap.
- The live demo this was extracted from also had an English page. The library supports `lang: 'en'`; this page sends Spanish only.
