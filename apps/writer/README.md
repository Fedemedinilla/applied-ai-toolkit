# Writer

Writer drafts a fictional school's communications to families. A staff member picks a role and a category, such as a field trip or a sensitive situation, and describes what has to be said; the model proposes titles, writes the draft and revises it. The voice is data: three JSON files validated with zod at build and at start, so a new category is an edit to one file. The model writes only the prose. Code picks the step, measures each language's length, lists the facts left as `[COMPLETAR: ...]` and writes the reminders under the draft. A family acts on those, and a model cannot count or be trusted to remember.

The pattern comes from a writing assistant I built for a school. The school here, Colegio Bilingüe Monte Lirio, is invented, and so are its roles, categories, style guide and four example communications. The interface is in Spanish, neutral Latin American.

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/writer                       # offline, no API key
npx vite build --config apps/writer/vite.config.ts   # writes dist/apps/writer
node csp-build-guard/cli.ts --dir dist/apps/writer --config apps/writer/csp-guard.config.json
node apps/writer/server/dev-server.ts            # the endpoint on 127.0.0.1:8788
npx vite --config apps/writer/vite.config.ts     # the page, with /api proxied to the endpoint
```

Without `ANTHROPIC_API_KEY` the endpoint still starts, `/api/health` answers 503, and the page says the writer is unavailable while the roles and categories can still be browsed. With the key, each turn is one call through [`gateway`](../../gateway/).

Vite 8.3.4 builds 14.70 kB of JavaScript (5.81 kB gzipped) and 4.12 kB of CSS. csp-build-guard passes it under a `'self'`-only policy, with no inline script and no regex lookbehind. It measures the page at 5.8 kB gzip and 5.2 kB brotli, against a 10 kB budget.

The eval case for the `[COMPLETAR]` rule has one opt-in live script and one offline report; see [What is measured](#what-is-measured).

## The flow

1. The page lists the four roles (Dirección, Coordinación de nivel, Docente, Administración). Choosing one shows only the categories that role writes, as radio chips; the chosen category's purpose, length range, languages and sensitivity appear under them.
2. The brief goes in a text box. The hint says to include dates, times and places, and that anything missing will appear as `[COMPLETAR: ...]`.
3. "Proponer títulos" sends `{role, category, messages}` to `POST ./api/draft`. The server builds the prompt for the titles step, the model answers with a `[[TITULOS]]` block, and the page shows three titles as a radio group.
4. "Redactar con este título" sends the history with the chosen title. The model answers with a `[[COMUNICADO]]` block, Spanish first and, for a bilingual category, an English version after an `[[EN]]` line.
5. The draft shows with each gap highlighted. Under it is the measured length of each language next to the category's range. Then come the warnings about the text, such as a gap, an emoji where none are allowed or a word the style guide replaces. Last come the category's reminders about the call to action, attachments, photos, graphics and reviewer.
6. "Ajustar la extensión" appears when a language is out of range and sends a change request with the measured numbers in it. "Pedir un cambio" sends any other change. Three rounds of changes fit in one draft.
7. "Copiar" writes `text/html` and `text/plain` in one clipboard item, so a mail client keeps the bold and the lists. If the browser refuses, it copies plain text, and the status line says how many gaps are left.

## Configuration as data

| File | Holds | Checked at build and start |
|---|---|---|
| [`config/categories.json`](config/categories.json) | 4 roles with their signatures, the committee signature, 9 categories | Unique ids; every role and reviewer exists; `length.min` below `length.max`; no emoji in a high or critical category; a call to action has a hint unless its mode is `none` |
| [`config/school.json`](config/school.json) | Name, time zone, 5 facts, 8 style rules, 5 vocabulary entries | `fictional` must be `true`; the time zone must be one `Intl` knows |
| [`config/examples.json`](config/examples.json) | 4 example communications I wrote for the fictional school | Each example's role writes its category; a bilingual category has an English text and a Spanish-only one does not; each text is inside its category's length range |

Adding a category is an edit to one file. The schema ([`src/config-schema.ts`](src/config-schema.ts)) reports every problem at once, each with the file, the path and the reason, and `vite build` stops on the first broken file. The last check caught two of my own examples on the first run. The field trip was 592 characters against a minimum of 600, and the English exhibition invitation 427 against 450.

## Design decisions

**The page sends ids, and the server owns the configuration.** If the browser sent the category's configuration, any request could lower its sensitivity or add a line to the system prompt. Here the body is `{role, category, messages}` in a strict zod object. The server looks both ids up, refuses a role that does not write the category (`category_not_for_role`), and builds every prompt line from `config/`. A test sends a body with a `categoryConfig` field and gets a 400 with no model call.

**The prompt is assembled in a fixed order, most stable first.** [`server/prompt.ts`](server/prompt.ts) builds four blocks. In order, they hold the rules, the school (facts, style guide, vocabulary, examples), the author and category, and the turn (step and date). The gateway gives each block its own cache breakpoint. A new turn of the same draft repeats the first three blocks byte for byte, and a test checks that across steps and days. For an event invitation written by a coordinator, at the draft step, the blocks are 2,205, 5,222, 756 and 134 bytes. Across the nine categories the four blocks total between 8,136 and 8,442 bytes. Whether the cache is read was not measured; the fake API cannot say.

**The sensitivity block goes last in the category block.** A high or critical category gets a paragraph after its tone and emoji lines. It sets a calm or very formal tone, forbids emoji, exclamation marks and rallying phrases, and signs as the committee ("Equipo Directivo"). For critical texts it also limits the draft to the facts in the brief, with no causes, student names or promises. It goes last, after the tone and emoji lines it overrides, so the prompt reads top to bottom with the exception after the rule; a test checks the order. The same rule is enforced three more times. The config refuses emoji in a sensitive category, the signature in the prompt comes from code (`signatureFor`), and the report warns about emoji or exclamation marks found in a sensitive draft.

**The code decides the step, and the model writes.** A model left to notice whether it should propose titles or write can lose track in a long conversation. Here `stepFor` reads the history. One user message is a brief and gets titles; a history with a draft in it is a revision; anything between is the draft for a chosen title. The step goes into the last system block, so a model that loses track of the conversation is still told what to do. A model that skips ahead to a draft on the first turn is accepted, since the job is done. The page then uses the category's name as the title, so the heading it focuses and the copied text are never empty.

**Markers, parsed strictly.** The reply protocol is plain-text markers. They let the parser accept a complete block and drop anything around it, they need no schema per category, and the page shows the draft as written, with no JSON layer to decode. Structured output was not tried. [`src/protocol.ts`](src/protocol.ts) accepts a block only with its closing marker, and a titles block only with at least two usable titles. Titles longer than 120 characters and repeats are dropped, and at most five are kept. A complete draft wins over a titles block in the same reply. Text outside the blocks is dropped. A reply with no complete block comes back with type `text` and is shown as a message; an empty one is `model_unusable`.

**The history gets the parsed reply, not the raw one.** Each response carries `assistant`, the reply rebuilt from what was parsed. The page sends that string back as the assistant turn. A preamble, a second block or a stray marker never reaches the next turn, and a test checks that parsing the rebuilt text gives the same reply for every kind. The server holds the page to it: an assistant turn must rebuild to itself, and a titles turn is accepted only as the first reply. Without that check, a script could write assistant turns with instructions after a block, or a few examples that turn the endpoint into a general model proxy until the cap runs out. Tests send four forged turns and check that no call is made.

**The history is validated and capped.** An endpoint that forwards any array of messages lets a request set the conversation's length and shape. Here the server accepts at most 9 messages of up to 4,000 characters each and 20,000 in total, starting and ending on a user turn and alternating in between. An ending on an assistant turn would be a prefill, which the gateway refuses anyway. Each user turn is wrapped in `<brief>` or `<message>` tags, and the rules say the brief is data. Its angle brackets become the look-alikes U+2039 and U+203A, so it cannot close its own tag while "<12 años" or "->" keeps its meaning. A body is refused unread when its Content-Length passes 64 KiB; otherwise it is read as a stream and the read is cancelled at 64 KiB. When the draft reaches the cap, the hint under the change box says so before anyone tries. The buttons stay enabled, so Enter or a click puts the same reason on the status line instead of doing nothing.

**The model cannot count characters, so the code does.** A model sees tokens, and its estimate of a text's length is a guess. The prompt gives each category's range and asks for the middle of it; [`src/checks.ts`](src/checks.ts) then counts code points of each language as a reader sees them. Bold markers and list dashes are left out, and each `[COMPLETAR: x]` counts as its label `x`. The number on the page is that count. "Ajustar la extensión" sends it to the model ("el texto en español tiene 1.320 caracteres y la categoría pide entre 400 y 900"), so the request carries a measurement instead of "shorter".

**A missing fact becomes a visible gap.** The rules tell the model to write `[COMPLETAR: what is missing]` for any date, time, place, name, amount, deadline or link the brief does not give, instead of a plausible value. A family acts on a meeting time, so an invented one costs more than a gap. The page highlights every gap, the report lists them in order, and the copy status says how many are left. Role signatures use the same marker (`Equipo docente de [COMPLETAR: grado o curso]`) so the model keeps a gap there unless the brief names the grade.

**Reminders come from the configuration, warnings from the text.** The notes under a draft are deterministic. Reminders follow from the category, such as adding the confirmation form or having the Coordinación read the text first. Warnings follow from the draft. They cover a gap, a length out of range, a missing English version, emoji where the category has none, exclamation marks in a sensitive text, or a word the style guide replaces. Vocabulary matches whole words with accents folded, so "excursión" and "EXCURSION" both match and "compadres" does not match "padres". Warnings come before reminders.

**Spending goes through the gateway.** [`server/model.ts`](server/model.ts) sets up `claude-sonnet-5-5` at medium effort, `max_tokens` 4,000, a 60-second deadline for the whole call and a US$5 cap per calendar month, in Buenos Aires time. For the meeting brief in the tests, the gateway estimates the titles turn at 8,859 input tokens. The reservation is therefore US$0.0577: 8,859 tokens at US$2 per million plus 4,000 at US$10. A reached cap answers `cap_reached` before any request leaves; a test spends US$1.20 against a US$1 cap and checks the fake API saw one request.

**Errors carry codes, never upstream text.** An API error message can echo the request, so a response holds a code (`cap_reached`, `model_unavailable`, `model_unusable`, `history_too_long`), with `retry-after` passed through for a 529. Log lines hold the gateway's code and never the brief; a test makes two calls that log (a 529 and an off-protocol reply) and checks the brief's words appear in no log line.

**The page gets the catalog at build time, and nothing else.** `vite.config.ts` parses the config and passes the public part (names, roles, length ranges, languages, sensitivity) to the page through `define`. The tone lines, the style guide, the examples and the prompt stay on the server, and a build test checks that none of them is in the bundle. The page imports only the types from the schema, so zod is not bundled either. It checks the server's replies with a hand-written guard (`asReply`).

**Model text never becomes markup.** The draft is rendered from segments ([`src/format.ts`](src/format.ts)) as text nodes, `<strong>` and `<mark>` elements built in code. The clipboard HTML is built with every character of the text escaped. A test sends `<img src=x onerror=...>` as a draft and finds no image in the page.

**A late answer is dropped.** Each request has its own `AbortController` and a 70-second deadline, a little over the server's 60. Changing the role or the category, or starting over, aborts the request in flight and says so on the status line. An answer that arrives anyway is ignored, so a draft for one category never lands under another.

**Accessible at a desk or on a phone.** Every chip is a real radio button with a label, so arrow keys and Tab work as in any radio group. Focus is always visible and moves to the titles and to the draft when they appear. The status line is a `role="status"` live region. Warnings differ from reminders by a "Revisar:" or "Recordatorio:" prefix and a side rule as well as colour. Light and dark follow `prefers-color-scheme`, and the layout holds at 360 px with no horizontal scroll.

## What is measured

The `[COMPLETAR]` rule is the one prompt rule whose value is a claim about the model, so it has an eval case in [`evals/`](evals/), run with this repository's [evals runner](../../evals/).

- **Target** ([`evals/target.ts`](evals/target.ts)). The product's own four blocks at the draft step, built by `server/prompt.ts`, and the product's call settings. V0 is what ships by construction. The brief and the chosen title travel in one user message, in the tags the product uses.
- **Variants** ([`evals/variants.ts`](evals/variants.ts)). V0 with the rule, and NC with the rule paragraph and the call-to-action gap clause removed by exact edits. Each edit must match once, so a change to the rule's wording stops the run before the first call. The marker still appears in two role signatures and the revise line, so NC measures the rule, not the absence of the marker.
- **Cases** ([`evals/cases.ts`](evals/cases.ts)). 10 briefs. Four give every fact the piece needs, so a gap there is needless. Six leave out a day, a time, a place or an amount. None uses a relative date such as "el viernes", which the model could resolve against the TODAY line to a day the fact sheet does not hold. So any day of the month in a draft must come from the brief, and a test fails if a brief or title gains a relative date.
- **Score** ([`evals/specifics.ts`](evals/specifics.ts)), computed in code with no judge. It checks whether the reply followed the protocol and counts the gaps. Its main output lists the times, numbers, emails and links in the draft that the fact sheet does not hold. The fact sheet is the school's facts, the brief, the title, the signature and the date. The examples are left out, so a time copied from an example counts as invented.
- **Report** ([`evals/report.ts`](evals/report.ts)). Per variant and brief kind, it gives the share of pieces with an invented specific and the share with a gap, each with a 95% Wilson interval, failed calls in their own column, and every unsupported specific listed by case.

```sh
node apps/writer/evals/run.ts prompts.json --variants NC --dump          # the prompts, no key, no call
ANTHROPIC_API_KEY=sk-ant-... node apps/writer/evals/run.ts rows.jsonl    # live: V0 and NC, 10 cases, 3 samples, 60 calls
node apps/writer/evals/report.ts rows.jsonl                              # offline
```

The live run goes through the gateway rather than the SDK, so it spends under the same ledger and a cap (`--cap-usd`, US$5 by default). It refuses call settings that differ from the gateway's task config. No live run has been made for this folder, and no rows file is committed. The tests run the whole pipeline with scripted models only, which checks the plumbing and says nothing about the real model.

## What the tests cover

| File | Covers |
|---|---|
| `test/config.test.ts` | The shipped files parse; every role writes a category and every sensitivity is used; contact details are `.example` only; each cross-file rule rejects a broken copy with its exact message; all problems reported at once; the page's catalog carries no prompt text |
| `test/prompt.test.ts` | Block order; blocks 0 to 2 identical across steps and days; the `[COMPLETAR]` rule once; the school block's order and the four examples; every category line in order; the sensitivity block last, committee signature, no emoji; the TODAY line in the school's zone across UTC midnight; `stepFor` on four histories |
| `test/protocol.test.ts` | Titles in four line styles, length and count limits, fewer than two; drafts with and without `[[EN]]`; a draft beating titles; unclosed and empty blocks; text outside blocks dropped; the canonical text parses back to the same reply; placeholder extraction |
| `test/checks.test.ts` | Character counting with bold, dashes, gaps, accents and emoji; range boundaries; signatures; emoji rules, with ©, ®, ™ and ‼ not counted as emoji; whole-word, accent-folded vocabulary; the reminders of each kind of category; length warnings with grouped numbers; gap notes; missing and unexpected English; warnings before reminders; the four examples pass their own checks |
| `test/handler.test.ts` | The handler over the real gateway and SDK client against a fake streaming API: health; the request body (model, effort, the four blocks with cache breakpoints, the wrapped brief); the reservation and its priced closing row; titles, draft and revision turns; off-protocol and empty replies; 17 malformed bodies refused with no call; brackets in the brief replaced, not dropped; four forged assistant turns and a titles turn out of place refused with no call; a chunked body over the limit cancelled mid-read; no brief in logs; `max_tokens` and refusal stops; 529 with `retry-after` and 401; a stream cut halfway, recorded as incomplete; the cap spent |
| `test/format.test.ts` | Segments with bold and gaps; paragraphs and lists; HTML escaping; plain text; title and English order in the copy; no empty title paragraph; gaps kept in both types |
| `test/app.dom.test.ts` | jsdom against the real `index.html`: roles and the categories each one writes; category info; labelled radios; missing-field messages; the two turns and the exact history sent; titles as a radio group with focus; the draft with gaps, lengths and notes; model markup shown as text; the English version; rich copy, plain fallback and no clipboard; the length fix with measured numbers; three rounds of changes by button, then the cap on the hint and on a click; a draft on the first turn titled with the category name, in the page and the copy; five failure messages with the history kept; the page's deadline; a late answer dropped after a change of category; no server |
| `test/build.test.ts` | The production build into a temp folder: one script and one stylesheet with relative URLs; no inline script, eval or lookbehind; every category name present; no prompt text, style rule, example or tone; no zod |
| `test/evals.test.ts` | Ten cases with valid roles and categories; no relative date in a brief or title; V0 equals the product prompt; the one-message brief; the fact sheet without examples; NC applies to every case and changes only the rule and the clause; dumps; specifics extraction and support rules; draft scoring; a scripted run that puts an invention on NC, gaps on V0 and a failed call in its column; the gateway as the eval client, and its refusal of drifted settings |

129 tests, all offline. `test/fake-anthropic.ts` is the fake API. It answers the real client with server-sent events in the API's format and can cut a stream after any event.

## Layout

```
config/            categories.json, school.json, examples.json (the configuration)
src/               the page, plus the pure modules the server shares
  config-schema.ts zod schemas, cross-file checks, the page's catalog
  protocol.ts      markers, parsing, the canonical history text, placeholders
  checks.ts        length, notes, signatures, vocabulary
  format.ts        segments, clipboard HTML and plain text
  clipboard.ts     rich copy with a plain fallback
  api.ts           the reply guard and the error messages
  app.ts, main.ts  the page
