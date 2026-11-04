# Case study: a writer that invented facts to fill space

The tools in this folder are a generic version of scripts I wrote for the AI demos on federicomedinilla.com. This is the record of what they found and how the fix was measured. The numbers are copied from my project notes for that work (October 2026). The demo businesses were fictional, and they are renamed here as well; the two that come up below are "the school" and "the bakery". The production defects described here were in my own demo pages, not in any client's system.

## The product

One of the demos is an in-house writer for a small business. The visitor picks a business and a piece type (notice, quick reply, news update, email) and writes a one-line brief. The model writes the piece in that business's voice, using only that business's loaded context: hours, prices, names, channels. The page's claim is that it does not make things up.

## What went wrong

Testing the new English version against the real model showed that the writer padded short briefs with procedures nobody had loaded. It wrote "the school office is closed that day" and "ask the counter to hold them for you". To "do you have gluten-free bread?" it answered "we don't do gluten-free", 6 times out of 6. It happened in both languages, and in Spanish it had been in production since August.

Three things kept it hidden:

- The inventions were plausible. A school closed on a staff day or a bakery without gluten-free bread reads like a fact, and a reader without the fact sheet next to the piece has nothing to compare it with.
- It happened sometimes, in some briefs one run in two, so a review of one run per brief saw it or not depending on luck.
- The English version had been checked with a simulated model (agents reading the prompt and predicting the output). The simulated model passed pieces the real model failed, because it did not pad the way the real one does. The probable cause was even written in a code comment ("the word floor pushes it to pad"), and nobody had measured it.

## Measure before changing anything

Before editing the prompt I built the eval runner this folder generalizes. It builds the same prompt the endpoint sends, applies a variant as a checked exact-text replacement, and calls the API with the endpoint's own settings. An agent that did not know which variant it was reading judged each piece against the business's fact sheet, line by line.

The variants:

- **V1**: no word floor ("Up to N words" instead of "From N to M words").
- **V2**: a procedure, a yes or no about what the business has, and the consequences for something already arranged are facts; the examples inside the tone lines are not.
- **V3**: V1 and V2 together.
- **V4**: V3, plus: when the business does not know something it still talks as itself and hands the question to a loaded channel, and a callback time is a fact.

| round | what | pieces with something invented |
|---|---|---|
| 1 | 10 prone situations (4 example briefs and 6 questions about things not loaded), 3 samples, 2 languages | current **60%**, no floor 50%, fact rules 30%, both 28% (but 23% sounded like a bot: "I can't confirm that here") |
| 2 | the same, with two new lines in the school's context and a clearer brief | current **47%**, V3 15%, **V4 3%** (robotic 2%) |
| 3 | the 16 example briefs, 2 samples, 2 languages | Spanish 25% to **6%**, English 16% to 13%; quality 3.8 to 4.2 of 5; V4 voices still told apart **24/24 per language** |

Round 1 was 240 pieces and round 2 was 180. Round 1 also shows the cost of fixing only the rules. V3 brought invention down, but almost one piece in four answered unknowns in the voice of a system talking about its data. V4 fixed that without giving back the invention rate. The "24/24" is a blind voice test. The four businesses answered the same briefs, the pieces were shuffled without labels, and two independent readers had to say which business wrote each one, against a 25% chance baseline. With the same brief for all four, the content could not give the answer away.

V4 shipped. A `--dump` of the prompts confirmed that the new production prompt was byte for byte the variant that was measured. The whole experiment cost about 5 dollars of API calls.

Two things are still open. The writer sometimes picks a closing hour when the brief says "earlier" without one, and the English school-vacancies email sometimes adds a rule about siblings.

## The word floor

The floor was a hypothesis about the model that nobody had tested. A brief with twenty words of content and a 35-word floor is an order to pad, and the padding is where the inventions went. On the school email, removing the floor took invented pieces from 5 in 6 to 0 in 6. The average length barely moved (55 to 53 words), so the floors were not what kept the pieces full; the briefs and the context did.

## Sometimes the fix is the fixture

Round 2 changed the school's fixture as well as the prompt: two loaded lines (the office is open on staff days; workshop sign-ups go through the communication notebook) and a clearer brief ("starts *this* Wednesday"). The gardening-workshop brief went from 6 of 6 invented to 2 of 6 without touching the prompt. A brief that cannot be answered without inventing measures the fixture, not the model.

## The same harness, later

Four days later the same runner tested two ways to keep sentences under each voice's length ceiling. A general rule ("the upper number is a ceiling, split what goes over") made things worse. Pieces with a long sentence went from 47% to 56% in Spanish and from 72% to 81% in English. Restating the ceiling inside each voice's own line, with its number, brought the share of long sentences from 12% to 8% (Spanish) and 21% to 14% (English), with length per piece unchanged. That version shipped. A plausible general rule lost to a specific one, and only the measurement said so.

## The chat assistant: forged history and small samples

The red-team runner here comes from the same project, from the chat assistant demo (a booking assistant for a fictional hair salon).

- **Forged history.** The route accepted `role: "assistant"` turns sent by the browser, so a visitor could write lines the model would read as its own. Two tests against the real model held, but they held by the model's behaviour. The fix went into code. Each reply leaves with an HMAC of its exact text, and an assistant turn without a valid signature is refused with a 400 before the model is called. `example/chat.ts` does the same.
- **The run.** Agents wrote 41 attacks. Each was replayed turn by turn against the real route and the real model with the signed history, then judged blind by three judges and two skeptics who tried to refute each failure. The first run gave 10 confirmed failures (one high) and 3 turns cut by timeouts. The final run, 57 attacks and 164 turns, had no errors, no cut turns, a p90 of 6.5 s, and no money failure or high-severity failure. It left 10 prose failures, 5 of medium severity. Half were one class, turning "not loaded" into an asserted "no". A new prompt line for that class was measured on the six conversations where it appeared, run twice. It brought the class from 5 of 6 conversations with a failure to 2 of 12 runs.
- **A "cosmetic" defect that was a rate.** A tab character in place of an accented letter looked like a one-off. Counted over its population it was 3 of 48 English replies, and 3 of the 16 that carried an accent or a dash (19%).
- **Zero out of fourteen is not "fixed".** A change to how a fixture wrote an age measured 4 of 14 errors against 0 of 14 and shipped as a fix. Production stumbled anyway. A larger comparison on the message where the error really appeared gave 7 of 10 against 3 of 10. The change halves the error but does not remove it. With a true rate of 25%, zero in fourteen comes up about once in fifty runs. That is why `aggregate.ts` prints a confidence interval next to every rate.

## Lessons

1. A prompt rule is a hypothesis about the model, and the only test of it is the model. A simulated model passed what the real model failed.
2. "Does not invent" is measured with the real model, several runs per brief, with briefs that ask about something not loaded, and each piece judged line by line against the fact sheet by a judge that does not know the variant.
3. When a brief cannot be answered without inventing, fix the fixture, not the prompt.
4. A rule that fixes one failure can create another (V3's robotic answers). Measure what the fix might break, not only what it targets.
5. Small samples need intervals. Write the rate on each side, not "it's gone".
6. What code can guarantee should not be left to the model. Forged history is refused by a signature check, not by the model's judgement.
