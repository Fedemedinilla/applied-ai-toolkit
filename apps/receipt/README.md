# Receipt

A page with an editable order that renders its delivery note as a PDF in the browser, built on [`pdf-receipt`](../../pdf-receipt/). There is no server. The PDF is built in the tab and offered through a normal download link, so the order never leaves the device. It makes the same `buildReceipt` call a serverless function would, which works because the library uses no Node APIs. The interface is in Spanish, and the shop is a fictional plant nursery.

Live demo: <https://fedemedinilla.github.io/applied-ai-toolkit/receipt/>

## The flow

1. The page opens with a sample order already built. The status line reads "Listo: remito-R-0042.pdf, 1 página, 4,1 kB." and Descargar saves that file.
2. Any edit removes the link and schedules a rebuild 400 ms after the last keystroke. When it lands, the link points at the new PDF.
3. A field the PDF cannot print truthfully, such as a price typed as "6800.50", gets its message under it ("Los centavos van con coma: 8.000,50."). No PDF is offered until it is fixed. Generar PDF focuses the first such field.
4. When the library changed text to fit the fonts or the page, "Qué cambió para que entre en el PDF" lists each change, in Spanish, as a link that focuses the field it came from.

Three buttons load sample orders: a simple one, one with emoji, CJK, right-to-left, zero-width and endless names ("Textos difíciles"), and one with 120 products. On wide screens the PDF shows in a frame next to the form. On narrow ones it does not, because mobile browsers do not render a PDF inside a frame; Abrir and Descargar cover them.

## Run it

From the repository root, offline:

```sh
npm ci
npx vitest run apps/receipt                              # offline, includes a production build
npx vite build --config apps/receipt/vite.config.ts      # writes dist/apps/receipt
npx vite preview --config apps/receipt/vite.config.ts    # serves the build at http://localhost:4173
npx vite --config apps/receipt/vite.config.ts            # dev server with reload
node csp-build-guard/cli.ts --dir dist/apps/receipt --config apps/receipt/csp-guard.config.json
node apps/receipt/scripts/logo.ts                        # redraws public/logo-ejemplo.png
```

The output uses relative URLs only (`base: './'`), so it works at a domain root or under a subpath such as GitHub Pages.

The build (Vite 8.3.4) writes 449.32 kB of JavaScript, 186.94 kB gzipped, and 4.28 kB of CSS. Nearly all of the script is pdf-lib, which the page needs on load to build the first PDF. [`csp-guard.config.json`](csp-guard.config.json) holds the policy a host should send. It allows `'self'` for scripts, styles and the logo fetch, `data:` images, `blob:` frames for the preview and no plugins. The guard checks that the build runs under it with no inline script, has no regex lookbehind, and stays under 200 kB gzipped and 190 kB brotli. Its own measure of the current build is 186.0 kB gzipped and 170.2 kB brotli.

## Design decisions

**A download never carries an order the form no longer shows.** Each edit removes the `href` of Descargar and Abrir until the rebuild lands. An anchor with no `href` is not focusable and cannot be clicked. The anchors carry `role="link"` so that their `aria-disabled` is honoured, and a visually hidden "(se está actualizando)" joins their accessible name while they wait. Each build has a sequence number, and a result for an older build is dropped, so a slow build cannot replace a newer one. The previous blob URL is revoked when the new one is in place.

**A normal link, not a script download.** Descargar is an `<a href="blob:..." download="remito-R-0042.pdf">`. It works with a middle click, a long press or "Save link as", and screen readers announce it as a link. The file name keeps only letters, digits and dashes from the document number after removing accents, so "R 0099 ★ Ñandú" becomes `remito-R-0099-Nandu.pdf`.

**Amounts are read strictly, in the format the PDF prints.** [`src/fields.ts`](src/fields.ts) accepts `8000`, `8.000`, `8.000,50` and `$ 8.000`. A dot counts only in well-formed groups of three, so "8.5" is refused rather than read as 85 or as 8.50, since a value with two readings is not guessed. Quantities take a comma and up to three decimals, the limit the library enforces. The minus sign is accepted only for the previous balance, where it means a credit. Each field is converted to integer cents and handed to the library, and the row subtotal next to each product is computed by the library's own `lineTotalCents` and `formatCents`.

**Errors and warnings point at their field.** Form errors are paragraphs placed after the control, joined to it with `aria-describedby` next to its hint, and the control gets `aria-invalid`. The library's warnings name a path such as `items[3].name`. [`src/messages.ts`](src/messages.ts) turns that into "Producto 4, nombre" and the id of that row's input. Rows keep their id when others are removed, and blank rows are left out of the data, so the index the library reports is not the row number on screen. Each item carries its row id for the link and its position in the list for the name. A notice then says "Producto 2" when the row's legend does, even if row 1 is blank. When the logo notice's target, the file input, is hidden, its link focuses the logo option in use instead.

