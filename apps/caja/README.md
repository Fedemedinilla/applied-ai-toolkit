# Caja

Caja is an installable, offline cash book for a small shop, built on [`amount-parser`](../../amount-parser/). The owner types or dictates a sentence in Rioplatense Spanish, such as "vendí 3 docenas a 12 mil la docena". The app turns it into a row with the amount, income or expense, a category, and the words each came from. When the sentence has two readings, the app asks which one and saves only after the answer. It shows the parser where it is meant to run: in the browser, on every entry, with no model call. Typing works offline; dictation depends on the browser.

Live demo: (link added when deployed)

## The flow

The interface is in Spanish and speaks to the owner as "vos". The fictional shop is a bakery.

1. The owner types "vendí 5 tortas a 8000" and presses Enter (or taps Dictar, when the browser has speech recognition).
2. The preview shows the sentence with "5" and "8000" marked, Ingreso (by "vendí") and Ventas (no keyword). Below them the app asks whether 8000 is the price of each cake or the total, with one button for $40.000 and one for $8.000.
3. The owner taps $40.000. A sentence with only one reading has no question; focus is already on Guardar, so pressing Enter twice saves it.
4. The row joins today's list. The day's totals (Entró, Salió, Neto) update, the status line offers Deshacer, and Exportar CSV downloads the whole book.

Editing the sentence after it was read clears the preview, so Guardar never saves words that are no longer in the box.

