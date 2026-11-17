# Research by genre

slop-lint was built for cover letters. Its design for the next version adds three genres (`email`, `follow-up` and `whatsapp`), and a rule enters a genre only with a source. This note gathers the evidence for each genre as of 15 November 2026: what is already sourced, what was checked for this note, and what still has no source and waits.

Each claim carries an evidence tag of the report, written as code so the linter does not read it as a placeholder. The tags are MEDIDO (measured, primary source), NORMA (normative reference or official documentation), REPORTADO (reported by a secondary source), CONSENSO (agreement across sources) and SÍNTESIS (our own synthesis). Where there is no source, the entry says so. The phrases quoted as examples are the patterns the rules look for, so they sit between `slop-lint-disable` and `slop-lint-enable` directives and the docs lint does not report them.

## Sources

- **The report.** The curated deep-research report behind the 52 rules (see [PROMPT.md](PROMPT.md)). It is not in this repository. Entries cite it by section and item.
- **WhatsApp Help Center**, "How to format your messages", https://faq.whatsapp.com/539178204879377, read on 15 November 2026 `[NORMA]`.
- **Wikipedia**, "Wikipedia:Signs of AI writing", sections "Collaborative communication" and "Phrasal templates and placeholder text", https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing, read on 15 November 2026. The page publishes no method, so it counts as `[REPORTADO]`, as the report already treats it.
- **The pages listed under "Second pass", below**, opened on 15 November 2026 for MAIL-04, SEG-01, SEG-02, WA-02 and channel length. Their quotes came through a summarizing fetch tool, so each one has to be checked against the live page before a rule cites it in code.

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
- **Empty follow-up formulas** such as "just following up", "circling back", "bumping this", "solo quería hacer un seguimiento" or "perdón por molestar". Neither the report nor the Wikipedia page lists them. The second pass found sources for some of them and against one (see SEG-01 below). They wait.
- **A follow-up with no reference to the first message** (no date, subject or request). The second pass found sources that ask for context, the topic and the role, but none that asks for the date (see SEG-02 below). It waits.
<!-- slop-lint-enable -->

### WhatsApp

- **Official formatting.** The WhatsApp Help Center documents single asterisks for bold, underscores for italic, tildes for strikethrough and three backticks for monospace `[NORMA]`. It also documents a backtick on each side for inline code, a leading `*` or `-` for a bulleted list, `1.` for a numbered list and `>` for a quote, each followed by a space. It does not document double asterisks or `#` headings. So `**` and `#` are Markdown that WhatsApp shows as literal characters, which supports WA-01. A list with `-` or `1.` is valid WhatsApp formatting and must not be reported there.
- **Emoji as bullets.** The report lists emoji used as bullets as a format sign (section 4.4) `[REPORTADO]`. That supports WA-03.
- **Forced informality.** The report says that "che", an emoji or a joke added to sound human do not make a text human (section 11, item 6) `[SÍNTESIS]`. It is not a rule: the rewriter compares the rewritten text with the user's original.
- **Email formulas in a chat** (a formal salutation, a formal closing, a signature of several lines). The second pass found only indirect support (see WA-02 below). It waits.
- **Written rioplatense register.** The report finds voseo the normal form of address in Argentina, recognized by the Academia Argentina de Letras `[NORMA/REPORTADO]`. Usted stays the formal form, and tuteo is out of place in a rioplatense text (section 7.3). That supports REG-01 with `variety`.

### Cover letter

No change. The 52 rules stay as they are, and the cover letter stays the default genre.

## Channel limits

- **Email.** No hard limit was sourced. For a follow-up, Grammarly recommends a body under 150 words and UGA a few sentences (see the second pass); both are advice, not measurements. Length thresholds start at the cover-letter values and are measured on the labelled set, as the design asks.
- **WhatsApp.** Meta documents a technical cap of 4,096 characters for the body of a text message on the WhatsApp Business Platform (see the second pass). It is an API limit, not a style guideline, and no guideline for messages to people was opened.
- **LinkedIn connection note.** The report gives 200 characters on a free account (section 11, item 8). LinkedIn is outside the four genres for now.

