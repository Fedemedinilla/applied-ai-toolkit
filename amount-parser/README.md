# Amount parser

A deterministic parser that reads one money amount from a sentence written or dictated in Rioplatense Spanish. It has three answers: a number, no amount, or `ambiguous: true` with a reason so the app asks instead of guessing. "vendí 3 docenas a 12 mil la docena" is 36000. "vendí 5 tortas a 8000" is a question: 8000 each and 8000 for the lot are both common readings, and a native speaker cannot tell either.

No model and no runtime dependencies, and `src/` is browser-safe. Extracted from production work with its 165-phrase corpus, which is the spec.

## Run it

From the repository root:

```sh
npx vitest run amount-parser                                  # offline, about a second
echo "vendí 3 docenas a 12 mil la docena" | node amount-parser/cli.ts
node amount-parser/cli.ts "vendí 5 tortas a 8000" "gasté 30 y pico de lucas"
node amount-parser/bench.ts                                   # µs per phrase over the corpus
```

The CLI prints one JSON object per sentence, with the same keys every time (a sentence with no amount has `value`, `quantity`, `unitPrice`, `literal` and `source` set to null):

```json
{"input":"vendí 3 docenas a 12 mil la docena","value":36000,"ambiguous":false,"reason":null,
 "approximate":false,"quantity":3,"unitPrice":12000,"literal":"3 x 12 mil","source":"computed",
 "spans":[{"start":6,"end":7,"text":"3","role":"quantity"},
          {"start":18,"end":24,"text":"12 mil","role":"unit_price"}]}
```

From code:

```ts
import { parseAmount } from './amount-parser/src/index.ts';

const r = parseAmount('vendí 5 tortas a 8000');
// { value: null, ambiguous: true, reason: 'unit_or_total', spans: [...], ... }
if (r?.ambiguous) askTheUser(r.reason, r.spans);
```

`parseAmount(text, slang?)` returns `null` (no amount), or a `ParsedAmount` with `value`, `ambiguous`, `reason`, `approximate`, `quantity`, `unitPrice`, `literal`, `source` and `spans`. `slang` adds scale words and overrides built-in ones, for example `{ quina: 500, quinas: 500 }`. Each form, singular and plural, is its own key: `{ gamba: 200 }` leaves the built-in "gambas" at 100. The other exports are `parseNumber`, `normalize` and `BASE_SCALES`.

## Why this is not a model call

- **Cost.** It runs on every sentence a user types or dictates, in the browser. About 27 µs per phrase on Node 24 (`node amount-parser/bench.ts`, three runs). A model call per entry costs money and a network round trip.
- **Determinism.** The same sentence always gives the same number. A model gives a number that is right most of the time, and nobody knows which entries were the other times until the books do not add up.
- **A person can audit it.** Every result says which words it came from (`spans`) and how it was computed (`literal`: "3 x 12 mil", "80 mil - 20%"). When it is wrong, the rule that fired can be found and fixed, and the fix is checked against every phrase in the corpus.

Where a model is involved, it picks the fragment of a message that talks about money; this parser turns that fragment into a number, and a disagreement between the two goes to the user.

## The families

The corpus has 165 phrases in 15 families. The first 126 came from sweeping seven phrasing families. An adversarial review followed, in which every phrase had to be something a person would say and a second reader recomputed every expected value. Sixteen were dropped for sounding synthetic. The other 39 came from a red-team read of the parser, in eight new families. Eight of those cases are controls, sentences that already worked and had to keep working, marked CONTROL in their notes.

| Family | Cases | Example | Result |
|---|---|---|---|
| `quantity-unit-price` | 17 | compre 3 docenas de facturas a 12 mil la docena | 36000 |
| `slang-and-fuzzy-amounts` | 18 | le pague 30 lucas y pico al gasista | 30000, approximate |
| `voice-transcription` | 19 | eh gaste veinte no pera treinta mil en nafta | 30000 |
| `income-verbs` | 17 | me pagaron 3 fletes a 25 lucas | ask: `unit_or_total` |
| `noisy-numbers` | 18 | emiti la factura 1234 por 89 mil | 89000 |
| `dates-and-tense` | 20 | el jueves 12 gaste 12 lucas en insumos | 12000 |
| `multi-and-edge` | 17 | compre 3 bolsas de cemento a 9500 cada una mas 4 mil de flete | 32500 |
| `loose-scale-words` | 8 | el arreglo me salio un par de palos | 2000000 |
| `instalments-and-financing` | 8 | compre el horno en 18 cuotas fijas de 40 mil | 720000 |
| `tax-and-discounts` | 7 | el proveedor me cobro 200 mil mas el 21 de iva | ask: `tax_unclear` |
| `foreign-currency` | 5 | vendi la camioneta en 20 mil dolares | ask: `foreign_currency` |
| `comma-enumeration` | 3 | pague la luz 45 mil, el gas 12 mil | 57000 |
| `ranges` | 3 | el gasista me pidio de 80 mil a 100 mil | ask: `range` |
| `count-and-price` | 3 | me devolvieron 3 remeras de 12 mil | ask: `unit_or_total` |
| `reference-amounts` | 2 | de los 80 mil me devolvieron 20 mil | 20000 |

