# grounded-assistant

A booking assistant can write a convincing reply that offers a closed day, a stylist who is off, or a price that is not on the list. This library is the code between the model and the visitor, for a fictional Buenos Aires salon. The model proposes a booking as structured output. The booking becomes a card only if it passes five checks.

1. The service is a row in the price table.
2. The day is open, not past, and at most 90 days ahead.
3. Someone who does that service works that day.
4. The whole service ends before closing.
5. The time has not gone by today. With no time stated, someone can still start today and finish before closing.

The prose is checked too. Every `$` figure must be a published price or a sum the reply itself shows, and a figure stated as a named service's price must be that service's price. The history the browser sends back is signed, so a visitor cannot write turns the model reads as its own.

I extracted it from the assistant demo on [federicomedinilla.com](https://federicomedinilla.com), where each guard below answers something a red team or a real reply broke. The handler takes a Fetch API `Request` and a `propose` function, and never sees an API key. [`apps/salon-assistant`](../apps/salon-assistant/) wires `propose` to the [gateway](../gateway/) and adds a chat page.

## Run it

From the repository root, offline:

```sh
npx vitest run grounded-assistant   # 151 tests, under a second, no key
npm run check                       # tsc --noEmit, strict
```

```ts
import { createAssistantHandler } from './grounded-assistant/src/index.ts';

const handler = createAssistantHandler({
  historySecret: process.env.ASSISTANT_HISTORY_SECRET!,   // 32 bytes or more, its own secret
  propose: async ({ schema, system, messages }) => callTheModel(schema, system, messages),
});
// POST { messages: [{ role, content, signature? }], lang?: 'en' }
//   -> { reply, signature, booking, bookingRejected?, bookingWithdrawn? }  or  { error }
```

The salon's data, the context the model reads and both prompts (Spanish and English) are in `src/salon.ts` and `src/prompt.ts`. The context is generated from the same tables the checks read, so the two cannot disagree.

## One turn

1. 405 for anything but POST, 415 for anything but JSON, 413 above 24 KiB, an optional per-client limit.
2. Every assistant turn in the history must carry a valid signature for the conversation up to that turn. A missing or wrong one is 400 `history`, before any model call. A ninth user turn is 400 `turn_limit`.
3. Each turn is cut to 600 characters and trimmed; the last one must be a user turn.
4. `propose` gets the rules and the context (one stable block), today's date and time in the salon's zone (a second block), the schema and the messages. A reply with a control character in it gets one more try.
5. Links and `www.` come out of the prose, and control characters are mended.
6. A proposed booking goes through `decide()`. A refusal replaces the prose with a sentence that names the failed check, and `bookingRejected` carries its code.
7. The money guard judges the prose. An invented figure replaces the reply with an apology and withdraws the card (`bookingWithdrawn`). A wrong price on the card's own service keeps the card and rewrites the reply as the card in words. On the English path, figures are rewritten as `$16,000`.
8. A reply that contains an email address is replaced.
9. The reply is signed together with the conversation it closes, and sent.

## Design decisions

**The model proposes, code decides.** The card is the one thing the demo promises is true, so nothing on it comes from the model. The price and duration come from the row and the stylist from the grid. A refused booking also replaces the prose, because the model wrote it to accompany a booking that is not happening. In the source, prose and card once disagreed: the sentence promised a slot that no card showed.

**An empty, ambiguous or unknown service gets its own answer.** `findService` used to answer anything. `findService('')`, `('a')` and `('de')` all returned the men's cut at $16.000, the first row whose name contained that letter, and an empty service is what a stalled model emits. Nothing under four characters (three in English) matches by inclusion now. A fragment that fits several rows ("corte" is five) asks which one. Only a name that matches no row is "not loaded", and that answer points to the salon's site.

**The whole service has to fit.** An early draft accepted 150 minutes of highlights starting when the colourist had less than that left: the model reasoned about the start and forgot the duration. `fits()` checks the start and end against the salon's hours and the person's shift. With a time, every person who could take it is checked. The source once checked only the first person in the list. It answered "the last start is 14:30" (that person's closing) while another barber worked until 18:00. It also put someone who starts at 13:00 on a 09:30 card. Without a time, a request for today keeps only the people who can still start after now and finish before closing. An earlier version approved a 180-minute balayage for today at 19:50, after the colourist's shift had ended.

**A time today is checked against the salon's clock.** Without the current time, the source offered "hoy a las 12" at 17:00. The handler computes today and now in `America/Argentina/Buenos_Aires` and gives both to the model and to `decide()`, so the two cannot disagree. Dates are parsed as UTC calendar days, because a server zone west of UTC would turn a Saturday into a Friday. A date that does not exist (`2026-02-30`) is refused instead of rolling into March.

**Reachable sums, computed and pruned.** The prompt requires a total from three services on. A guard that only knew single rows punished that. In the source, five of six two-service totals were replaced by the apology. The next version enumerated subsets and gave up past 8 rows, which killed "send me the full price list and tell me what a cut with blow-dry costs". `reachable()` builds the set of sums, one row at a time, of the rows the reply shows, pruned at the largest figure in the reply. Every price is a multiple of 1,000 over a table that adds up to 530,000, so the set has at most 531 sums. A bare total with nothing shown still dies, because the sum is trusted only when its parts are on screen.

**Rows count as often as the reply shows them.** A price counts as many times as the reply writes it, names distinct rows that cost it, or writes a quantity ("dos cortes", "three blow-dries", "x2"), whichever is more. Quantity detection skips hours ("a las once"), dates ("sábado 10", "el doce de octubre") and durations ("dos horas"), and caps at twenty. A quantity multiplies only rows the reply shows, not the whole table, so "dos" somewhere in a reply does not make 2 x $13.000 ours when no shave was mentioned.

**Reading the number, not its typography.** "$16.000,00" is sixteen thousand; the source's first reader dropped separators and read 1,600,000, which killed a true reply. `\s*` after the sign, because with one optional space "$  99.999" matched nothing and an invented price went through. A minus is read only between the sign and the digits, since "- $16.000" is a bullet. The `$0` seed of the sum set is excluded, so "te lo dejo en $0" is not ours.

**Misstated rows, judged only in price phrases.** In the source's red team the model wrote "Boy's cut (up to age 12) is $16,000" over a $12,000 card. $16,000 is a real row, so the sum check passed it. `misstatedRows()` judges "<service> is/sale/: $N" and "$N for/el <service>" and nothing looser. A corpus of replies written against a looser first version showed that judging any figure after a name reads corrections ("no sale $12.000, sale $16.000") and alternatives as contradictions.

**History signatures, v2.** The source's first fix signed each reply's text alone, with a key derived from the API key. A signed reply could then be moved after a different question, or replayed later in the same conversation, and still verify. Rotating the API key also ended every live conversation. Here each assistant turn carries an HMAC-SHA256, under a secret of its own (at least 32 bytes), over a length-prefixed SHA-256 digest of the whole conversation up to and including that turn. A reply verifies only after exactly the turns it answered, in that order. Editing an earlier user turn breaks every later signature, and the version tag is inside the signed bytes. The check runs on the text exactly as received, before any cut or trim.

**Failures carry no reply.** Every failure is `{ error }` with a status. In the source, a stray `reply` on a throttled turn was shown in the salon's voice, and the next request sent it back as something the receptionist had said.

**One structured call, no streaming.** The card has to be a guaranteed shape, not something scraped out of a sentence, and the schema puts `booking` before `reply` so the model commits to the decision before it writes the sentence.

## What the tests cover

| File | Covers |
|---|---|
| `test/decide.test.ts` | Closed days, past and impossible dates, UTC calendar days, nobody for the service that day, unknown and wrong stylists, blank names, the last start across everyone who could take it, candidates at a time, past times today including the current minute, today with no time after the last possible start, the 90-day horizon, English times, empty and ambiguous services, unloaded services |
| `test/money-guard.test.ts` | The source's cases: true prices and sums that pass, invented figures that die, each pinned known gap (a whole table makes most totals reachable; figures without `$`; a discount that lands on another real row); quantity detection with hours, dates and durations; misstated rows and the three verdicts; the sum set's bound; English rewriting; control characters |
| `test/corpus.test.ts` | 55 replies written to break the guard (30 Spanish, 25 English), each labelled from the salon's facts. 36 get the right verdict. 19 are known misses in three kinds, and each is asserted to still be wrong, so a fix shows up as a failing test until it leaves the list |
| `test/handler.test.ts` | The whole turn with a scripted `propose`: the system blocks and the clock line, cards, refusals that replace prose, the apology that withdraws a card, the card in words, links and addresses removed, the garbled-reply retry and the first reply kept when the retry is garbled too; v2 signatures across turns, forged, moved and replayed replies, edited history, short secrets; request shape, turn limit, cut and trim, model failures |

The model over the real gateway and a fake Anthropic HTTP API is tested in [`apps/salon-assistant`](../apps/salon-assistant/).

## Departures from the source

- The salon's address is `peluqueria-los-pelados.example`, and the context drops the brand and amenity lists, which no check reads.
- The corpus keeps the 55 replies written for it. The source corpus also held 9 replies the real model wrote during a red-team run; they are not published here.
- History signatures are v2 with a configured secret, as above, instead of v1 per reply with a key derived from the API key.
- Impossible calendar dates are refused, and a time must be a real 24-hour time, not any two pairs of digits.
- A request for today with no time is refused once nobody can start and finish before closing, and a date beyond the 90-day horizon is refused.
- An unknown role or a non-string content in the history is refused as a broken history instead of being filtered out.
- The model call is a function passed in, and its failures map to three codes (`busy`, `cap`, `failed`). The source called the SDK directly with its own retry and deadline.

## Limits

- The guard reads only figures with a `$`. "Te sale 25 mil" passes; the prompt is the only defence there, and in the source's real replies no amount appeared without the sign.
- With the whole table on screen, almost any multiple of 1,000 up to 530,000 is a reachable sum, so an invented total that lands on one passes.
- The 19 known misses in the corpus are real gaps. Most need the model to declare in the structured output which service each figure belongs to, which is a new model task that would have to be measured first.
- The tables are code. A real salon would load them from a store and validate them at the boundary.
- The salon has no agenda. A card is a request the salon confirms, and the prompt says so.
- A signature has no expiry. A conversation signed today still verifies next month, and any signed prefix can be continued in a new direction. Binding the digest to a session id or a timestamp would close that, at the cost of state.