## Candidate rules and their status

<!-- slop-lint-disable -->
| Id | Genre | What it reports | Evidence | Status |
|---|---|---|---|---|
| MAIL-01 | email, follow-up | "Thank you for your time and consideration" as the only closing line | report, section 12 | implemented in 0.2.0 |
| MAIL-02 | email, follow-up | "Estimado/a" with a slash | report, section 11, item 3 | implemented in 0.2.0 |
| MAIL-03 | email, follow-up | a generic subject on a `Subject:` or `Asunto:` line | report, section 11, item 8, which names one generic subject and no list | implemented in 0.2.0, for that subject only |
| MAIL-04 | email, follow-up, whatsapp | the opener "I hope this email/message finds you well" (also "Hope this finds you well", "I trust this email finds you well") and its Spanish calques ("Espero que este mensaje te encuentre bien", "Espero que te encuentres / se encuentre bien"), and the closers "please do not hesitate to contact", "at your earliest convenience", "I look forward to hearing from you" or "to your reply", "quedo atenta a tu(s) comentarios", "quedo a la espera de su respuesta", "quedo a disposición", "agradezco de antemano" | Opener: Wikipedia `[REPORTADO]`, checked on the live page on 17 November 2026; Grammarly and Emphasis `[CONSENSO]`, not rechecked. Closers and the Spanish calque: no published source; the live rewriter eval of 17 November 2026 `[SÍNTESIS]` | implemented after 0.2.0, at level 2 and severity low; "I wanted to reach out" stays out |
| SEG-01 | follow-up | "just following up", "solo quería hacer un seguimiento", "perdón por molestar" | Grammarly and LanguageTool `[REPORTADO]` for "just following up"; Proton `[REPORTADO]` for "Perdón por molestar". Against: Grammarly accepts "circle back". None for "bumping this" or the Spanish "solo quería hacer un seguimiento" | waits; "circling back" stays out |
| SEG-02 | follow-up | no concrete reference to the previous message | Grammarly and Proton `[REPORTADO]`, Denver and UGA career centers `[CONSENSO]`, for context, topic and role; none for a date | waits; a rule could ask for the topic or the role, not the date |
| SEG-03 | follow-up | more than 8 words in a row copied from the previous message | report, section 11, item 5 `[SÍNTESIS]` | implemented in 0.2.0, with the `previous` option |
| WA-01 | whatsapp | `**` and `#` | WhatsApp Help Center `[NORMA]` | source verified on 15 November 2026; not implemented yet |
| WA-02 | whatsapp | email formulas in a chat | one marketing blog on excess formality `[REPORTADO]`, indirect; WhatsApp Business templates do use "Estimado [nombre]" | waits; at most a low signal |
| WA-03 | whatsapp | emoji used as a bullet | report, section 4.4 `[REPORTADO]` | implemented in 0.2.0 |
<!-- slop-lint-enable -->

A rule marked "waits" enters in its own pull request once a source is found. A rule with a `[REPORTADO]` source enters at low severity with that tag, as the design does for the "this matters" extension of LEX-04.

## Second pass, 15 November 2026

Each entry gives the page, a quote under 30 words, and the tag. Only pages that were opened are listed; what search snippets showed without the page opening is under "Still without a source". The quotes came through a summarizing fetch tool and have to be checked against the live page before any rule cites them in code.

### MAIL-04, the stock opener

