# Rewriter

Rewriter puts [`prose-rewriter`](../../prose-rewriter/) behind a page. You paste a cover letter, an email, a follow-up or a WhatsApp message you wrote, along with your CV. The page shows the result in three panels. The first is your text with slop-lint's findings marked. The second is the rewrite, with each change, its reason and a button to revert it. The third holds the facts, the flags, the status and what the call cost. The model only proposes edits. Code places them, checks each one against your text and your CV, and takes back any that adds or loses a fact. In the page you can take back more.

It runs in two ways. On your own machine a small server holds `ANTHROPIC_API_KEY` and calls the model through [`gateway`](../../gateway/). On GitHub Pages there is no server, so the page shows eight rewrites the model made earlier, of invented texts, and makes no call. The interface is in English; the texts may be in Spanish or English.

Live demo: <https://fedemedinilla.github.io/applied-ai-toolkit/rewriter/>

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/rewriter                          # offline, no API key
npx vite build --config apps/rewriter/vite.config.ts  # writes dist/apps/rewriter
node csp-build-guard/cli.ts --dir dist/apps/rewriter --config apps/rewriter/csp-guard.config.json
ANTHROPIC_API_KEY=sk-ant-... node apps/rewriter/server/dev-server.ts   # the endpoint on 127.0.0.1:8789
npx vite --config apps/rewriter/vite.config.ts        # the page, with /api proxied to the endpoint
```

Without the key the server still starts. `/api/health` answers 503, and the page says the server cannot rewrite and shows the recorded examples instead.

Vite 8.3.4 builds 19.90 kB of JavaScript (7.90 kB gzipped) and 7.93 kB of CSS. csp-build-guard passes it under a `'self'`-only policy, with no inline script and no regex lookbehind. It measures the page's script at 7.8 kB gzip and 7.0 kB brotli, against a budget of 10 kB gzip and 9 kB brotli. The recordings, 88 kB of JSON, are fetched only in demo mode and are not part of that budget.

## The flow

1. The page asks `./api/health` once, with a 3-second limit. Only a 200 with `{"ok": true}` means a server with a key. A 503 with `{"ok": false}` means a server without one. Anything else, such as the 404 of a static host or no network, means there is no server.
2. **Local mode.** The form takes the text, its kind and its language, the Spanish variety (Spanish only), the register and how far to go. The register and how far to go default to the genre's own. Then come the recipient's name, organisation and role, the earlier message (for a follow-up) and phrases to leave as they are, one per line. Last comes the CV in Markdown. "Rewrite" posts them to `./api/rewrite`.
3. **Demo mode.** The page fetches `./examples.json` and lists the examples as a radio group. Under the list, each one says why it is there, and the result panels fill at once.
4. **Panel 1** shows the text as the rewriter read it, with every finding marked. Findings that overlap are cut at each boundary ([`src/marks.ts`](src/marks.ts)). Each finding is also listed with its rule, its level, the matched words, the message and the suggestion.
5. **Panel 2** shows the rewrite, with kept changes underlined and reverted ones shaded. Each change the rewrite applied has a Revert button, which turns into Keep. "Revert every change" gives your text back, and "Keep every change" gives the full rewrite. The changes the checks took back are listed apart, with their reason and no button. "Copy the text" copies what the panel shows.
6. **Panel 3** gives the status (OK, Needs review, Blocked) with a sentence on what it means, the rewriter's own message if there is one, and the flags. Next come the facts by group: added from your CV, stated only in your text, added with nothing behind them, dropped, left to fill in, and kept. Then come slop-lint's counts and score before and after, and the number of model calls with their cost.

## Design decisions

**The page rebuilds the text and never asks the model again.** Every change carries its span in the original, its "before" and its "after". [`src/recompose.ts`](src/recompose.ts) walks the applied changes in order and puts in the "after" of each one you keep and the "before" of each one you revert. A revert can only give back your own words, so it cannot add a fact. A change the checks took back has status `reverted` and is never placed, whatever the page asks; a test asks for one and checks it stays out. The function refuses applied changes whose spans overlap, run past the text or do not hold their "before". It does not check reverted ones, since it never places them. An edit the code could not place comes back reverted. Its span is the sentence the model named, and its "before" is the model's own quote. The page labels that quote "Quoted by the model (not found in your text)", not as your words, and says in plain English why each change was taken back ([`src/revert-reason.ts`](src/revert-reason.ts)). When all the changes together do not rebuild the returned rewrite, the page shows that rewrite as returned, with no buttons, and says why.

**The lint numbers are for the rewrite as returned.** Running slop-lint again in the page would put the linter and its rules in the bundle. It would also mean answering a question about a text the checks never saw. The panel says that the numbers count every change, and that reverting one here does not run the checks again.

**The server is the CLI's set-up behind HTTP.** [`server/model.ts`](server/model.ts) seeds the gateway's in-memory stores with prose-rewriter's four task configs, its caps (`REWRITE_CAPS`: US$0.25 per job, US$2 a day per user, US$10 a month) and the gateway's built-in prices. That is what `prose-rewriter/cli.ts` does, with the same 120-second deadline per call. The server loads style-refs' principles, sources and examples with style-refs' own schemas at start ([`server/refs.ts`](server/refs.ts)), so a broken data file stops it before the first request. Each rewrite gets a new job id, so the per-job cap binds per rewrite.

**The body is strict.** [`server/handler.ts`](server/handler.ts) parses the body with a strict zod object and then with prose-rewriter's `RewriteInput`. A request cannot choose the strategy, the models, the fact judge's `strict` switch or a field the page does not send. A variety with English is refused before any call. The text holds up to 6,000 characters, the CV 20,000, the earlier message 6,000, a recipient field 200, and up to 10 phrases to keep of 300 each. A body is refused unread when its Content-Length passes 128 KiB; otherwise it is read as a stream and the read is cancelled at 128 KiB. Only `application/json` is taken, and a browser that says the post comes from another site gets a 403.

**The CV is used once and kept nowhere.** The page holds it only in its text box. It never writes it to `localStorage`, a cookie or the URL, and the text box has `autocomplete="off"`. The server passes it to `rewrite()` and nothing else. A 400 names the fields that failed and never their values; an unknown key is reported as `(body)`, not by name. A log line holds an event name and the gateway's code. A test fails a call with a 529, a 401 and a 400 and sends two bodies the server refuses. It then looks for the CV, the text and the recipient in every response body, every handler log line and every gateway log line, and finds none. The CV does reach the model, inside the prompt, and the same test checks that it does.

**Demo mode reads the 404.** GitHub Pages answers `./api/health` with its 404 page, so the page knows it has no server, as [Caja](../caja/) does with its model mode. The recordings live in `demo/`, which is Vite's public folder. They are copied next to the page and fetched only in demo mode, so they never weigh on the script.

**The recordings are real and checked.** The eight examples are rewrites the model made on 2026-11-18 with the default strategy (`single-guarded`). That code has the fact-check fixes of #25, so a verb that opens a line is no longer read as a name. It also tells the single call to cut stock formulas (`rewrite-single@3`, #26). The first recordings, of 2026-11-17, are in the git history. They are of invented eval cases from `prose-rewriter/evals/cases/`, rewritten against the invented CVs there. [`scripts/demo-examples.ts`](scripts/demo-examples.ts) builds the file from a run's `pieces.jsonl`. It takes each input from its eval case and keeps each result whole, dropping only the eval record's `kind` tag. [`test/demo.test.ts`](test/demo.test.ts) parses every result with prose-rewriter's `RewriteResult` and matches every input to its case. It then rebuilds every recorded rewrite from its changes, and the original with all of them reverted. It also checks what the set covers: both languages and the four genres, a heavy rewrite and a text left alone. It holds an instruction inside a draft, a review, changes taken back, facts added from the CV and an earlier message. The file starts with a `fictional` marker, and `prose-rewriter/test/fixtures.test.ts` scans every string in it with the same check as the eval cases. It looks for addresses outside reserved domains, real-looking phones, real hosts and the owner's name.

**The page checks what it is given.** Server replies and recordings both go through a hand-written shape check ([`src/result.ts`](src/result.ts), [`src/demo.ts`](src/demo.ts)), since zod would be most of the script. A type test checks that every `RewriteResult` fits the page's types. The page keeps its own copies of the option lists, and a test holds them to prose-rewriter's enums. The page imports only types from prose-rewriter, and the build test finds no zod, no slop-lint rule and none of the prompt's rules in the bundle.

**Model text never becomes markup.** Every text from the model, the server or the recordings goes into the page as a text node, or inside a `<mark>`, `<ins>`, `<del>` or `<q>` built in code. A test sends `<img onerror>` in the original and markup in a change and a flag, and finds no image, bold or script element in the result.

**Accessible at a desk or on a phone.** Every field has a label. The examples are a native radio group. Revert and Keep are buttons whose names include the change number, so they work with Tab, Enter and Space, and focus stays on the button after a click. The status line is a `role="status"` live region that says what changed. After a rewrite, focus moves to the heading above the panels. A kept change differs from a reverted one by its label, "Kept" or "Reverted, your words back", a side rule and strikethrough, as well as colour. Light and dark follow `prefers-color-scheme` through the toolkit's shared look. The panels sit side by side from 1,100 px and stack below that, with no horizontal scroll at 390 px.

## What is measured

- **Build.** The sizes and the csp-build-guard result above, measured on this folder with Vite 8.3.4.
- **The recordings.** The eight results came from the model in a live run. Each one cost between US$0.0098 and US$0.1535, in 1 or 2 calls, as the gateway priced them. These are eight fictional cases, so they are not a cost estimate for your text; prose-rewriter's README has the medians by genre.
- **No real rewrite through this server has been measured.** The tests drive `rewrite()`, the real gateway and the real SDK client against a fake API that answers with scripted replies. That checks the plumbing and says nothing about the model.

## What the tests cover

| File | Covers |
|---|---|
| `test/recompose.test.ts` | All kept gives the rewrite, none kept gives the original; one change reverted; any order; a check-reverted change never placed; unknown ids; pieces kept, restored and unchanged; deletions; adjacent hunks reverted one at a time; changes at both ends; emoji before a change (UTF-16 offsets); an insertion next to a change; overlap, out-of-range, wrong "before", a backwards span and a repeated id refused; a reverted misquote (sentence span or `{0,0}`) accepted |
| `test/marks.test.ts` | No finding; one finding; overlapping, touching and nested findings; empty findings and spans past the end; emoji |
| `test/protocol.test.ts` | The option lists equal prose-rewriter's enums and each has a label; every `RewriteResult` fits the page's types; the shape check accepts a result and refuses nine broken ones |
| `test/handler.test.ts` | Health with and without a key; subpaths, methods and paths; the key reader; a rewrite with one edit call and the fact judge on their models, priced, in the ledger under one job id; a job id per rewrite; a not-found edit that still rebuilds change by change; S1b with no call; recipient, earlier message, mode, register and keep phrases in the prompt; 23 bad bodies refused with no call; a body that is not JSON; text/plain and cross-site posts; a declared and a chunked oversized body; a 529 with `retry-after`, a 401, the monthly cap; no CV, text or recipient in any log or error |
| `test/dev-server.test.ts` | Only `127.0.0.1` or `localhost` on its own port answered; an oversized body capped |
| `test/demo.test.ts` | The fiction marker and the shape; each result parses as `RewriteResult`; each input is its eval case's, with a fictional CV; each rewrite rebuilt from its changes and reverted to the original; the coverage of the set; the injection not followed; the file is what the script builds; the shape check refuses a set without the marker, an empty one and broken entries |
| `test/app.dom.test.ts` | jsdom against the real `index.html`. Demo mode on a 404, a network failure, a 503 and an HTML 200; the examples as labelled radios; switching and announcing; recordings that fail to load. The three panels: marks, findings, changes with and without buttons, revert reasons in plain English, status, flags, facts, lint with its score hint, and cost. Revert and keep by button with focus kept; all reverted and all kept, and the copy. Local mode: the form and its labels, missing fields, the exact body sent, no variety for English, the CV kept out of storage, eight failures, the deadline, an unrebuildable result, a misquoted edit labelled as the model's with the buttons kept, markup shown as text |
| `test/revert-reason.test.ts` | Each of prose-rewriter's revert reasons in plain English; an unknown one passed through |
| `test/build.test.ts` | The production build: one script and one stylesheet with relative URLs; the recordings next to the page and not in the script; no inline script, handler, eval or lookbehind; no prompt rule, zod or slop-lint rule |

150 tests, all offline; the dev-server test listens on a loopback port only.

## Layout

```
demo/examples.json  eight recorded rewrites of fictional cases (Vite's public folder)
scripts/            demo-examples.ts, which builds that file from an eval run
src/
  protocol.ts       the request, the option lists and the limits, shared with the server
  result.ts         the page's types for RewriteResult and their shape check
  recompose.ts      the text from the original and the changes kept
  marks.ts          the original cut at the findings
  revert-reason.ts  the checks' reasons for a revert, in plain English
  demo.ts           the recordings' shape check
  api.ts            health, the rewrite request and the error messages
  app.ts, main.ts   the page
server/
  handler.ts        POST /api/rewrite and GET /api/health
  model.ts          the gateway with prose-rewriter's tasks and caps
  refs.ts           style-refs' data, checked at start
  env.ts            the one reader of ANTHROPIC_API_KEY
  index.ts          the handler from the environment
  dev-server.ts     node:http on 127.0.0.1:8789
test/               Vitest suites and the fake API
```

## Limits

- **The caps hold per process.** The ledger is the gateway's in-memory store, so the US$10 a month starts again when the server restarts. With no user accounts every call goes with no user id, and the gateway skips the daily cap.
- **A disconnect does not stop a rewrite.** `rewrite()` takes no abort signal, so when the page gives up after four minutes, or its tab closes, the calls already started run to the end. The caps still bound them.
- **No sign-in.** Anyone who can reach the server can spend up to the caps. It listens on 127.0.0.1 and answers only its own Host, against DNS rebinding.
- **Reverting is per change, not per word.** A change that rewrote a whole sentence comes back whole. To keep part of it, copy the text and edit it.
- **The checks ran on the whole rewrite.** The fact checks and the voice checks judged the changes together. A mix of kept and reverted changes is safe for facts, because a revert only gives back your own words. Whether it still reads well, and what slop-lint would find in it now, nobody checked.
- **The recordings are eight fictional cases.** They show what the model did once, on texts written to test it. Your own text may get more changes or fewer.
- **No host config.** The handler takes a `Request` and returns a `Response`, and `dev-server.ts` wraps it for `node:http`. Nothing beyond the demo is deployed.