A second tab lists the parser's 165 corpus phrases. Each shows its family, the expected result, what the parser returns in this browser, and the note. A text filter, a family filter and an "only the ones that ask" switch narrow the list. A third tab explains the app in plain Spanish and links here.

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/caja                 # offline, no API key, about two seconds
npm run build:caja                       # writes dist/apps/caja (npm run build:apps builds every app)
npm run guard:apps                       # csp-build-guard over dist/apps/caja (csp-guard.config.json)
npx vite preview apps/caja               # serves dist/apps/caja at http://localhost:4173
npx vite apps/caja                       # dev server with reload; no service worker in dev
node apps/caja/scripts/icons.ts          # redraws the icons in apps/caja/public
```

The output uses relative URLs only (`base: './'`), so `dist/apps/caja` works at a domain root or under a subpath such as GitHub Pages. The service worker needs `localhost` or HTTPS; anywhere else the app runs but does not open offline.

The build (Vite 8.3.4) writes 39.20 kB of JavaScript, 14.95 kB gzipped, and 7.41 kB of CSS. The service worker is 2.27 kB. The 63.20 kB corpus is fetched only when the phrases tab opens.

After the build, CI runs [`csp-build-guard`](../../csp-build-guard/) over `dist/apps/caja` with [`csp-guard.config.json`](csp-guard.config.json). The app ships no Content-Security-Policy of its own yet, since it has no deploy config, so the config holds the strict policy a host should send (`'self'` only, `data:` images, no plugins) as a `literal`. The run checks that the build works under it with no inline script, has no regex lookbehind, and keeps the JavaScript of `index.html` under 20 kB gzipped.

## Design decisions

**No model in the loop.** The amount comes from `parseAmount`, and income or expense and the category come from a keyword table in [`src/categories.ts`](src/categories.ts). The parser takes about 27 µs per phrase on Node 24 (its own benchmark), neither step costs anything per entry, and both give the same answer for the same sentence. Every field on the preview says what decided it. The amount has its marked spans, the kind says `por "vendí"`, the category says `por "harina"`. A wrong category can then be traced to one word and fixed in one line.

**Ask instead of guess.** [`src/questions.ts`](src/questions.ts) has one question per ambiguity reason the parser returns, ten in all. Every number on a button comes from the parser, run again on the words it already marked. For "5 tortas a 8000" the parser returns no quantity or unit price on purpose; appending "c/u" pins the per-unit reading, and the parser then hands over both numbers. When the figures cannot be recovered that way ("un palo y pico", several quantities, a foreign currency), the question has no buttons and asks for the amount. A button with a guessed number would look like an answer the app had checked. Three more rules follow from the same idea:

- When every reading gives the same amount ("vendí 1 torta a 8000"), there is no question, because two buttons with one number ask nothing.
- Money in and money out in one sentence cannot be saved as one row at all. The app asks for two entries.
- A typed answer goes through the parser too and must be one plain amount, so typing "entre 10 y 12 mil" into the answer box does not get past the question.

**Whole words, earliest match, and a visible default.** Keywords match whole words after folding accents and case. Substring matching files "gasté 30 mil en el centro" as income ("centro" contains "entró") and "gasoil" as the gas bill. When income and expense verbs both appear, the earliest one in the sentence wins. "me cobró" is listed as an expense, because the supplier charged, and it starts before "cobro", so it beats the income reading. The table keeps each entry with its accents, which is what the preview shows; matching folds both sides, so "vendi" typed without the accent still matches. An income never gets an expense category and the reverse, and flipping the kind on the preview re-picks the category from the other table. When no keyword matches, the default ("Otros gastos", or an expense assumed) is labeled "sin palabra clave" or "supuesto", so a default never reads as a match. On the corpus, `kindOf` agrees with the recorded kind on 164 of 165 phrases. The miss is "hice 5 destapaciones a 35 lucas cada una", which is income only if you know the speaker is a plumber.

**Offline first, with a service worker written by hand.** [`src/sw-core.ts`](src/sw-core.ts) holds the decisions and [`src/sw.ts`](src/sw.ts) wires them to the worker events. Files under `assets/` carry a content hash in their name, so they never change and are served cache first. Everything else (index.html, the manifest, the icons, corpus.json) keeps its name across builds and is served network first. A cache-first index.html would pin the owner to the first version forever, because it is the file that names the new hashed assets. The network gets 3 seconds, and then the cached copy is served while the fetch finishes in the background. A phone that shows full signal and passes no packets would otherwise leave the till on a blank screen. A navigation answered with a 404 or 503 gets the cached app too, so a host or proxy error page never replaces the till. Offline navigations fall back to the precached index.html, so a link with a query string still opens.

**The precache list is generated, not written.** The plugin in [`vite.config.ts`](vite.config.ts) builds `sw.js` unhashed at the root of the output, because a worker's URL is its identity and a hashed name would install a second worker on every build. It writes into `sw.js` the list of every file the build produced and a hash of their contents as the cache name. A file added later is cached on install without anyone editing a list, and any change to any file gives the next build a new cache. Install fetches with `cache: 'reload'`, so the HTTP cache cannot fill the precache with an old index.html. The cache name carries a hash of the worker's scope, and activate deletes only older caches with that same prefix. GitHub Pages serves every path of a site under one host, so a preview copy of Caja next to the main one keeps its own precache. The plugin walks `public/` recursively, because a folder name in the precache would 404 and fail the whole install. `sw.js` is a classic script, and a build test fails if it ever contains an `import`. A failed cache write (a full quota) still serves the response it was storing.

**One copy of the corpus.** The same plugin serves `corpus.json` in dev and emits it in the build straight from `amount-parser/corpus/`. The phrases tab runs `parseAmount` on every phrase in the browser, so it shows what the shipped parser does. It applies the parser's own acceptance rule. A phrase with a total must give that total, and a phrase marked ambiguous without one must ask.

**localStorage, validated, never overwritten blind.** The book is one JSON array under one key. A row measured 224 to 255 characters of JSON on three sample sentences, so a 5 MB quota holds on the order of 20,000 rows (an estimate, not a measured quota). The whole book is read and written at once, which keeps the code synchronous and short. IndexedDB would add an async layer for no gain at this size. localStorage throws in some private modes and when the quota is full, and it can hold anything. Every row is validated on load, and rows without the shape are left out of the list and counted. Because the next save replaces the whole array, the raw stored text is first copied to a backup key (`caja.rows.v1.corrupt-<time>`), and the warning names it. If the copy cannot be written, the app keeps rows in memory and does not write at all. A failed write shows a warning that tells the owner to export the CSV before closing. The sale typed a minute ago must not disappear without a word, and neither must last month's book.

**Owner text never becomes markup or a formula.** The DOM layer adds it as text nodes only (`h()` in [`src/dom.ts`](src/dom.ts) calls `append`, never `innerHTML`). The export follows RFC 4180 (comma separated, CRLF, quotes doubled). In the CSV, the sentence is free text, and a spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` as a formula, so those text cells get a leading apostrophe. Amounts are written by the code and never get one. A byte order mark makes spreadsheet programs read the file as UTF-8, so "vendí" survives.

**Amounts are positive, totals are in cents.** Direction is the kind, never a sign. A zero or a figure above 1e11 is refused with a message. Daily totals are summed in integer cents, so 0.1 + 0.2 shows as $0,30. Whole pesos show no decimals ($36.000); any amount with cents shows two.

**Accessible at the counter.** Every input has a label. The tabs follow the ARIA tab pattern, with arrow keys, Home and End. Focus is always visible, the preview is an `aria-live` region, and the status line is a `role="status"` region. Income and expense differ by sign, label and a side rule as well as color. Light and dark themes follow `prefers-color-scheme`, animation stops under `prefers-reduced-motion`, and the layout holds at 360 px wide with no horizontal scroll. A sentence that can never be saved (money in and out at once) shows only the sentence and the request for two entries, with no guessed kind and no flip button.