<!-- slop-lint-disable -->
- Wikipedia, "Wikipedia:Signs of AI writing", https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing `[REPORTADO]`. It lists the opener as a real example of LLM text: "I hope this message finds you well. I am writing to request an edit for the Wikipedia entry". On 17 November 2026 the page's wikitext (`action=raw`) was read without the summarizing tool: the quote is there word for word, as the first example under "Phrasal templates and placeholder text" (a February 2024 edit request at Talk:Spaghetti), not under "Communication intended for the user" as the first pass said.
- The same page, under "Comment-specific indicators", says of talk-page comments: "Many LLM-generated comments tend to sound like they're coming from a clerk or customer service representative" `[REPORTADO]`. It makes the point about wiki comments, not about email, so it is context for MAIL-04 and no evidence for it.
- Grammarly, https://www.grammarly.com/blog/writing-tips/i-hope-this-email-finds-you-well/ `[CONSENSO]`: "the opener has become a recognizable email cliché".
- Emphasis, a UK business writing firm, https://www.emphasis.co.uk/blog/has-i-hope-youre-well-had-its-day/ `[CONSENSO]`: "those five words have become the default opener for almost every email". It adds that the phrase can read as insincere.
- Alore, a sales email blog, https://www.alore.io/blog/what-can-i-say-instead-of-im-reaching-out `[CONSENSO]`. It covers "I'm reaching out" and its softened forms and says: "In cold email the softening can read as hesitation, so state the reason directly." Two reads of the page named different headings for that sentence, so this note names none.
- Purdue OWL, https://owl.purdue.edu/owl/general_writing/academic_writing/email_etiquette.html `[NORMA]`. An email opens with a greeting and closes with a sign-off and a name, but "it is probably acceptable to leave greetings out of your follow-up emails". So the formula belongs to a first email, not to every message.
<!-- slop-lint-enable -->

### Spanish email norms

- Castellano Actual (Universidad de Piura), https://www.udep.edu.pe/castellanoactual/?p=3144 `[NORMA]`: "después del saludo inicial se deben colocar dos puntos y empezar a escribir en el renglón siguiente con mayúscula inicial." A comma there is the English convention.
- Castellano Actual, https://www.udep.edu.pe/castellanoactual/saludos-en-cartas-y-correos-electronicos/ `[NORMA]`. In emails and messages that go on in the same line, "se acepta el uso de punto o de otro signo que corresponda si se continúa en la misma línea".
- These two pages stand in for the RAE and Fundéu pages, which could not be opened (see below).

### SEG-01, empty follow-up formulas

<!-- slop-lint-disable -->
- Grammarly, https://www.grammarly.com/blog/emailing/follow-up-email `[REPORTADO]`, advises against opening with "Just following up", because such lines "don't add new information or give the reader a reason to continue". The same article uses "circle back" as an acceptable opener, so it does not support flagging "circling back".
- LanguageTool, a writing software vendor, https://languagetool.org/insights/post/word-choice-i-just-wanted-to-follow-up/ `[REPORTADO]`, on "I just wanted to follow up": "The major issue with this phrase is that it doesn't explicitly state what you're asking for or seeking."
- Proton, a vendor blog, https://proton.me/es-419/business/blog/follow-up-email `[REPORTADO]`, gives "Perdón por molestar, solo quería consultar…" as an example of an over-apologetic follow-up to avoid.
<!-- slop-lint-enable -->

### SEG-02, a reference to the earlier message

- Grammarly, https://www.grammarly.com/blog/emailing/follow-up-email `[REPORTADO]` says the first line should "quickly remind the recipient what you're referring to and why you're reaching out".
- Proton, https://proton.me/es-419/business/blog/follow-up-email `[REPORTADO]`, on reminders: "Responda en un hilo existente o dé algo de contexto en una o dos frases".
- University of Denver career center, https://career.du.edu/blog/2020/06/29/how-to-write-a-follow-up-e-mail-after-youve-submitted-an-application/ `[CONSENSO]`. The subject of a follow-up on an application should "include the name of the position you're applying for and your name".
- University of Georgia career center, https://career.uga.edu/news/5_essential_e_mail_templates_for_your_job_search `[CONSENSO]`: "Use a straightforward subject line that names the position title." Its follow-up template refers to the specific application.

