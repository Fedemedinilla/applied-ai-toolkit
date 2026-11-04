# PDF receipt

A TypeScript library that turns an order into a delivery-note PDF with [pdf-lib](https://github.com/Hopding/pdf-lib) alone, in a serverless function or a browser tab. I extracted it from a production order app. There, four inputs had each broken the document: an emoji in a customer name, a long note, an order longer than one page, and an amount with cents. Each is now a test. The client's address, logo, palette and business rules were removed; the fixtures are a fictional plant nursery.

## Run it

From the repository root:

```sh
npm ci
npx vitest run pdf-receipt                                    # offline, about 4 seconds
node pdf-receipt/examples/write-sample.ts /tmp/remito.pdf     # one sample PDF
node pdf-receipt/examples/write-sample.ts /tmp/long.pdf 120   # the same with 120 lines, 6 pages
```

The sample includes an emoji on purpose, so it prints one `characters_dropped` warning per affected line (one for the first command, 30 for the second). Node 24 runs the TypeScript sources directly. There is no build step and no API key; nothing here calls a network.

From code:

```ts
import { buildReceiptPdf } from './pdf-receipt/src/index.ts';

const bytes = await buildReceiptPdf(
  {
    number: 'R-0042',
    issuedOn: '2026-11-04',
    shop: { name: 'Vivero Ejemplo', lines: ['ventas@vivero.example'] },
    customer: { name: 'Jardín de Prueba' },
    items: [{ name: 'Maceta de barro', detail: 'x6', quantity: 3, unitPriceCents: 900_000 }],
    shippingCents: 800_050,
    previousBalanceCents: -300_000,
    notes: 'Entregar por el portón lateral.',
  },
  { logo: LOGO_PNG_BYTES, onWarning: (w) => console.warn(w) },
);
// bytes is a Uint8Array: write it to disk, return it from a handler, or wrap it in a Blob.
```

`buildReceipt(data, options)` returns `{ bytes, pageCount, warnings }` for callers that want to show them. Options: `logo` (PNG or JPEG bytes), `labels` (any subset; `LABELS_ES` is the default and `LABELS_EN` is included), `locale` (a BCP 47 tag, default `es-AR`), `currencySymbol` (default `$`), `pageSize` (`A4` or `Letter`), `accentColor` (`#rrggbb`), `maxNameLines` (1 to 20, default 3) and `onWarning`.

## Design decisions

### Text

**Every string is made WinAnsi before it is measured or drawn.** The standard PDF fonts encode text as WinAnsi (Windows code page 1252), and pdf-lib throws `WinAnsi cannot encode` on any other character. In the source app, one emoji in a customer name meant the order's PDF was never produced. [`src/winansi.ts`](src/winansi.ts) applies NFC first, because some phone keyboards send "é" as "e" plus a combining accent. It keeps the 217 characters the fonts can draw and maps exact stand-ins (the minus sign U+2212, non-breaking hyphens, thin and narrow spaces). It then tries NFKC ("ＡＢＣ" to "ABC", "ﬁ" to "fi") and the base letter without its marks ("ő" to "o", "ș" to "s") before dropping a character. A fast-check property feeds 500 random strings over all of Unicode, lone surrogates included, and checks that both fonts encode every result.

**Removed text is reported, and a field never goes silently blank.** Dropped visible characters raise a `characters_dropped` warning with the field path (`items[3].name`) and the count. Zero-width joiners, bidi overrides and variation selectors are dropped without a warning, because nothing visible was lost. A field that had text and lost all of it, such as a name made only of emoji, prints "(texto no imprimible)" instead of an empty cell. A reader of the paper can then tell that the line had a name. Bidi controls are removed rather than applied: U+202E (right-to-left override) would make a viewer that honours it display the following letters backwards, and pdf-lib does no bidi reordering anyway.

**Wrapping never loses a word.** In the source, notes were cut to one line, and an allergy note could fall off the paper. Notes now wrap, and a word wider than the line (a tracking URL, a 10,000-character token) is broken where it stops fitting. Product names wrap to `maxNameLines` lines and the last one is clipped with an ellipsis and a `text_clipped` warning, so one name cannot fill a page.

**Measuring is bounded.** The source clipped by removing one character at a time and measuring the whole string each time, which is quadratic. Clipping and breaking here use a binary search, capped at `maxWidth / (0.1 em)` characters. A test checks the bound against all 217 glyphs of both faces: no Helvetica glyph is narrower than 0.1 em. Tests count the measurements instead of timing them. Clipping a 10,000-character word to 200 pt takes at most 10 calls, and each call after the first measures 202 characters or fewer.

### Amounts

**Integer cents end to end.** Prices are integer cents. A line total is quantity times unit price computed in BigInt with the quantity in thousandths, rounded half up once, so `1.005 x 999.99` is exact before rounding. Formatting prints the cents from the integer. Whole amounts show no decimals (`$8.000`) and any amount with cents shows two (`$8.000,50`). The source once printed `$8.000,5`.

**A number that is not a valid amount throws.** NaN, a float of cents, a negative price, a quantity with four decimals and an impossible date throw `ReceiptInputError` with a `code` and the `field`. The message names the field and never includes its text. In the source, an unreadable stored amount was treated as "not entered", so its line disappeared from the paper with no trace. Text is the opposite case. It is never rejected, only cleaned and reported.

**Amounts shrink before they overlap their label.** Totals are right-aligned, and their labels end at a fixed column. In the source, `$148.000,50` at 15 pt was 83 pt wide in a 77 pt gap and ran over "TOTAL FINAL", while `$148.000,5` fit. [`fitSize`](src/text.ts) measures once and scales the size so the amount is exactly as wide as its zone, because glyph widths scale linearly. An amount that fits keeps its size, so whole totals up to `$1.234.567` come out at 15 pt as before. The same rule applies to the quantity, unit price and subtotal columns, and a test puts `$99.999.999.999,99` in each one.

**Digits are Latin whatever the locale.** `ar-EG` and `fa-IR` format numbers with Arabic-Indic digits by default, which WinAnsi cannot encode. Before this rule the sanitizer dropped them with no warning, and a unit price of `$1.500,50` was drawn as `$50` and every total as `$`. Every formatter now asks for `numberingSystem: 'latn'`, and a formatted amount, quantity or date that would still lose a character throws `ReceiptInputError` with the field `locale` instead of printing a shorter number. A malformed locale tag throws the same error rather than a bare `RangeError` from `Intl`.

### Totals

**The previous balance is printed under the totals and never added.** Printed above the total, anyone reading the paper assumes it was summed. It goes below with "(no incluido en el total)". A negative balance is a credit: "Saldo a favor $3.000" instead of `$-3.000` next to "Saldo anterior", which reads two ways.

**Shipping of zero is information, not a total.** `null` prints no shipping line. `0` prints "Envío $0", meaning free shipping, but no grand total, which would repeat the same number twice in a row. Above zero, the items total loses the large accent style and "TOTAL FINAL" takes it, so the page shows one number to pay.

**Only the extras that are drawn get room.** The source reserved a fixed 76 pt for the totals block, which pushed a long order with no extras onto a new page to print an empty block. The reservation is now the sum of the lines that will be drawn, and a test checks that an order with shipping and a balance breaks to page 2 at fewer rows than one without.

### Pages

**Layout.** One cursor, `y`, holds the baseline of the next line. Before each row, totals block or notes box, `ensure(height)` checks that it fits above the footer zone (100 pt from the bottom) and opens a continuation page if not. Before pagination, rows in the source ran over the footer from about 22 items on. Continuation pages repeat a short header ("REMITO R-0042 · continuación") and, inside the item table, the column heads. Footers are drawn after the layout, on every page, because "Página 2 de 5" needs the page count. In one-line fields (names, details, party lines) a pasted line break becomes " · ", so "Pasaje 12\nTimbre B" still reads as two parts; notes keep their paragraphs.

**Notes continue across pages.** The source drew the notes in one box, so a note taller than the room left on a fresh page ran off the bottom. Notes are now split into as many boxes as they need, each continuation headed "Aclaraciones (continuación)".

### The document

**The logo travels as bytes.** A serverless function has no `public/` folder to read a file from, so the caller passes PNG or JPEG bytes, typically a base64 constant in the bundle. The format is detected from the file signature, not from a name or a type the caller could get wrong. A logo that is not an image, or a PNG that fails to decode, prints the shop name instead with a `logo_unreadable` warning, because a broken brand asset must not take an order's document down.

**Dates come from the data, not the clock.** `issuedOn` and `deliveryOn` are calendar dates (`YYYY-MM-DD`) formatted in UTC from their parts. The source formatted timestamps with the server's UTC day. An order confirmed at 22:00 local time was then dated the next day. pdf-lib also stamps the creation and modification dates with the clock. Here they are set from `issuedOn`, so a test builds the same order twice, a second apart, and gets the same bytes. A stored PDF can then be rebuilt and checked against its data.

**No Node APIs.** The library imports only pdf-lib, so the same entry builds a PDF in a browser tab ([`apps/receipt`](../apps/receipt/)). A jsdom test builds one and wraps it in a `Blob`.

## Departures from the source

- The source had two variants, a customer copy and an internal preparation sheet with checkboxes. Only the customer copy is here.
- The source printed a percentage discount line. It is not here, because how a discount rounds was a rule of that one business.
- Product names wrapped to one line in the source and wrap to three here. Long words are broken instead of clipped.
- Notes continue across pages, footers carry the page count, and metadata dates come from the issue date. The source had none of the three.
- Warnings, the placeholder for unprintable fields, the NFKC and mark-stripping fallbacks, and strict number validation are new.

## What the tests cover

| File | Covers |
|---|---|
| `test/winansi.test.ts` | Latin-1 and CP1252 kept; NFD composed; emoji with skin tones and ZWJ families counted; CJK, Arabic and Hebrew dropped; bidi overrides and zero-width characters removed silently; stand-ins, NFKC and mark stripping; line breaks; control characters, lone surrogates and the soft hyphen; a fast-check property over all of Unicode against both fonts; all 217 characters encode |
| `test/text.test.ts` | The 0.1 em bound over every glyph; clipping with an ellipsis and none to spare; the number and length of measurements for a 10,000-character word and for 10,000 characters of prose; wrapping between words, breaking long words, clipping the last line; progress when nothing fits; `fitSize` exact at the zone width |
| `test/money.test.ts` | Whole and cent amounts, the sign, the largest amount exact, another locale, Latin digits for `ar-EG` and `fa-IR`; BigInt line totals with half-up rounding; quantities; calendar dates with no zone shift |
| `test/input.test.ts` | NaN, floats, strings, negatives and out-of-range values refused with the field path; quantity rules; impossible dates; bad options, a malformed locale tag included; `items` that is not an array; a running total that passes the maximum; a label override that is not a string; no field text in error messages; warnings per field; the unprintable placeholder; party lines beyond four |
| `test/receipt.test.ts` | Every amount drawn, in order, with whole and cent values; credit balance below the totals; shipping 0 and absent extras; the adaptive size against the label edge and at the largest values; emoji, CJK, RTL, zero-width and combining text in every field; 10,000-character names in three lines; 500 lines in 20 pages; a fast-check property over every text field; PNG logo from `Uint8Array` and `ArrayBuffer`, bad bytes and a broken PNG; identical bytes a second apart; English labels, `en-US` and Letter size; every amount and date drawn with Latin digits under `ar-EG` and `fa-IR`; `buildReceipt` |
| `test/pagination.test.ts` | The row count at which the totals move to page 2 alone, with no table head there; the row count at which a row moves under a repeated head; room reserved only for drawn extras; equal rows on full continuation pages; wrapped names as taller rows; notes over several pages in order; every text above the footer zone and inside the margins, the footer and page count on every page; the tallest allowed rows |
| `test/browser.dom.test.ts` | A build under jsdom, wrapped in a `Blob` |

89 tests, all offline. The assertions on what reached the paper intercept `PDFPage.prototype.drawText`, the way the source's regression script did ([`test/helpers/record.ts`](test/helpers/record.ts)). Each call records the text, position, size, font and measured width, and pages are numbered in the order they first receive text. The expected strings are written out in full.

The timings below are the median of five runs on Node 24 in this environment, after a warm-up. A 3-line order builds in about 5 ms (1,915 bytes). A 500-line order takes about 142 ms (20 pages, 70,481 bytes).

## Layout

```
src/
  index.ts      public exports
  receipt.ts    buildReceiptPdf, buildReceipt, the page layout
  input.ts      data types, validation, ReceiptInputError, warnings, preparation
  winansi.ts    the WinAnsi sanitizer
  text.ts       clip, wrap, fitSize
  money.ts      cents formatting, line totals, calendar dates
  labels.ts     LABELS_ES and LABELS_EN
examples/
  write-sample.ts
test/           Vitest suites; helpers/ has the drawText recorder, a PNG encoder and fixtures
```

## Limits

- **Only the WinAnsi repertoire is drawn.** Greek, Cyrillic, CJK, Arabic, Hebrew and letters with no decomposition such as Polish "ł" are removed ("Łódź" prints "ódz"). Drawing them needs an embedded TrueType font through `@pdf-lib/fontkit` and a font file in the bundle, which this library does not do.
- **No text shaping or bidi.** Right-to-left text would need both a font and a reordering step.
- **Not a tax document.** There are no tax lines, discount lines or legal fields.
- **No PDF tagging.** The output has no structure tags for screen readers (PDF/UA); text can be extracted but not navigated by headings or table cells.
- **One-line party fields.** Shop and customer lines are clipped to one line each, and only the first four are drawn.
- **Fixed layout.** Columns, sizes and margins are constants in `receipt.ts`. Labels, locale, page size and the accent colour are options; the rest needs an edit.