**Dictation only where it exists.** The button stays hidden unless the browser exposes `SpeechRecognition` or `webkitSpeechRecognition`. Its error codes map to messages the owner can act on. "network", for example, says the browser's dictation needs a connection.

## What the tests cover

| File | Covers |
|---|---|
| `test/entry.test.ts` | Row building: ready, ask, no amount and invalid drafts; the collapse when both readings are equal; resolving by reading, button or typed amount; typed answers that are ranges, words or zero refused; a mixed-direction sentence cannot be saved; flipping the kind re-picks the category |
| `test/questions.test.ts` | One test per ambiguity reason, with the exact prompt and button amounts; scale borrowing in ranges ("entre 20 y 25 mil"); every ambiguous corpus phrase gets a question for its own reason with positive, distinct buttons, and all ten reasons are reached; singular nouns for the prompt |
| `test/categories.test.ts` | Kind and category by keyword, the "centro" and "gasoil" traps, earliest match ("me cobra" stays an expense, "cobro 5000" is income), accents folded on input and kept on display, the side rule, and the 164 of 165 agreement with the corpus kinds |
| `test/ledger-csv.test.ts` | Daily totals by local day, sums in cents, undo of the most recent row; CSV quoting, line breaks and formula injection; money formatting, with two decimals whenever there are cents; highlight segments that drop overlapping and out-of-range spans without losing a character |
| `test/storage-corpus.test.ts` | Storage round trip; invalid rows left out and counted, with the raw text copied to a backup key; no write when the copy fails; storage that throws on read or write; the corpus tab's data: 165 phrases in 15 families, agreement on all but the documented known conflict, filters, a Spanish label for every ambiguity reason |
| `test/sw-core.test.ts` | Strategy per request; cache first; network first online, offline, offline with nothing cached, a hanging network served from cache after the timeout, a slow network with no copy; a navigation answered with 503 served from cache; a full cache; stale cache cleanup, including two copies of the app under different scopes on one origin |
| `test/app.dom.test.ts` | jsdom against the real `index.html`: type a sentence and see the row and the marks; answer the question and find the row saved; a typed answer refused, then accepted; mixed directions shown without guesses; editing the sentence clears a stale preview; the empty-input hint cleared by the next read; the kind flip; undo from the status line and from the book; CSV export; stored rows listed on start; corrupt storage copied before the first save, and left untouched when no copy can be made; the warning without storage; dictation hidden, and with a fake recognizer; tabs by keyboard; the phrases tab loading, filtering, failing, and loading on the next open after a failure |
| `test/build.test.ts` | Runs the production build into a temp folder: the manifest and its icons, relative URLs only, `sw.js` with its placeholders replaced and no `import` or `export`, a precache equal to every file in the output, the corpus shipped unchanged |

128 tests, all offline.

## Limits

- **Dictation is not offline everywhere.** In Chrome the Web Speech API sends the audio to a server, so dictation needs a connection even though the rest of the app does not. Firefox does not expose `SpeechRecognition` by default, and the button stays hidden there.
- **One device, one book.** Rows live in this browser's localStorage. There is no sync, and clearing the site's data deletes the book. The CSV export is the backup.
- **The keyword table is small and made for a bakery.** A sentence with no known verb is assumed to be an expense and labeled that way. "cobró" without "me" before it reads as income, so "el gasista cobró 20 mil" needs the flip button. A category outside the table falls to "Otros gastos".
- **The parser's limits apply.** One amount per sentence, Rioplatense Spanish only, and the known conflict and limits listed in the [amount-parser README](../../amount-parser/README.md#limits).
- **Instalments are recorded at the full cost.** "compré un horno en 12 cuotas de 50 mil" saves $600.000, the purchase cost the parser computes, not the one instalment paid that day. The parser asks only when it cannot tell the item from the payment ("6 cuotas sin interés de 25 lucas").
- **"+ iva" with no rate is not asked about.** "pagué 30 mil + iva" saves $30.000; the parser reads "+" as a sign here, not as the word "más". Typing "más iva" gets the question.
- **The 21% IVA button is an assumption.** It is the general rate in Argentina, offered only as a labelled button when the sentence names no rate. Reduced rates have to be typed.
- **A comma separated CSV.** Excel with Argentine regional settings expects semicolons and may open the file in one column; importing it as CSV works.
- **No editing of older rows.** A row can be undone right after saving, and the most recent row can be undone from the book. Fixing an older one means exporting.
- **Days follow the device's clock and time zone.** A phone with the wrong date files rows under the wrong day.
