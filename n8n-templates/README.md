# n8n workflow templates

Thirteen n8n workflows for small businesses: lead capture, payment intake, invoicing, booking confirmations, and five flows where Claude classifies, rates, summarizes or writes text. I publish them for free at [kyndredai.com/templates](https://kyndredai.com/templates). This folder holds the English versions and a test suite that checks each file before it is published. This README explains the parts that are easy to get wrong in n8n. Webhooks arrive unsigned, payment notifications repeat, JSON bodies get built by string interpolation, and model output reaches a CRM without a schema.

Preparing this folder found two real bugs in the published versions. The invoicing flow would invoice pending and rejected payments, once per repeated notification. Every Sheets append ran submitted text as a formula. Both are fixed here, and a test fails if either comes back. Running every node of every workflow found six more, listed under [Bugs the node tests found](#bugs-the-node-tests-found).

## Run it

From the repository root, offline, no API key and no n8n instance:

```sh
npm ci
npx vitest run n8n-templates        # static and executed checks over the 13 files
npm run check                       # tsc --noEmit, strict, includes this folder
node n8n-templates/scripts/docs.ts  # rewrite the generated tables below and diagrams/
```

To use a template, open n8n (2.x, self-hosted or cloud), go to **Workflows > Import from File** and pick a file from `templates/`. Pasting the JSON onto an empty canvas works too. Each workflow opens with a README sticky note and numbered setup notes next to the nodes they configure. Nothing runs until you add your own credentials and activate it.

## The templates

| File | Trigger | Main steps | Where Claude decides | What you configure |
|---|---|---|---|---|
| `lead-capture-to-google-sheets.json` | `POST /lead-capture` | email check, append row | Nowhere | Sheets |
| `lead-to-sheets-and-telegram-alert.json` | `POST /lead-telegram` | email check, append row, Telegram alert | Nowhere | Sheets, Telegram bot, chat id |
| `lead-to-sheets-and-welcome-email.json` | `POST /lead-welcome` | email check, append row, welcome email | Nowhere | Sheets, Gmail, email text |
| `calendly-booking-to-sheets-and-whatsapp.json` | Calendly `invitee.created` | booking check, once per booking, append row, WhatsApp template | Nowhere | Calendly, Sheets, WhatsApp (1) |
| `classify-messages-with-claude.json` | `POST /incoming-message` | empty check, classify, three-way Switch | Category, urgency, summary | Anthropic, one action per branch |
| `email-triage-with-claude-draft-reply.json` | Gmail Trigger, every minute | classify, label, draft in thread | Category and urgency (labels), reply text | Gmail, Anthropic, label ids |
| `form-to-claude-summary-to-slack.json` | `POST /form-response` | empty check, summarize, append row, Slack | Summary, intent, priority | Anthropic, Sheets, Slack webhook |
| `whatsapp-to-claude-lead-rating-to-hubspot.json` | Meta webhook, `GET` and `POST /whatsapp-inbound` | verify token, inbound texts only, once per message, rate, HubSpot contact | Intent, rating, summary, suggested reply | Meta, Anthropic, HubSpot (2) |
| `scheduled-report-with-claude.json` | Schedule, daily at 8 | fetch data, combine items, write report, email | The report text | Data URL, Anthropic, Gmail |
| `mercadopago-payment-to-sheets.json` | MercadoPago `payment` | verify signature, fetch payment, drop repeats, append row | Nowhere | Webhook secret, access token, Sheets |
| `mercadopago-payment-to-afip-invoice.json` | MercadoPago `payment` | verify signature, fetch payment, approved only, once per payment, invoice, receipt | Nowhere | Webhook secret, access token, invoicing API, Gmail |
| `tiendanube-order-to-sheets-and-whatsapp.json` | Tiendanube `order/created` | store and id check, fetch order, once per order, append row, WhatsApp template | Nowhere | Store id, app token, Sheets, WhatsApp (1) |
| `sale-closed-to-google-review-request.json` | `POST /sale-closed` | email check, once per customer, review email, log row | Nowhere | Review link, Gmail, Sheets |

(1) WhatsApp Cloud API token, `YOUR_PHONE_NUMBER_ID` and an approved message template in `YOUR_TEMPLATE_NAME`.
(2) `YOUR_VERIFY_TOKEN`, the Meta webhook subscription, a HubSpot private app token and two custom contact properties.

Placeholders are written as `YOUR_...`, `.example` hosts or `you@example.com`. The Sheets document and sheet pickers are left empty and every credential is unset, so n8n marks those nodes on import.

## Workflows, tests and graphs

One row per workflow. `scripts/docs.ts` writes this table from the JSON files, and `test/docs.test.ts` fails when it no longer matches them or when a workflow has no test file. The graph column links to a Mermaid diagram of the nodes and connections, written by the same script.

<!-- generated:workflows -->
| Workflow file | What it does | Trigger | External services | Code nodes | Test file | Graph |
|---|---|---|---|---|---|---|
| `calendly-booking-to-sheets-and-whatsapp.json` | Calendly booking to Google Sheets and WhatsApp confirmation | `POST /calendly-booking` | Google Sheets, WhatsApp Cloud API | none | [`test/calendly-booking-to-sheets-and-whatsapp.test.ts`](test/calendly-booking-to-sheets-and-whatsapp.test.ts) | [diagram](diagrams/calendly-booking-to-sheets-and-whatsapp.md) |
| `classify-messages-with-claude.json` | Classify incoming messages with Claude and route them | `POST /incoming-message` | Anthropic API | none | [`test/classify-messages-with-claude.test.ts`](test/classify-messages-with-claude.test.ts) | [diagram](diagrams/classify-messages-with-claude.md) |
| `email-triage-with-claude-draft-reply.json` | Incoming email triage with Claude and a draft reply | Gmail Trigger (polling) | Gmail, Anthropic API | none | [`test/email-triage-with-claude-draft-reply.test.ts`](test/email-triage-with-claude-draft-reply.test.ts) | [diagram](diagrams/email-triage-with-claude-draft-reply.md) |
| `form-to-claude-summary-to-slack.json` | Form response to Claude summary to Slack | `POST /form-response` | Anthropic API, Google Sheets, Slack incoming webhook | none | [`test/form-to-claude-summary-to-slack.test.ts`](test/form-to-claude-summary-to-slack.test.ts) | [diagram](diagrams/form-to-claude-summary-to-slack.md) |
| `lead-capture-to-google-sheets.json` | Lead capture to Google Sheets | `POST /lead-capture` | Google Sheets | none | [`test/lead-capture-to-google-sheets.test.ts`](test/lead-capture-to-google-sheets.test.ts) | [diagram](diagrams/lead-capture-to-google-sheets.md) |
| `lead-to-sheets-and-telegram-alert.json` | Lead to Google Sheets and Telegram alert | `POST /lead-telegram` | Google Sheets, Telegram | none | [`test/lead-to-sheets-and-telegram-alert.test.ts`](test/lead-to-sheets-and-telegram-alert.test.ts) | [diagram](diagrams/lead-to-sheets-and-telegram-alert.md) |
| `lead-to-sheets-and-welcome-email.json` | Lead to Google Sheets and welcome email | `POST /lead-welcome` | Google Sheets, Gmail | none | [`test/lead-to-sheets-and-welcome-email.test.ts`](test/lead-to-sheets-and-welcome-email.test.ts) | [diagram](diagrams/lead-to-sheets-and-welcome-email.md) |
| `mercadopago-payment-to-afip-invoice.json` | MercadoPago payment to AFIP invoice | `POST /mercadopago-invoice` | MercadoPago API, your own API (placeholder host), Gmail | Verify signature (x-signature) | [`test/mercadopago-payment-to-afip-invoice.test.ts`](test/mercadopago-payment-to-afip-invoice.test.ts) | [diagram](diagrams/mercadopago-payment-to-afip-invoice.md) |
| `mercadopago-payment-to-sheets.json` | MercadoPago payment to Google Sheets | `POST /mercadopago-payment` | MercadoPago API, Google Sheets | Verify signature (x-signature) | [`test/mercadopago-payment-to-sheets.test.ts`](test/mercadopago-payment-to-sheets.test.ts) | [diagram](diagrams/mercadopago-payment-to-sheets.md) |
| `sale-closed-to-google-review-request.json` | Sale closed to Google review request | `POST /sale-closed` | Gmail, Google Sheets | none | [`test/sale-closed-to-google-review-request.test.ts`](test/sale-closed-to-google-review-request.test.ts) | [diagram](diagrams/sale-closed-to-google-review-request.md) |
| `scheduled-report-with-claude.json` | Scheduled report written by Claude | Schedule Trigger | your own API (placeholder host), Anthropic API, Gmail | none | [`test/scheduled-report-with-claude.test.ts`](test/scheduled-report-with-claude.test.ts) | [diagram](diagrams/scheduled-report-with-claude.md) |
| `tiendanube-order-to-sheets-and-whatsapp.json` | Tiendanube order to Google Sheets and WhatsApp | `POST /tiendanube-order` | Tiendanube API, Google Sheets, WhatsApp Cloud API | none | [`test/tiendanube-order-to-sheets-and-whatsapp.test.ts`](test/tiendanube-order-to-sheets-and-whatsapp.test.ts) | [diagram](diagrams/tiendanube-order-to-sheets-and-whatsapp.md) |
| `whatsapp-to-claude-lead-rating-to-hubspot.json` | WhatsApp message to Claude lead rating to HubSpot | `GET /whatsapp-inbound`, `POST /whatsapp-inbound` | Anthropic API, HubSpot API | Extract message | [`test/whatsapp-to-claude-lead-rating-to-hubspot.test.ts`](test/whatsapp-to-claude-lead-rating-to-hubspot.test.ts) | [diagram](diagrams/whatsapp-to-claude-lead-rating-to-hubspot.md) |
<!-- /generated:workflows -->

### Node versions

The files pin these node versions. They were checked against `n8n-nodes-base` 2.15.1 and `@n8n/n8n-nodes-langchain` 2.45.6. The same script writes the table and the same test checks it, so a version bump in a file shows up here.

<!-- generated:versions -->
| Node type | typeVersion | Workflows that use it |
|---|---|---|
| `@n8n/n8n-nodes-langchain.chainLlm` | 1.5 | 5 |
| `@n8n/n8n-nodes-langchain.lmChatAnthropic` | 1.4 | 5 |
| `@n8n/n8n-nodes-langchain.outputParserStructured` | 1.2 | 4 |
| `n8n-nodes-base.aggregate` | 1 | 1 |
| `n8n-nodes-base.code` | 2 | 3 |
| `n8n-nodes-base.gmail` | 2.1 | 5 |
| `n8n-nodes-base.gmailTrigger` | 1.3 | 1 |
| `n8n-nodes-base.googleSheets` | 4.5 | 8 |
| `n8n-nodes-base.httpRequest` | 4.2 | 7 |
| `n8n-nodes-base.if` | 2.2 | 11 |
| `n8n-nodes-base.noOp` | 1 | 11 |
| `n8n-nodes-base.removeDuplicates` | 2 | 6 |
| `n8n-nodes-base.respondToWebhook` | 1.5 | 1 |
| `n8n-nodes-base.scheduleTrigger` | 1.2 | 1 |
| `n8n-nodes-base.set` | 3.4 | 9 |
| `n8n-nodes-base.stickyNote` | 1 | 13 |
| `n8n-nodes-base.switch` | 3.2 | 1 |
| `n8n-nodes-base.telegram` | 1.2 | 1 |
| `n8n-nodes-base.webhook` | 2.1 | 11 |
<!-- /generated:versions -->

## Design rules

These are the rules the templates follow, with the exceptions listed under Limits. The tests enforce the ones that can be checked statically, run the three Code nodes, and evaluate the If, Set, Switch and Remove Duplicates expressions of every workflow in a small port of n8n's rules.

**Validate input before it costs anything.** A webhook that feeds a Claude call, an outgoing message or an API path checks its input first. Leads and review requests need a well-formed email of 254 characters at most. A Calendly booking needs the `invitee.created` event, an email, a start time and an invitee URI, and WhatsApp only goes to a phone of 8 to 15 digits. A Claude call needs a non-empty message or form body. Tiendanube order ids must be numeric and the store id must be numeric and yours before they go into the API path, and MercadoPago payment ids must be numeric. Failures go to a visible discard node instead of an error. Free text is cut before it is stored or sent: names and event titles at 100 characters, messages at 2,000 to 4,000. Every value inserted into a prompt is cut too. Sender fields stop at 100 to 300 characters, message and data bodies at 2,000 to 50,000 depending on the flow. That bounds the cost of one request. It does not bound the number of requests (see Limits).

**Verify payment signatures before acting.** The MercadoPago templates rebuild the signed manifest, `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. As MercadoPago's documentation says, `request-id` is left out when the header is absent. They compute the HMAC-SHA256 with the webhook secret and compare with `crypto.timingSafeEqual`, after checking that both buffers have the same byte length. While the secret is still the placeholder, every notification is rejected, because a template that verifies against a known placeholder would accept forged requests from anyone who has read this file. The tests run this code against notifications signed with `node:crypto`, and walk the connection graph to make sure no HTTP, Gmail, Sheets or Telegram node runs without passing the true branch of the check.

**Trust the API, not the notification body.** MercadoPago and Tiendanube notifications carry an id, and the amount, status and payer are fetched from the provider's API with your token. In the MercadoPago flows a forged body fails the signature check, and a replayed one is dropped by the deduplication step. The Tiendanube flow has no signature check (see Limits). It accepts only your store id and messages each order once, so a forged request cannot invent an order, and a replay of a real order id sends nothing.

**Idempotency where a repeat costs money or trust.** MercadoPago resends notifications and sends one more per status change. The Sheets template keeps the first item per `id:status`, so retries add no rows and status changes still do. The invoicing template only continues for `approved` payments and lets each payment id through once. The id is recorded before the invoice call, which has no automatic retry, so a failed call means a missing invoice, which takes one manual step. The opposite order risks a duplicate invoice, which needs a credit note. The Calendly and Tiendanube confirmations are billed WhatsApp messages to customers, so each booking URI and each order id goes through once. The WhatsApp flow lets each message id through once, because Meta redelivers events and each one would cost a Claude call and create a HubSpot contact. The review request goes once per email address, because a second request annoys a customer who already left a review. Lead alerts go to you, so a duplicate costs nothing and they are not deduplicated.

**No automatic retry where a retry can duplicate.** A timeout does not tell you whether the provider acted. Nodes that send to a customer or create a record elsewhere (the WhatsApp sends, the welcome, review and receipt emails, the HubSpot contact, the invoice) fail instead of retrying. Reads, Sheets appends and alerts to you keep three tries.

**AI only for the step that needs judgment.** Eight templates have no model at all, because validating an email, checking a signature or appending a row has one correct answer. Where Claude is used, it does one bounded task, such as picking a label or drafting a reply. Routing, writes and sends stay deterministic. Classification, rating and the form summary use Haiku 4.5. The daily report uses Sonnet 4.6 because it writes prose. The email triage flow asks only for the fields it uses. Category and urgency become Gmail labels, and the reply becomes a draft.

**Structured output with closed sets.** Every chain whose output a later node reads as fields uses a structured output parser with a hand-written JSON Schema, not one inferred from an example. Labels are `enum`s with every field required, so a Switch or a CRM property never receives a value outside the list. The classifier's Switch also sends unmatched items to the "other" branch instead of dropping them.

**Treat inbound text as data.** Prompts put customer text inside tags and tell the model not to follow instructions in it. That lowers the risk without removing it, so no template sends a model's text to a customer unreviewed. The email triage flow saves a draft. The WhatsApp flow ends at a placeholder where you decide whether to reply.

**Build JSON with `JSON.stringify`.** Request bodies for WhatsApp, Slack, HubSpot and the invoicing API are one `JSON.stringify(...)` expression. Interpolating `"{{ $json.name }}"` into a JSON string breaks on the first customer name with a quote or a line break, and lets the sender add fields. A test rejects any body that contains `"{{`.

**Sheets in RAW mode.** The Google Sheets node defaults to `USER_ENTERED` from version 4.1, which parses values as if typed. A lead named `=IMPORTXML(...)` would become a formula in your sheet. Every append uses `RAW`.

**WhatsApp templates for business-initiated messages.** A booking or order confirmation goes to a customer who has not written to you, so the WhatsApp Cloud API rejects free-form text outside the 24-hour window. Those two flows send an approved template message, with phone numbers reduced to digits.

## Changes from the published versions

The files on kyndredai.com are in Spanish. Node names, notes, prompts and field names were translated. An n8n expression references nodes by name, so every `$('...')` was renamed with its node, and the tests check that each one resolves. These changes were also made while preparing this folder.

- Removed `webhookId` from every node. With a static path the production URL is `/webhook/<path>`, so the id carried no configuration, only a link to the original instance. Removed the brand from names and paths. Each lead webhook got its own path, since the three published lead templates shared one and n8n refuses to activate two workflows on the same method and path.
- The signature check compares in constant time on byte length, builds the manifest from the parts present, accepts only numeric payment ids, and fails closed on the placeholder secret.
- Invoicing got the `approved` check and the once-per-payment step, and lost the automatic retry on the invoice call. The receipt prints the payment's currency and falls back to the payment id when the description is empty.
- MercadoPago to Sheets and the review request got the deduplication the published notes recommended.
- WhatsApp to HubSpot got the GET verification branch Meta requires before it delivers anything, a Code node that skips status updates and handles batched messages, and deduplication by message id. The rating goes to custom properties, because HubSpot's `hs_lead_status` only accepts its own values and would reject `hot`.
- Calendly got a check of the event and the payload and deduplication by invitee URI. Tiendanube got the store id pin and deduplication by order id. Both send WhatsApp template messages instead of free-form text, to digit-only phone numbers.
- Email triage labels each email by category and urgency instead of discarding those fields, drops the unused summary, avoids `Re: Re:` subjects and sends the draft to the bare address from `From`.
- The report got an Aggregate node, so a list response gets one Claude call and one email instead of one per item. Its prompt now says when the data is empty instead of inventing a report.
- In all flows, JSON bodies go through `JSON.stringify`, Sheets appends use RAW mode with automatic mapping set explicitly, parsers use JSON Schema with enums, and outgoing messages drop the n8n attribution line.

A one-off script (not included) checked the files against the node definitions in `n8n-nodes-base` 2.15.1, `@n8n/n8n-nodes-langchain` 2.45.6 and the filter operators in `n8n-workflow`. Every node type and version exists there, and every parameter name is declared. The changed versions have not been run against live accounts yet.

## Bugs the node tests found

Each one has a test that failed before the fix. The causes were confirmed in the published sources of `n8n-nodes-base` 2.15.1 and `n8n` 2.15.0, not on a running instance.

| Workflow | Node | What was wrong | Fix |
|---|---|---|---|
| `lead-to-sheets-and-telegram-alert.json` | Alert on Telegram | The note said the alert had no parse mode. The Telegram node sends `Markdown` when the parameter is unset, so a lead with one `_` or `*`, such as `first_last@example.com`, was rejected by Telegram and never alerted. A submitted `[text](url)` became a link. | `parse_mode` is `HTML` and the three fields are escaped. |
| `email-triage-with-claude-draft-reply.json` | Incoming email (Gmail Trigger) | At typeVersion 1.2 the trigger also emits mail the owner sent. Each sent email cost a Claude call and got labels and a draft addressed to the owner. | typeVersion 1.3, which skips sent mail. |
| `whatsapp-to-claude-lead-rating-to-hubspot.json` | Extract message | Remove Duplicates compares only with earlier executions, so a message id repeated inside one request passed once per copy. A message without an id used the empty key, which blocked every later one. A list field that was not a list failed the run. | The Code node drops repeated and missing ids and ignores fields that are not lists. |
| `tiendanube-order-to-sheets-and-whatsapp.json` | Your store and a new order? | The note said every request is discarded until `YOUR_STORE_ID` is replaced. A request that sent the placeholder as its store id passed. | The store id must also be numeric. |
| `lead-to-sheets-and-welcome-email.json`, `sale-closed-to-google-review-request.json` | Send welcome email, Ask for review (email) | The note said text a caller controls stays out of the email. The submitted name, 100 characters that could hold a link, went into the greeting and into the review subject. | The greeting keeps Latin letters only, 40 at most, and the subject is fixed text. |
| The three lead flows, the review request and Calendly | The email checks | An address of any length passed. A long one made the Telegram alert exceed 4,096 characters, so it failed. | The check requires 1 to 254 characters. |

## What the tests cover

There are four groups of tests.

**The harness (`harness/`, tested by `harness/harness.test.ts`).** No n8n runs here, so the harness ports the few rules that decide what a template does with an item. `code-node.ts` runs a Code node's JavaScript in a `node:vm` context frozen to a short list of globals. They are `$input`, `items`, `$json`, `$('Node')`, `$node`, `$env` with only the variables a test passes, `require` limited to `crypto`, `Buffer` and a silent `console`. `expressions.ts` evaluates `={{ }}` parameters with `$json`, `$('Node')` and `$now.toFormat` on a fixed clock. `nodes.ts` ports strict If and Switch conditions, Edit Fields (Set) 3.4, the cross-execution history of Remove Duplicates and the JSON body of an HTTP Request.

The harness does not emulate the mode that runs a Code node once per item, `$execution`, `$workflow`, `$vars`, `$today` or Luxon beyond two formats. It also leaves out n8n's extension methods such as `.isEmail()`, paired items across branches, binary data, credentials and every network call. A test fails if a template starts using a `$` global outside the emulated list, a global without a `$` such as `DateTime`, or an extension method, and each port throws on an option it does not cover. The rules were read from the published sources of `n8n-workflow` 2.15.0, `n8n-nodes-base` 2.15.1 and `n8n` 2.15.0. One of them matters for reading the tests. n8n swallows most errors raised inside an expression block, so reading a field of a missing object yields an empty value, not a failed node. Extension methods are the exception, because one called on a null or undefined value fails the node.

**One file per workflow (`test/<workflow>.test.ts`).** Each covers the happy path, missing and malformed input, and the paths where a mistake costs money or trust.

- The signature check runs in both MercadoPago files. It gets a valid signature with `data.id` in the body or the query, and a wrong one with a changed digit, another secret, another id, `ts` or request id. It also gets a missing header, a header without `ts` or `v1`, a non-numeric id, a repeated `data.id`, malformed requests and the placeholder secret. A spy on `crypto.timingSafeEqual` shows that the decision comes from it, on buffers of equal length. One test pins that the age of `ts` is not checked (see Limits).
- For idempotency, the same event delivered twice gives one key in the MercadoPago, Calendly, Tiendanube, WhatsApp and review flows. A status change gives a new key only in the Sheets flow.
- For validation, every email check runs against a shared list of bad addresses. The Calendly and Tiendanube checks are tested field by field, and so are the empty checks before a Claude call.
- For output, the tests compare the row each Set node writes and the JSON body each HTTP node sends, with quotes and line breaks in the input. They also check the prompt lengths after cutting and the Switch branch for each category.

**Structure (`test/structure.test.ts`).** Every file parses and keeps its formatting, and its connections point to existing nodes. No node hides a failure with `continueOnFail`, `onError` or `alwaysOutputData`. Only reads, Sheets appends, drafts and alerts to the owner retry. No webhook is wired straight to a side effect. Every payment webhook has the signature Code node and the true branch of its check between it and any side effect, which the test proves by cutting each one out of the graph.

**Docs (`test/docs.test.ts`).** The two generated tables and the diagrams match the files, every workflow has a test file and a diagram, and no test file or diagram is left over.

`templates.test.ts` is the older suite. It loads every file in `templates/` and checks, per template:

- The file parses, has the expected top-level shape (zod schema), at least one trigger, unique node names and ids, and every working node is connected.
- Every connection starts and ends at an existing node, and its type matches its slot (`main`, `ai_languageModel`, `ai_outputParser`).
- Every `$('Node')`, `$node["Node"]` and `$items('Node')` reference in any parameter or Code node resolves to an existing node, and brackets balance inside every `{{ }}` block.
- No `credentials`, `webhookId`, `instanceId`, `meta` or `apiKey` key, and no pinned data.
- No string looks like a secret: `sk-` keys, Slack tokens and webhook ids, GitHub, Google and AWS keys, JWTs, Telegram bot tokens, long hex or base64 runs, phone numbers. Email addresses must be `@example.com`. URLs must point to the provider APIs the templates use or to an `.example` host, with no numeric ids in the path.
- Sheet document and tab, Telegram chat id and fixed recipients are placeholders.
- Each Claude model node holds only a `claude-` model id and options, so the key can only come from the n8n credential. No string mentions the Anthropic API host or an API key header.
- Every chain has a model, and an output parser when it expects one. Every parser schema is valid JSON Schema with all properties required. Every `{{ }}` block of a prompt is one value cut with `.slice` at its end, with no `+`, `?:` or template literal that could add an uncut one.
- JSON bodies use `JSON.stringify`, Sheets appends use RAW, nodes that send to customers or create records elsewhere have no automatic retry, and no accented Spanish characters or common Spanish words are left.

Across the set, there are 13 files with distinct webhook paths, and each one is listed in this README. It also executes two Code nodes with a minimal `$input`, `require` and `Buffer`:

- The MercadoPago signature check, against notifications signed with a test secret. A valid signature passes, with `data.id` in the body or the query, and with or without `x-request-id`. A changed digit, a dropped `x-request-id`, another id, another `ts`, a missing header part, a non-numeric id and the placeholder secret all fail, and a `v1` with multi-byte characters returns false instead of throwing.
- The WhatsApp extraction, against a batched event. Status updates and image messages are dropped, two text messages give two items, and long text is cut.

Graph walks check that no side-effect node in the MercadoPago, Tiendanube and Calendly flows runs before the validation and deduplication steps. They also check that the invoice call is reachable only for approved payments, and that the WhatsApp flow deduplicates before Claude. The last block runs the reference finder and the secret patterns against known inputs, so a pattern that silently stops matching fails a test.

## What these templates do not do

- They do not authenticate any webhook except MercadoPago's. See the first item under Limits before going live.
- They do not send a model's text to a customer. The email flow saves a draft and the WhatsApp flow stops at a placeholder.
- They do not retry a send, an invoice or a contact creation, and they do not send again something that failed after its id was recorded.
- They do not talk to AFIP. The invoicing flow posts to an invoicing provider's REST API that you supply.
- They do not handle refunds, chargebacks or cancellations. Nothing issues a credit note, removes a row or tells a customer that a booking was canceled.
- They do not update existing records. A second message from the same phone creates a second HubSpot contact, and a status change adds a row.
- They do not store secrets. Every credential is unset, and the one secret that lives in a node, the MercadoPago webhook secret, is a placeholder that rejects every request until you replace it.
- They do not rate-limit. The number of requests a webhook accepts is whatever n8n and your proxy allow.
- They are not run against live accounts by this test suite. The tests check the logic of each file, not the behavior of MercadoPago, Meta, Google or HubSpot.

## Limits

- Only the MercadoPago notifications are authenticated. Every other webhook accepts any POST. The lead, form and sale flows send email to the address in the body. The Calendly flow sends a WhatsApp template, billed by Meta, to the phone number in the body. The classify, form and WhatsApp flows make one Claude call per request, so the number of requests sets the bill as much as their length. Before going live, add Header Auth on the webhook node or verify the provider signature. Calendly (`Calendly-Webhook-Signature`), Tiendanube (`x-linkedstore-hmac-sha256`) and Meta (`X-Hub-Signature-256`) all sign their requests, but those checks need the raw request body and are not included.
- MercadoPago signatures are not checked for age, so a captured notification can be replayed. The deduplication and the API lookup limit what a replay can do.
- Deduplication history lives in the n8n instance database, per node. Manual test runs count; clear it after testing. A send that fails after its id was recorded is not retried on a redelivery, so it has to be sent by hand.
- The history holds 10,000 keys by default. In n8n 2.15 the Remove Duplicates node does not evict old keys to make room. Once the history is full it fails every execution. Nothing is sent or invoiced until you raise *History Size* in the node's options or clear the history. The Sheets flow stores one key per payment status, so it gets there first.
- The MercadoPago flows do not check the notification `type`. Subscribe the webhook only to the payment event, as the setup note says. A signed notification of another type would look up its id as a payment.
- A payment whose API response has no payer data is invoiced with empty customer fields, because n8n turns a missing field into an empty value. Your invoicing provider decides whether to accept it.
- The Tiendanube flow does not check the phone before the WhatsApp call. An order without a usable phone is saved to the sheet and then fails at the send.
- While `YOUR_VERIFY_TOKEN` is not replaced, the WhatsApp verification answers anyone who sends the placeholder.
- The welcome and review greetings keep Latin letters only. A name in another script gets "Hi there".
- The signature Code node needs `crypto`. On a self-hosted instance that does not allow it, the node fails and no payment is processed until you set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
- Sheets appends keep automatic retries, so a timeout after Google accepted the write can add a duplicate row.
- The HubSpot flow creates a contact per new message. Updating an existing contact needs a search by phone first.
- The email triage flow reads Gmail's `snippet`, the first part of the body, not the full message.
- Chains fail the execution if the model's output does not match the schema. There is no retry or fallback branch for that case.
- The tests run the Code nodes and evaluate expressions in a port of n8n's rules, written from its published source. They do not run n8n's own expression engine or any node's real code, so a difference between the port and n8n would not show up here.
- The AFIP template assumes an invoicing provider with a REST API. It does not implement WSAA or WSFEv1, and the request body is a shape to adapt, not any provider's real schema.