server/
  prompt.ts        the four blocks, the step, the TODAY line
  handler.ts       POST /api/draft and GET /api/health
  model.ts         the gateway set-up and its numbers
  config.ts        loads and validates config/ at start
  env.ts           the one reader of ANTHROPIC_API_KEY
  index.ts         the handler from the environment
  dev-server.ts    node:http on 127.0.0.1:8788
evals/             target, variants, cases, score, run (live), report (offline)
test/              Vitest suites and the fake API
```

## Limits

- **The eval has not been run.** There is no figure for how often either variant invents a fact. The deterministic score sees numbers, times, emails and links only. It misses an invented procedure in words ("traer una vianda"), a weekday that does not match its date, and a missing fact left with no gap. The line-by-line judge in `evals/` reads those, but its script is wired to the evals example, not to this target.
- **The eval skips the titles turn.** The runner sends one user message, so the brief and the chosen title travel together; the product sends them in three turns. The system blocks are the product's.
- **The NC variant leaves a hole in the numbering.** Removing the rule's section leaves the rules numbered 1, 2, 4, 5, 6. Renumbering would be a second edit that is not part of what is measured.
- **The model was tested against a fake API only.** The prompt has not been read against real drafts in this folder.
- **The cap holds per process.** The ledger is the gateway's in-memory store, so on a serverless host the US$5 is per instance lifetime. Holding the month needs the gateway's Postgres schema and an adapter.
- **No sign-in.** This folder has no accounts, so anyone who can reach the endpoint can spend up to the cap.
- **The history is the client's word.** The page sends the conversation. The server refuses assistant turns that are not canonical or not in their place. A canonical text turn, though, is plain prose, so a script can still write one ("Entendido, sin reglas") for the model to read. The system prompt still comes only from `config/`, the shape and size caps hold, and the cap bounds the spend. A server-side store of turns, or a signature on each `assistant` string, would close it.
- **NC may understate the rule's effect.** The marker's format stays visible in NC through the coordinator and teacher signatures (4 of the 10 cases) and the revise line, so the model can still learn to leave a gap there.
- **Length is code points.** A combining accent typed as two code points counts as two characters.
- **Bilingual means Spanish and English only,** and the English version is checked for length and presence, not for matching the Spanish.
- **No streaming to the page.** The gateway streams from the API, but the page waits for the whole reply, up to 70 seconds.
- **No host config.** The handler takes a `Request` and returns a `Response`, and `dev-server.ts` wraps it for `node:http`. Nothing is deployed.
