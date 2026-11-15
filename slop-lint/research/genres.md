# Research by genre

slop-lint was built for cover letters. Its design for the next version adds three genres (`email`, `follow-up` and `whatsapp`), and a rule enters a genre only with a source. This note gathers the evidence for each genre as of 15 November 2026: what is already sourced, what was checked for this note, and what still has no source and waits.

Each claim carries an evidence tag of the report, written as code so the linter does not read it as a placeholder. The tags are MEDIDO (measured, primary source), NORMA (normative reference or official documentation), REPORTADO (reported by a secondary source), CONSENSO (agreement across sources) and SÍNTESIS (our own synthesis). Where there is no source, the entry says so. The phrases quoted as examples are the patterns the rules look for, so they sit between `slop-lint-disable` and `slop-lint-enable` directives and the docs lint does not report them.

## Sources

- **The report.** The curated deep-research report behind the 52 rules (see [PROMPT.md](PROMPT.md)). It is not in this repository. Entries cite it by section and item.
- **WhatsApp Help Center**, "How to format your messages", https://faq.whatsapp.com/539178204879377, read on 15 November 2026 `[NORMA]`.
- **Wikipedia**, "Wikipedia:Signs of AI writing", sections "Collaborative communication" and "Phrasal templates and placeholder text", https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing, read on 15 November 2026. The page publishes no method, so it counts as `[REPORTADO]`, as the report already treats it.

## Signs of generated text by genre

### Email

<!-- slop-lint-disable -->
- **Opening formula.** Wikipedia quotes "I hope this message finds you well. I am writing to request..." as a phrasal template of generated messages `[REPORTADO]`. The report lists "I am writing to express" as English Tier 1 (section 12).
- **Closing formula.** The report lists "thank you for your time and consideration" as Tier 1 only when it is the sole closing line (section 12). Wikipedia quotes "Thank you for your understanding and assistance in this matter" as a template closing `[REPORTADO]`.
- **Chatbot leftovers.** Wikipedia lists "I hope this helps", "Of course!", "Certainly!", "Would you like..." and "let me know" as words to watch in text addressed to the user `[REPORTADO]`. In an email, "let me know" is ordinary, so it is not a candidate rule.
- **Placeholders.** Wikipedia quotes "Best regards, [Your Name]" and "[Your Email Address]" as unfilled placeholders `[REPORTADO]`. slop-lint's FMT-04 already catches bracketed placeholders.
- **Spanish.** The report names "Estimado/a" with a slash as a sign of generated Spanish (section 11, item 3), and "me encantaría tener la oportunidad de" as a calque of English (section 11, item 4).
<!-- slop-lint-enable -->

### Email subject lines

<!-- slop-lint-disable -->
- The report gives the shape of a job email subject: role, name and one fact, with "Oportunidad emocionante" as the example of what not to write (section 11, item 8) `[SÍNTESIS]`. That supports MAIL-03 for a generic subject read from a `Subject:` or `Asunto:` line.
<!-- slop-lint-enable -->

### Follow-up

<!-- slop-lint-disable -->
- **Copying the previous message.** The report sets a limit of 8 words copied in a row from the job posting (section 11, item 5, and ESP-03 in section 13.1). Applying the same limit to the previous message of a follow-up is our own extension `[SÍNTESIS]`.
- **Empty follow-up formulas** such as "just following up", "circling back", "bumping this", "solo quería hacer un seguimiento" or "perdón por molestar". No source was found for this note: neither the report nor the Wikipedia page lists them. They wait.
- **A follow-up with no reference to the first message** (no date, subject or request). No source found. It waits.
<!-- slop-lint-enable -->

### WhatsApp

- **Official formatting.** The WhatsApp Help Center documents single asterisks for bold, underscores for italic, tildes for strikethrough and three backticks for monospace `[NORMA]`. It also documents a backtick on each side for inline code, a leading `*` or `-` for a bulleted list, `1.` for a numbered list and `>` for a quote, each followed by a space. It does not document double asterisks or `#` headings. So `**` and `#` are Markdown that WhatsApp shows as literal characters, which supports WA-01. A list with `-` or `1.` is valid WhatsApp formatting and must not be reported there.
- **Emoji as bullets.** The report lists emoji used as bullets as a format sign (section 4.4) `[REPORTADO]`. That supports WA-03.
- **Forced informality.** The report says that "che", an emoji or a joke added to sound human do not make a text human (section 11, item 6) `[SÍNTESIS]`. It is not a rule: the rewriter compares the rewritten text with the user's original.
- **Email formulas in a chat** (a formal salutation, a formal closing, a signature of several lines). No source found. It waits.
- **Written rioplatense register.** The report finds voseo the normal form of address in Argentina, recognized by the Academia Argentina de Letras `[NORMA/REPORTADO]`. Usted stays the formal form, and tuteo is out of place in a rioplatense text (section 7.3). That supports REG-01 with `variety`.

### Cover letter

No change. The 52 rules stay as they are, and the cover letter stays the default genre.

## Channel limits

- **Email.** No limit was sourced for this note. Length thresholds start at the cover-letter values and are measured on the labelled set, as the design asks.
- **WhatsApp.** The Help Center page read for this note gives formatting only, not a message length. No limit is claimed here.
- **LinkedIn connection note.** The report gives 200 characters on a free account (section 11, item 8). LinkedIn is outside the four genres for now.

## Candidate rules and their status

<!-- slop-lint-disable -->
| Id | Genre | What it reports | Evidence | Status |
|---|---|---|---|---|
| MAIL-01 | email, follow-up | "Thank you for your time and consideration" as the only closing line | report, section 12 | ready |
| MAIL-02 | email, follow-up | "Estimado/a" with a slash | report, section 11, item 3 | ready |
| MAIL-03 | email, follow-up | a generic subject on a `Subject:` or `Asunto:` line | report, section 11, item 8 | ready |
| MAIL-04 | email | "I hope this email finds you well", "I hope this message finds you well" | Wikipedia `[REPORTADO]` for English; nothing for the Spanish "Espero que este mensaje lo encuentre bien" | English has a reported source; Spanish waits |
| SEG-01 | follow-up | "just following up", "circling back", "solo quería hacer un seguimiento" | none found | waits |
| SEG-02 | follow-up | no concrete reference to the previous message | none found | waits |
| SEG-03 | follow-up | more than 8 words in a row copied from the previous message | report, section 11, item 5 `[SÍNTESIS]` | ready, with the `previous` option |
| WA-01 | whatsapp | `**` and `#` | WhatsApp Help Center `[NORMA]` | source verified on 15 November 2026 |
| WA-02 | whatsapp | email formulas in a chat | none found | waits |
| WA-03 | whatsapp | emoji used as a bullet | report, section 4.4 `[REPORTADO]` | ready |
<!-- slop-lint-enable -->

A rule marked "waits" enters in its own pull request once a source is found. A rule with a `[REPORTADO]` source enters at low severity with that tag, as the design does for the "this matters" extension of LEX-04.

## What this note did not cover

- Email norms in Spanish and English from a style manual. None was opened for this note.
- Outreach and follow-up surveys. When one is used, it is tagged as marketing, as the report does with recruiter surveys.
- How often each sign appears in human email or chat. That is what the labelled set of the design measures, before any genre profile leaves `experimental`.
