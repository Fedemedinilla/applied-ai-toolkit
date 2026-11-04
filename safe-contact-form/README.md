# safe-contact-form

A contact form endpoint that sends two emails: the message to the site owner, and an acknowledgment to the visitor so they know it arrived. The acknowledgment is the risky one. Its recipient and its content are both typed by the visitor, and it leaves signed with the site's domain, so a careless form delivers anyone's phishing text to anyone's address under the site's name. The handler takes a Fetch API `Request` and returns a `Response`, with no framework, and the mail provider sits behind a two-method interface. I extracted it from the contact form on [federicomedinilla.com](https://federicomedinilla.com). Each guard below answers a failure that form had in production or that a review found in it. Field names, thresholds and texts are configuration, and the destination address is never in the code.

## Run it

From the repository root, offline:

```sh
npx vitest run safe-contact-form                          # 68 tests, under a second, no key
npm run check                                             # tsc --noEmit, strict
node safe-contact-form/examples/serve.ts --print-mail     # http://127.0.0.1:8790, prints both emails to the terminal
```

`examples/form.html` is a Spanish form for a fictional studio. It posts natively without JavaScript and the server answers with a page; `examples/form.js` turns the submit into a JSON request and reports the result in an `aria-live` status line. Without `--print-mail` and without `RESEND_API_KEY` the server has no transport and every valid send answers 503. With `RESEND_API_KEY`, `CONTACT_TO` and `CONTACT_FROM` set it sends through Resend; that is the only live path, and no test uses it.

```ts
import { createContactHandler, resendTransport } from './safe-contact-form/src/index.ts';

const key = process.env.RESEND_API_KEY;
export const POST = createContactHandler({
  to: process.env.CONTACT_TO!,                         // the owner's mailbox, from the environment
  from: 'Example Studio <hello@studio.example>',
  publicAddress: 'hello@studio.example',               // Reply-To of the acknowledgment, printed on error pages
  siteName: 'Example Studio',
  homeUrl: { en: '/', es: '/es/' },
  transport: key ? resendTransport({ apiKey: key }) : null,
});
// await POST(request, { clientAddress })
```

## What a submit goes through

1. Any method but POST gets 405 with `Allow: POST`. A content type other than JSON, urlencoded or multipart gets 415, so a cross-site page cannot send JSON as `text/plain` and skip the CORS preflight. A body over `maxBodyBytes` (32 KiB) gets 413; the body is read up to that limit even with no `Content-Length`.
2. **Origin.** When the browser sends `Origin`, it must be one of the request's own origins or `allowedOrigins`. `"null"` never matches. A request with no `Origin` (an old client, a script) goes on to the next checks.
3. **Trap field.** A hidden field (`fax_number` by default) that only bots fill. A filled one answers success and sends nothing.
4. **Clock.** A submit less than `minFillMs` (2,500 ms) after the page's script stamped `rendered_at` answers success and sends nothing.
5. **Validation.** A name, one email address, and a message of at least two characters. Failures get 400.
6. **Per-IP limit.** Five accepted sends in fifteen minutes by default. Over it gets 429.
7. **No transport, no success.** Without a transport the answer is 503.
8. The notice goes to the owner with the whole message and `Reply-To` set to the visitor. A provider error gets 502.
9. The acknowledgment goes to the visitor. If it fails, the answer is still success, with `acknowledged: false`.

JSON requests get `{ ok, acknowledged }` or `{ ok: false, error }` with a stable code (`origin`, `invalid`, `limited`, `not_configured`, `send_failed`, `too_large`, `media_type`). Form posts get a full HTML page for every outcome.

## Design decisions

**The acknowledgment quotes no link.** Escaping HTML is not enough, because mail clients turn a URL written as plain text into a link. Before quoting, `stripLinks` removes Markdown links, anything with a scheme, `www.` hosts and bare domains with any TLD, in any script (`пример.рф`) or punycode. The source's first filter knew twelve TLDs, so `something.ru/login` reached the visitor's inbox intact and clickable. The pattern's edges are Unicode lookarounds because `\b` only knows ASCII letters. It has no dot in its lookbehind, so a domain right after an ellipsis still matches. The cost is a few false positives in the quote ("thanks.Regards", "EE.UU."), which a test pins. The owner's copy keeps the message whole.

**Filtered again after the cut.** The quote is cut to `quoteMax` (300) characters and the greeting to `greetingMax` (32). `x.ru-y` escapes the pattern because of the hyphen after the TLD, and a cut that drops the `-y` leaves a clean `x.ru`. Both are filtered a second time after the cut. A test builds that exact input, and removing the second pass makes it fail.

**The greeting drops links with no placeholder.** A name field that is only a URL becomes the plain "Hi," instead of "Hi [link],".

**An email pattern with no commas.** Providers read `to` as a list, so `me@mine.example,victim@other.example` passes a classic pattern and turns the acknowledgment into a relay to any address. The pattern refuses commas, semicolons, angle brackets, quotes and parentheses, which a provider could read as a second recipient or a display name.

**The clock tolerates skew.** `rendered_at` comes from the visitor's clock and is compared with the server's. In the source, a visitor whose clock ran one second ahead got a negative delta, negative is less than the threshold, and every message from them was dropped while the page said it had arrived. A negative delta now counts as skew, not as a bot. Without the field (no JavaScript) the clock is not judged.

**Silent drops say success.** The trap and the clock answer exactly like a sent message, because a bot that sees an error retries with the field empty. That is also why the clock threshold stays low, since a false positive is a lost message nobody hears about.

**The origin is rebuilt from the forwarded headers.** Some adapters build `request.url` from an internal host. In the source, a framework built it as `https://localhost/...` behind the platform's proxy, and on the day of a domain move every browser got a 403 from this check. The handler accepts the URL's origin, `Host`, the first entry of `X-Forwarded-Host` with `X-Forwarded-Proto`, and `allowedOrigins`. `trustForwardedHeaders: false` turns the forwarded pair off for a server with no proxy in front.

**The limit counts only accepted sends.** The source's first limiter stored refused attempts too. Its "try again in a few minutes" page invited retries, each retry pushed the window forward, and a person who kept trying stayed blocked. A test retries once a minute through a full window and then gets through. Validation runs before the limit, so a typo does not spend a send. The map holds at most 10,000 keys, least recently used out first. It lives in one process, so on serverless it is a ceiling per warm instance, not a hard defence.

**No key, no fake success.** A visitor told "received" waits for an answer that never comes. Without a transport the handler answers 503, and the no-JS page prints the public address, which works without the provider.

**A provider refusal is an error.** The Resend SDK returns `{ error }` instead of throwing, and the source once read that as success. An unverified sender and a key without permission both answered "got it" with the message nowhere. The adapter here throws on any non-2xx and on a 2xx with no `id`. Its error keeps the status and the provider's code, not the provider's message, which can echo the request.

**Whole HTML documents.** Both emails are a full document with `lang`, charset and title, plus a text part. An HTML part with no `<html>` tag is a standard spam signal (SpamAssassin's `HTML_MIME_NO_HTML_TAG`), and the source's acknowledgment was filed as junk before this.

**The acknowledgment's Reply-To is on the site's domain.** The source set it to the owner's free-mail inbox, and a domain sender with a free-mail Reply-To is the `FREEMAIL_FORGED_REPLYTO` signal. `publicAddress` is required and validated.

**Logs carry codes, not content.** Events are `{ kind, reason }`. The source logged the visitor's address on a failed send. Here no event carries anything the visitor typed, and a test checks it.

**A no-JS page for every outcome.** In the source the native submit had a page only on success, so a mistyped address left the visitor looking at raw JSON. Every outcome now has a page in the visitor's language, light or dark by `prefers-color-scheme`, with `role="status"` on the message and a visible focus ring on the link back.

## What the tests cover

| File | Covers |
|---|---|
| `test/handler.test.ts` | Both emails in both languages as whole documents with text parts, recipients and Reply-To, no dash in what the visitor receives; the destination never taken from the request; one-line subjects; configurable field names; link stripping with any TLD and the cut-then-filter case, ported from the source's script; the trap, the clock with skew, no clock without JS; origin with forwarded headers, `null`, extra origins, no header; eight invalid addresses and fields; 405, 415, 413 on a streamed body; 503 with no transport on both paths; five provider failures; a failed acknowledgment; logs without content; the limit with a fake clock and patient retries |
| `test/parts.test.ts` | `stripLinks` cases and its known false positives, `quote`, `greeting`, `htmlDocument` escaping, the limiter's bound and eviction, the Resend adapter's request shape and errors |

`test/helpers/fake-resend.ts` is a `fetch` that answers like Resend's `POST /emails`, with 200 and an id, 401 without the key and 422 for a missing field. It also scripts failures, such as a 422 that echoes the body, a 403, a network error, a 200 with no id and an HTML 502.

## Departures from the source

The live form's field names, thresholds and texts are not used here; all are options. The destination address is a required option instead of a constant. The limiter is LRU-bounded. Non-string JSON fields are ignored instead of stringified, so an array of addresses cannot become `"a,b"`. Content types other than JSON and form data get 415 instead of being parsed as a form. Visitor texts are in English and neutral Spanish.

## Limits

- The per-IP limit is per process. A real limit across instances needs a shared store.
- The clock trap only works with the page's script; a bot that waits three seconds passes it. The trap field catches only naive bots.
- `clientAddress` must come from the platform. If it is read from a header the client controls, the limit can be dodged.
- Bare-domain stripping has false positives in the quote, by design.
- Only a Resend adapter is included. Another provider needs a `MailTransport` of a few lines.