**The logo is bytes, as on a server.** The page fetches the sample logo (`./logo-ejemplo.png`) once and passes it to the library as a `Uint8Array`. An uploaded file is read with `File.arrayBuffer()` and never leaves the tab. A file that is not a PNG or JPEG builds a PDF with the shop name and a notice saying so. If the sample logo cannot be fetched, the PDF is built without it.

**A keyboard or screen-reader user can fill in an order and reach every error.** Each control has a label, item rows and the logo choice are fieldsets with a legend, and the remove buttons say which product they remove. Adding a row focuses its first input, and removing one focuses the next row. Field outlines use their own colour token, with a contrast of 3.8:1 or more against both backgrounds in light mode and 4.6:1 or more in dark mode. WCAG 1.4.11 asks for 3:1. The card outlines stay lighter. Focus is always visible, errors differ by text and a thicker side border as well as colour, light and dark follow `prefers-color-scheme`, and the layout holds at 360 px.

**The live region speaks on changes, not on every keystroke.** The visible status line follows every rebuild, but it is not a live region. A separate visually hidden `role="status"` element is written only when an error appears or changes, when the order becomes valid again, or when the page count changes. Before this, every 400 ms pause in typing made a screen reader read the whole ready sentence (file name, page count and size) again.

**No timer outlives its page.** `mountApp` returns `destroy()`, which cancels a scheduled rebuild, drops one in flight and revokes the current blob URL, and the app looks its inputs up inside its own form. Without that, a rebuild scheduled by one mount fired into the next mount's document in the DOM tests and failed with an unhandled rejection. A failure inside a build, or a logo file that cannot be read, ends with a message in the status line instead of an unhandled rejection and a status stuck on "Actualizando el PDF…".

## What the tests cover

| File | Covers |
|---|---|
| `test/fields.test.ts` | Accepted money formats; blank as null; "8.5", "8000.50", "8 mil", "1e4" and malformed groups refused with their messages; the minus sign by field; the maximum; round trip through the field format; quantity rules |
| `test/draft.test.ts` | The simple sample in cents and lines; blank rows skipped with their row ids and positions kept; a warning named after the row on screen when an earlier row is blank; each error on its own control; every sample builds; warnings and paths in Spanish; file names |
| `test/app.dom.test.ts` | jsdom against the real `index.html`: the first build and its link, frame and status; row subtotals; the link removed while an edit is pending and the old URL revoked; an error next to its field, focused on submit and cleared when fixed; the hostile sample's notices and the link that focuses the field; 120 products over several pages; adding and removing rows with focus and renumbering; the notice for row 2 when row 1 is cleared; the live region silent across a valid rebuild and speaking on an error and its fix; the pending text in the links' names; `destroy()` cancelling a scheduled rebuild; no logo, and an uploaded file that is not an image; a logo notice linking to the checked option when the file input is hidden; an uploaded file that cannot be read; a sample logo that cannot be fetched |
| `test/build.test.ts` | Runs the production build into a temp folder: one script, one stylesheet, the logo, relative URLs only, no inline script and no `eval` |

53 tests, all offline; `npx vitest run apps/receipt` exits 0 with no unhandled errors. The DOM tests inject `createUrl` and `revokeUrl`, because jsdom has no `URL.createObjectURL`, and read the PDF behind the link back with pdf-lib. Every mounted app is destroyed in an `afterEach`.

Not automated: I served an earlier build with the CSP as a header and drove it in headless Chromium through Playwright, at 1280 px in light mode and 360 px in dark mode. In both there were no console errors and no horizontal scroll, the hostile sample listed its notices, and Descargar saved a file starting with `%PDF-1.7`. That script is not in the repository, so the run cannot be repeated from here.

## Limits

- **The preview frame depends on the browser.** Desktop browsers render a PDF in a frame; mobile browsers do not, so the frame is hidden below 700 px. Whether a given browser's viewer runs under `object-src 'none'` was not checked in a headed browser.
- **186 kB gzipped of script on load.** pdf-lib is not split out, because the page builds a PDF as soon as it opens.
- **The library's limits apply.** Only the WinAnsi repertoire is printed, with no tax or discount lines; see the [pdf-receipt README](../../pdf-receipt/README.md#limits).
- **Nothing is saved.** Reloading the page brings back the sample order.
- **Amounts in one format.** The fields expect a dot for thousands and a comma for cents. A user who writes "8,000.50" gets an error, not a conversion.