The ten reasons for asking are `unit_or_total`, `open_remainder` ("un palo y pico"), `range`, `discount_unclear`, `tax_unclear`, `mixed_directions` (money in and out in one sentence), `net_or_gross`, `instalments` ("6 cuotas sin interés de 25 lucas"), `several_quantities` and `foreign_currency`. The last is the one case where the reading is clear. The caller stores one fixed currency, so a figure said in dollars would be filed as that many pesos.

## The corpus is the spec

[`corpus/corpus.json`](corpus/corpus.json) holds each phrase with its family, the expected `total`, `quantity` and `unit_price`, whether it is `ambiguous`, and a note saying why that is the right answer. The 39 red-team cases also record what the earlier version of the parser returned (`earlier_parser`). Each fix can be read next to the defect it closed. For "se me fueron 30 y pico de lucas" the field says 1000, and for "18 cuotas fijas de 40 mil" it says 40000.

A change to the parser is done when every corpus phrase passes. A new rule starts as a phrase in the corpus, with its control.

**Known conflict.** Two cases contradict each other and no rule can satisfy both. "compre 2 sillas de plastico 45 mil" is marked ambiguous (45000 each or 45000 for the pair), and "10 bolsas de cemento 145 mil" is marked a total. Both have the same shape, a count and then an amount with nothing joining them. The parser reads the amount as the total, which is right far more often and avoids a question on almost every sentence. The case stays in the corpus with a `known_conflict` field instead of being deleted, and a test pins the choice.

The two source versions of the corpus did not disagree. The earlier 126 phrases are a subset of the later 165 with identical fields, and both parsers give identical output on those 126. I translated the notes to English and replaced one surname in a phrase with a generic place; the parse of that phrase is unchanged.

## Design decisions

**One function, thirteen named steps.** The source was one imperative function of about 530 lines. Here `parseAmount` in [`src/money.ts`](src/money.ts) runs named steps in a fixed order, and the first one that recognises its shape returns. The steps are listed at the top of the file. They read the sentence, drop excluded phrases, apply corrections, and look for sentence-level ambiguity. Then they classify the numbers and try, in turn, an open remainder, quantity times unit price, instalments, a count without a marker, discounts, half, sums and a single amount. The order is part of the behaviour. Swapping the instalments step with the one after it turns "4 pagos de 90 mil" (360000) into a `unit_or_total` question. A count followed by "de" and a price is exactly the shape that next step asks about.

**The refactor was checked against the source, field for field.** `test/reference-output.json` holds the full output of the source parser for 212 phrases (the corpus plus the hand-written cases), recorded before the split. The test compares every field except the new `spans`. After a deliberate change, re-record it with `UPDATE_REFERENCE=1 npx vitest run amount-parser/test/reference.test.ts` and say in the commit which phrases changed. During the refactor I also ran both versions over the 212 phrases plus 200000 random word sequences drawn from the corpus vocabulary, and found no difference. That script needed the private source, so it is not in the repository.

**Asking beats guessing.** A guess on money is wrong in a way the user may not notice until the month closes, while a question costs the user a few seconds. So a per-unit price with a count the parser could not read returns `unit_or_total` instead of assuming one item. A discount it cannot apply returns `discount_unclear` instead of the gross. "me hicieron un 10 de descuento sobre 45 mil" used to store 45000.

**Rules are written against literal words, and that is the failure to watch.** "cuotas" near "de", "menos" next to "descuento", "mas" before "iva", "entre" for a range, "y" to add up. In the earlier version, an adjective switched a rule off ("18 cuotas fijas de 40 mil"). So did a synonym ("4 pagos de 90 mil"), a comma instead of "y", or the other preposition ("de 80 mil a 100 mil"). The parser then returned a wrong number without asking. The 39 later corpus cases are those sentences and their controls. The fixes widen the shape a rule accepts. Each control proves the widening did not swallow the sentence next door, such as "pague la tele 300 mil en 3 cuotas", which must stay 300000 and not become 900000.