### WA-02, email formulas in a chat

- Leadsales, a WhatsApp sales tool blog, https://leadsales.io/blog/errores-al-escribir-por-whatsapp-a-clientes/ `[REPORTADO]`, lists an overly formal tone as a mistake with clients: "Lo que necesitas es un tono cercano y natural que invite a la conversación." It says nothing about signatures, so the support is indirect.

### Length of a follow-up and of a WhatsApp message

- Grammarly, https://www.grammarly.com/blog/emailing/follow-up-email `[REPORTADO]`: "keeping the body under 150 words (3–5 sentences)". It also gives 50 to 125 words as a usual range. It is a recommendation, not a measurement.
- University of Georgia career center, https://career.uga.edu/news/5_essential_e_mail_templates_for_your_job_search `[CONSENSO]`: "Keep the email concise, only a few sentences."
- Meta, WhatsApp Business Platform documentation, https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages/ `[NORMA]`: "Maximum 4096 characters." It is the API's cap on a text message body, not a style guideline.

### Still without a source

<!-- slop-lint-disable -->
- **MAIL-04 in Spanish, and its closers.** No page opened treats "Espero que este mensaje lo encuentre bien" as a sign of generated text or as a cliché, and none was opened for the closers. MAIL-04 reports them on the strength of the live rewriter eval of 17 November 2026 (147 fictional cases), where the register-fit judge named them as the line that decided a failure and no rule had reported them; that is our own measurement with a model as the judge, so they stay at severity low.
- **WA-02.** Nothing solid on "Estimado", "Saludos cordiales" or a signature of several lines being out of place in WhatsApp. Search results showed WhatsApp Business templates that do use "Estimado [nombre]", so the rule would be a low signal, not an error.
- **SEG-01, "bumping this".** No page opened names the phrase.
- **SEG-01, "circling back".** The only page opened (Grammarly) uses it as acceptable. A Vault page did not load its body and The Muse returned 403, so nothing supports flagging it.
- **SEG-01, "solo quería hacer un seguimiento".** The exact phrase is in no page opened. Reply.io criticizes "solo quería saber si…", but only a search snippet showed it.
- **SEG-02, the date of the earlier message.** No page opened asks for it. The sources ask for context, the topic and the role.
- **Fundéu.** fundeu.es refused the search and fetch tools (400, "not accessible to our user agent"). Nothing from Fundéu was checked.
- **RAE.** The pages for "dos puntos", "coma" and "usos de los dos puntos" returned 403. The colon-not-comma rule and the "anglicismo ortográfico" wording showed only in search snippets; the Castellano Actual pages above are the substitute that was opened.
- **Style guides.** The Microsoft and Google style guides were not searched for email openings, and no Fundéu, RAE, Microsoft or Google page on follow-up formulas was found.
- **Surveys with figures.** No outreach survey with reply rates by phrase or by length was opened, so there is no number.
- **WhatsApp length for people.** Only the API cap above. The 360dialog figure of under 1,600 characters showed only in a search snippet.
- **Wikipedia for follow-ups.** On 16 November 2026 the whole of "Signs of AI writing" (250,972 characters) was read through the summarizing fetch tool in three parts, from offsets 0, 100,000 and 200,000; the quotes above come from the second part. No part has follow-up phrases, so the page is no source for SEG-01 or SEG-02. The tool said it shortened the first part, so a phrase in that part could have been missed.
<!-- slop-lint-enable -->

## What this note did not cover

- Email norms from a style manual. The second pass opened Purdue OWL and two Castellano Actual pages, but no RAE, Fundéu, Microsoft or Google page.
- Outreach and follow-up surveys. None with figures was opened. When one is used, it is tagged as marketing, as the report does with recruiter surveys.
- How often each sign appears in human email or chat. That is what the labelled set of the design measures, before any genre profile leaves `experimental`.
