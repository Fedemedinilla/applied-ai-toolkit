# Push Lab

Push Lab is a small installable web app for checking Web Push and the app icon badge on a real phone, iPhone included, together with the server that sends the pushes. It comes from a production web app that notifies its operator and shows a pending count on the app icon. Two WebKit behaviours broke that feature on iPhone without any error. A service worker that answered navigations itself with `respondWith` turned a login redirect into a download prompt. A badge call that never settled kept notifications out of Notification Center. This folder holds the fixed ordering, the server checks that catch a broken setup before a notification goes missing, and tests for both. The interface is in Spanish.

Live demo: none shared. Each deployment needs its own VAPID keys, so the way to try it is to run your own (see [Try it on your own phone](#try-it-on-your-own-phone)).

## The two WebKit bugs

**1. A service worker must not intercept navigations.** The source app's worker answered every navigation with `respondWith(fetch(request))` so it could show an offline page. When the server redirected an expired session to the login page (a 302 with no `Content-Type`), Safari on iPhone did not follow the redirect that came back through the worker. It offered to download the page, and the user was left outside the app with nothing on screen to explain why. Here, [`routeFor`](src/sw-core.ts) returns `passthrough` for every request with `mode: 'navigate'`, whatever its URL, and the fetch handler in [`src/sw.ts`](src/sw.ts) returns without calling `respondWith`. The worker answers only GETs for hashed files under `assets/`. The page links to `api/redirect-check`, which answers a bare 302 back to the app, so you can try the case on your own phone.

**2. `setAppBadge` may never resolve on iPhone.** So the notification comes first, and the badge waits at most 1 second. The source app tried two orderings, and each one failed in a different way:

- `Promise.all([show, badge]).catch()`: a rejected badge call settled `waitUntil` before the notification was drawn. A push that shows nothing breaks the `userVisibleOnly` promise, and the browser may stop delivering pushes to the site.
- `Promise.allSettled([show, badge])`: a badge call that never settled kept `waitUntil` open until the system killed the worker. The banner appeared, but the notification was not kept in Notification Center and did not wake the screen.

[`handlePush`](src/sw-core.ts) awaits `showNotification` until it settles, and only then asks for the badge, with a race against `BADGE_WAIT_MS` (1000 ms). The badge is cosmetic and cannot delay the notification or cancel it. The worker also posts the count to every open window, and the page sets the badge from its own `navigator` as a second path. The "Este dispositivo" panel reports whether `setAppBadge` exists in the page and in the worker, as each device sees it.

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/push-lab                              # offline, no keys, about 3 seconds
npx vite build --config apps/push-lab/vite.config.ts      # writes dist/apps/push-lab
node apps/push-lab/scripts/vapid.ts --subject mailto:you@example.test > apps/push-lab/.env
node --env-file=apps/push-lab/.env apps/push-lab/server/serve.ts   # http://127.0.0.1:4330/
node apps/push-lab/scripts/icons.ts                       # redraws the icons in apps/push-lab/public
```

`server/serve.ts` serves the build and the API on one origin. Without keys it still starts, and `GET /api/diagnose` lists what is missing. On the same machine, `http://localhost` is a secure context, so a desktop browser can subscribe and receive pushes there. The push itself still travels through the browser vendor's push service, so receiving one needs a network connection. `.env` is ignored by git.

The build (Vite 8.3.4) writes 16.00 kB of JavaScript for the page, 6.18 kB gzipped, and a 4.05 kB service worker. After the build, [`csp-guard.config.json`](csp-guard.config.json) runs [`csp-build-guard`](../../csp-build-guard/) over `dist/apps/push-lab`. It checks the strict policy that `serve.ts` sends (`'self'` only, no inline script), a JavaScript budget, and, when `PUSH_LAB_VAPID_PRIVATE_KEY` is set during the build, that the private key appears in no built file.

## Try it on your own phone

The keys are yours: generate a pair once per deployment and keep both halves together.

1. Generate keys with `node apps/push-lab/scripts/vapid.ts --subject mailto:<your address>`. The subject must be a `mailto:` or `https:` URL (RFC 8292); the push service may use it to contact the sender.
2. Run `serve.ts` on any host with Node 24, with the three `PUSH_LAB_VAPID_*` variables set, behind HTTPS. A phone needs a real HTTPS origin, and an HTTPS tunnel to your laptop's port 4330 works for a quick try. `PORT` and `HOST` set where it listens (default `127.0.0.1:4330`). The handler is a plain `Request` to `Response` function, so a runtime with the Fetch API can call [`createHandler`](server/handler.ts) directly and serve `dist/apps/push-lab` as static files.
3. Open `/api/diagnose` and check that `ready` is true and `problems` holds only `no_subscriptions`.
4. On an iPhone (iOS 16.4 or later), open the page in Safari, tap Share, then "Agregar a inicio", and open Push Lab from the new icon. In a Safari tab there is no `PushManager`, so the page shows the install steps and keeps the enable button disabled. On Android and desktop, push works without installing; the badge needs the installed app.
5. Tap Activar, allow notifications, then send a test. Tick "Esperar 5 segundos" to lock the screen before it lands, and "Enviar el número del globo" to send the counter's number with it.

## Design decisions

**The key pair is checked by derivation.** A public key from one run and a private key from another fail without an error. Subscribing works, because the browser only sees the public key, and then the push service refuses every push signed with the wrong private key. [`checkVapid`](server/vapid.ts) derives the public key from the private key with ECDH on P-256 and compares the two in constant time. It also checks the formats, which are a 65-byte uncompressed point starting with `0x04`, a 32-byte scalar, and strict base64url, since `Buffer.from` drops characters outside the alphabet without a word. `GET /api/public-key` withholds the key while the pair does not match, so no device subscribes to a key that cannot be signed for. The diagnosis never returns a key.

**"The store failed" is never "nobody is subscribed".** Every store method throws on failure; none returns an empty list for "could not read". `POST /api/test` answers 503 `store_failed` or 404 `not_subscribed`, and the diagnosis reports `subscriptions: null`, not 0, when the store cannot be read. The difference matters because the advice is opposite. In the source app, a passing database error read as an empty list, and the test button told the user to disable and re-enable notifications, which destroys a subscription that was working. Here the store failure message says not to disable; `not_subscribed` makes the page register the device again on its own.

**TTL per message kind, always stated.** Without a `TTL`, web-push sends four weeks. [`MESSAGE_KINDS`](server/push.ts) gives a test 1 hour, because a test that arrives the next morning only confuses, and a reminder 24 hours, the shape of a real event. The source app first sent everything with 1 hour, and a phone that was off overnight lost the new-order message.

**Dead subscriptions are deleted on 404 and 410 only.** Those statuses mean the subscription no longer exists (the app was removed, the permission revoked). Any other failure, a 5xx, a 429 or a timeout, says nothing about the device and leaves it stored. When the test push gets a 410, the page also drops the browser's subscription and offers Activar again, so the browser does not keep saying "enabled" for an endpoint the server no longer has.

**Registration is idempotent and runs on every page load.** The browser can report a subscription while the server lost it (a restart of the in-memory store, an eviction, or a 410 cleanup). `POST /api/subscribe` answers `unchanged` for the same keys and updates rotated keys in place, never deleting first, so a push sent at that moment still finds the device. The worker's `pushsubscriptionchange` handler registers a rotated subscription too, but Safari may never fire that event, so the page load is the path that does not depend on it.

**A subscription made with an old key is dropped on load.** Every subscription is bound to the VAPID public key it was made with. After the server's pair is replaced, the browser still reports the old subscription, and every push to it is refused with a 403. On each load the page compares the subscription's `applicationServerKey` with `GET /api/public-key`; when they differ, it removes the subscription from the server and the browser, and offers Activar with a message that says why. A browser that reports no key keeps its subscription.

**A click takes an open window to the notification's URL.** [`handleClick`](src/sw-core.ts) focuses a window of the app that is already open and then calls `navigate` with the target, so `?from=notification` and deeper URLs are not lost when the app is open. Focus comes first, while the click still counts as a user gesture. Where `navigate` is missing or rejects, the window is only focused; with no window open, the target opens in a new one.

**Live regions stay rendered.** The status paragraphs collapse when empty but never use `display: none`. A region that becomes visible in the same step as its text is often not announced, VoiceOver in particular, and VoiceOver on iPhone is the reader this lab is most likely to meet. The event log is `role="log"` with `aria-live="off"`, since its entries repeat what a status paragraph has just announced. The badge number takes its name from a visually hidden label rather than `aria-label`, so it is read as the number.

**A test goes only to the device that asks.** `POST /api/test` takes the caller's own endpoint. A public demo that pushed to every subscriber would let any visitor notify everyone else. One device gets one test every 3 seconds (429 with `Retry-After`). The rate limit's memory drops entries older than that interval each time it records a send, so it cannot grow past the devices tested within one interval, and unsubscribing does not reset it.

**Endpoints must belong to a known push service.** `POST /api/test` makes the server send a signed request to the endpoint. An open endpoint field would let any visitor aim the server at an internal host or a third party and read the status code back. [`serviceOf`](server/push.ts) accepts only Apple's (`*.push.apple.com`), Google's (`fcm.googleapis.com`, `android.googleapis.com`), Mozilla's (`*.push.services.mozilla.com`) and Microsoft's (`*.notify.windows.com`) push hosts, on the default port and with no credentials in the URL; anything else gets 400 `unknown_push_service` on subscribe and on test. The tests turn this off with `allowAnyEndpoint` for their fake service at `push.example.test`.

**Request bodies are bounded while they are read.** Bodies are JSON only, since a cross-site form cannot send `application/json` without a preflight. They are capped at 4096 bytes. A larger `Content-Length` is refused before reading. A chunked body with no length is read chunk by chunk and cut off with 413 at the first chunk past the cap. One request cannot make the process hold an arbitrary body in memory.

**A full store evicts instead of refusing.** The in-memory store holds at most 500 devices. When it is full, a new device replaces the one that registered least recently. Every registration counts, the one on each page load included. A store that refused new devices could be filled with 500 made-up subscriptions and lock every real device out until a restart. With eviction, the same flood pushes real devices out, and each comes back by itself on its next page load or its next test, because the page registers again when the server answers `not_subscribed`. `memoryStore({ whenFull: 'refuse' })` keeps the refusing behaviour, reported as 503 `store_full`.

**The endpoint is a credential.** Together with the server's VAPID private key, it is what a push to that device needs. The diagnosis counts devices by push service, taken from the endpoint's host (`apple`, `google`, `mozilla`, `windows`), and never returns an endpoint.

**A malformed push still shows something.** [`parsePush`](src/sw-core.ts) never throws and falls back to default text, because a push that ends without a notification breaks `userVisibleOnly`. A badge number that is missing or invalid leaves the badge as it is; only 0 clears it, so "could not count" never reads as "nothing pending". `renotify` is set only with a `tag`, because `renotify` without a tag throws a TypeError inside the push handler. Each test gets its own tag, so a second test does not silently replace the first one in Notification Center.

**The worker is a classic script with no imports.** It imports only `sw-core.ts`, plus types, so the bundler emits no shared chunk; an ES `import` in a worker registered without `{ type: 'module' }` stops it from installing. The build test fails if `sw.js` ever contains one. The worker is built unhashed at the root, because its URL is its identity. Its cache name carries a hash of the build and of its scope. A new build drops the old asset cache, and a second copy of the app on the same origin keeps its own.

## What the tests cover

| File | Covers |
|---|---|
| `test/ttl.test.ts` | Through the real web-push with `https.request` replaced: the instrument sees an explicit TTL, the four-week default when the option is missing, and a misspelled option refused with nothing sent; the TTL and urgency headers for each kind through the handler; a reminder after a test keeps its own TTL; 404 and 410 delete the subscription, six other statuses keep it; only the dead device of two is removed |
| `test/vapid.test.ts` | A generated pair matches; halves of two pairs do not; derivation equals web-push's key and node:crypto's; zero, out-of-range and short private keys refused; public key length, prefix and alphabet; subjects; no key in the result |
| `test/handler.test.ts` | Subscribe: created, unchanged and updated in place, `toJSON()` accepted, invalid endpoints and keys refused, 415, 413 by Content-Length and for a chunked body read only up to the cap, broken JSON, store failure and a refusing full store; endpoints outside the push services (an internal address, localhost, a look-alike host, another Google host, another port) refused on subscribe and on test with nothing sent, and the four services accepted; test: only the asking device, badge absent is not zero, unique tags, store failure (503) against not subscribed (404), 410 cleanup, 5xx and timeout kept, rate limit, a limit that unsubscribing does not reset and that still holds after older entries are pruned, delay cap, unknown kind, a pair that cannot sign; public key withheld on a mismatch; diagnosis by service with no endpoint or key in it, `null` for an unreadable store, the first key problem named; routing under a prefix, 404, 405 with `Allow`, the bare 302 |
| `test/sw-core.test.ts` | With fake timers: a badge that never settles holds the event at most 1000 ms after the notification; a badge that rejects at once cannot end it before the notification; the badge is not requested before `showNotification` settles; a fast badge ends it at once; 0 clears and a missing count leaves the badge; a worker without the API still tells the pages; a hanging page message is capped; a synchronous throw; a failed notification. Also payload defaults, `renotify` only with a tag, click targets kept in scope, focus over open, an open window taken to the target after focus, and focus only when it is already there, has no `navigate` or `navigate` rejects, resubscription paths, every navigation passed through, cache cleanup per scope |
| `test/store-platform.test.ts` | The in-memory store's results, eviction of the least recently registered device, and the refusing mode; push services by host, with look-alike hosts, other Google and Mozilla hosts, a port, credentials and `http:` all refused; iPhone, iPad reporting a Mac, installed and Android detection; base64url to bytes; the page's messages, including no "disable" advice on a store failure |
| `test/node-server.test.ts` | Static files with the CSP and cache headers, path traversal refused (encoded and raw), 404 for folders, the API through node:http with the default endpoint allowlist, a chunked body over the cap answered 413, the redirect not followed |
| `test/app.dom.test.ts` | jsdom against the real `index.html` and the real handler: install steps on an iPhone tab with the button disabled, the Android install prompt used once; enabling with the server's key, re-registration on load, a subscription made with a replaced key dropped on both sides and Activar offered, one with no reported key kept, `InvalidStateError` retried, browser errors explained, a blocked permission, the browser unsubscribed when the server cannot store; disabling; a test with kind and badge, a store failure that leaves the subscription, a lost device registered again, a 410 that offers Activar; the badge counter, no badge API, a worker message setting the badge; the diagnosis count and "could not count"; arrival notes; labels, live regions, the log not live, the badge number named by a label, and no live region computing to `display: none` with the real stylesheet |
| `test/build.test.ts` | Runs the production build into a temporary folder: the manifest and its icons, relative URLs only, no inline script, `sw.js` with its version set and no `import` or `export` |

153 tests, all offline.

## Limits

- **Not verified on a device by these tests.** The WebKit behaviours above were observed in the source app on iPhones; the tests here check the ordering and the routing logic with fakes. Whether a given iOS version exposes `setAppBadge` in the worker is something the lab reports on the device, not something the code assumes.
- **The store lives in memory.** It is lost on restart and not shared between server instances, so a deployment that runs several instances needs a `SubscriptionStore` over a database. The page's registration on load brings a device back after a restart.
- **iOS needs the home screen app.** In a Safari tab there is no push at all, and iOS has no install prompt to trigger, so the steps are manual.
- **The delay runs in the request.** "Esperar 5 segundos" holds the `POST /api/test` request open for 5 seconds, which a host with a short function timeout may cut.
- **No authentication.** Anyone who can open the page can subscribe their own device and push to it, within the limits above. The server sends only to the four push services. A visitor can still store made-up subscriptions on those hosts and have the server send to them, once every 3 seconds per endpoint. With many endpoints, that is many requests to Apple's or Google's service under your VAPID key. A public deployment that stays up should sit behind a rate limit per client address, which this lab does not have. It is a lab, not a notification service.
- **A flood evicts real devices.** With eviction, 500 made-up subscriptions push every real device out of the store. They come back on their next page load or test, but a push sent in between finds nobody.
- **Delivery is up to the push service.** A 201 from Apple's or Google's service means the message was accepted, not that it was shown. The TTL only bounds how long it waits.