**Commas are spelled out as "y".** A voice transcription writes a comma where a person lists what they paid, and the summing rule reads "y". Turning the comma into " y " before tokenizing, rather than adding a token, keeps every rule that reads the next or previous word unchanged. A comma between two digits stays a decimal separator.

**No regex lookbehind.** Safari before 16.4 rejects a lookbehind when it parses the file, and then no line of the module runs. The comma rule is written with a consuming group instead, and `test/package.test.ts` fails if a lookbehind appears anywhere in `src/`.

**Spans are mapped, not re-derived.** `normalize` drops accents, lowercases and collapses spaces, and the comma step inserts characters, so positions in the prepared sentence differ from the input. `buildOffsetMap` rebuilds both transformations one input code point at a time, keeps the input offsets of each output character, and checks that it produced exactly the same string. Searching the input for the figure would point at the wrong "3" in "el 3 de mayo compré 3 kilos a 2 mil el kilo". An accent or a spelled-out comma would also shift every offset after it. If the map cannot be rebuilt exactly, the parse still runs and the spans come back empty rather than pointing at the wrong words.

## What the tests cover

| File | Covers |
|---|---|
| `test/corpus.test.ts` | Every corpus phrase, grouped by family, with the source's acceptance rule, plus quantity and unit price whenever the parser multiplies; the known conflict; a per-family score |
| `test/regressions.test.ts` | The 39 hand-written cases from the source's test table (identical in both versions), grouped by the audit that found them, each checked as a number, a question or no amount; and the 14 red-team phrases with what the earlier copy returned |
| `test/reference.test.ts` | Output identical to the source parser on 212 phrases, field for field |
| `test/properties.test.ts` | fast-check: an integer formatted the Argentine way (`1.234.567`, `1.234,56`) parses back to itself; integers up to 999999 spelled out in words parse back; "mil" after a figure multiplies it by a thousand; "y pico" never returns an exact value; `normalize` is idempotent; arbitrary Unicode never throws; capitals and extra spaces do not change the result |
| `test/numbers.test.ts` | `parseNumber` on separators, including the dot as a decimal point ("1.5", "250000.00") |
| `test/spans.test.ts` | Roles and offsets for each kind of result, and that every span is a slice of the input |
| `test/limits.test.ts` | The known limits below, pinned as they behave today |
| `test/package.test.ts` | The CLI on stdin and arguments, with one set of keys for every answer; `src/` imports only its own files (static, side-effect and dynamic imports), uses no Node API and no regex lookbehind, for Safari before 16.4 |

480 tests, all offline.

## Limits

- **`CORRECTION_MARKERS` includes "no" and "para".** They are there for spoken self-corrections ("gasté veinte, no, pará, treinta mil"), and both are also ordinary words. When one of them sits between two figures, everything before it is dropped. "gaste 5 mil para la fiesta y 3 mil de envio" returns 3000 instead of 8000, and "pague 20 mil de luz y no 30 mil" returns 30000. Removing them would break the dictated corrections in the corpus, so the fix needs corpus cases for both readings first. `test/limits.test.ts` pins the current behaviour.
- Idioms are matched as substrings. "dos pesos" means next to nothing, so "pague doscientos dos pesos" returns no amount.
- A zero passes as a value ("gaste 0 pesos" returns 0), and a minus sign is dropped. Callers that store amounts should reject values that are not positive.
- Fullwidth digits are not read as digits. "gaste ２０ mil" skips the "２０" and returns 1000 for the bare "mil". Folding them with NFKC in `normalize` would fix it, as a deliberate change with corpus cases.
- "x" is not read as multiplication: "pague 2 mil x 3" returns 2000.
- "4 cuotas a 90 mil" returns 90000 (one instalment), while "4 pagos a 90 mil" asks `unit_or_total`. The instalments step needs "de" after the count, and the next step skips only the literal "cuota(s)". The source behaves the same way, and changing it needs corpus cases for both nouns.
- "1e5" splits into 1 and 5 joined by "e", which is also a conjunction, and returns 6. Scientific notation is not something people type into an expense note, but the parser does not reject it.
- One amount per sentence. Two movements ("pague 5 mil de luz y 3 mil de gas") come back as their sum, and money in and out together is refused as `mixed_directions`, not split.
- The vocabulary is Rioplatense Spanish only. Other Spanish varieties use other slang and, in some countries, the opposite separators.
- Currencies with an ordinary homograph ("reales", "libras") are not detected, on purpose. A false alarm on "el precio real" would cost more than it saves.
- The corpus is 165 phrases. It covers the shapes that came up in use and the ones found by reading the parser for weak spots. A phrasing outside them can still switch a rule off.
