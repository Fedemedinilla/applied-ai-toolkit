# n8n workflow templates

Thirteen n8n workflows for small businesses: lead capture, payment intake, invoicing, booking confirmations, and five flows where Claude classifies, rates, summarizes or writes text. I publish them for free at [kyndredai.com/templates](https://kyndredai.com/templates). This folder holds the English versions and a test suite that checks each file before it is published. This README explains the parts that are easy to get wrong in n8n. Webhooks arrive unsigned, payment notifications repeat, JSON bodies get built by string interpolation, and model output reaches a CRM without a schema.

Preparing this folder found two real bugs in the published versions. The invoicing flow would invoice pending and rejected payments, once per repeated notification. Every Sheets append ran submitted text as a formula. Both are fixed here, and a test fails if either comes back.

## Run it

From the repository root, offline, no API key and no n8n instance:

```sh
npm ci
npx vitest run n8n-templates    # static and executed checks over the 13 files
npm run check                   # tsc --noEmit, strict, includes this folder
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

## Design rules

These are the rules the templates follow, with the exceptions listed under Limits. The tests enforce the ones that can be checked statically, and run the code of the two Code nodes that carry the most risk.

**Validate input before it costs anything.** A webhook that feeds a Claude call, an outgoing message or an API path checks its input first. Leads and review requests need a well-formed email. A Calendly booking needs the `invitee.created` event, an email, a start time and an invitee URI, and WhatsApp only goes to a phone of 8 to 15 digits. A Claude call needs a non-empty message or form body. Tiendanube order ids must be numeric and the store id must be yours before they go into the API path, and MercadoPago payment ids must be numeric. Failures go to a visible discard node instead of an error. Free text is cut before it is stored or sent: names and event titles at 100 characters, messages at 2,000 to 4,000. Every value inserted into a prompt is cut too. Sender fields stop at 100 to 300 characters, message and data bodies at 2,000 to 50,000 depending on the flow. That bounds the cost of one request. It does not bound the number of requests (see Limits).

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

## What the tests cover

`templates.test.ts` loads every file in `templates/` and checks, per template:

- The file parses, has the expected top-level shape (zod schema), at least one trigger, unique node names and ids, and every working node is connected.
- Every connection starts and ends at an existing node, and its type matches its slot (`main`, `ai_languageModel`, `ai_outputParser`).
- Every `$('Node')`, `$node["Node"]` and `$items('Node')` reference in any parameter or Code node resolves to an existing node, and brackets balance inside every `{{ }}` block.
- No `credentials`, `webhookId`, `instanceId`, `meta` or `apiKey` key, and no pinned data.
- No string looks like a secret: `sk-` keys, Slack tokens and webhook ids, GitHub, Google and AWS keys, JWTs, Telegram bot tokens, long hex or base64 runs, phone numbers. Email addresses must be `@example.com`. URLs must point to the provider APIs the templates use or to an `.example` host, with no numeric ids in the path.
- Sheet document and tab, Telegram chat id and fixed recipients are placeholders.
- Each Claude model node holds only a `claude-` model id and options, so the key can only come from the n8n credential. No string mentions the Anthropic API host or an API key header.
- Every chain has a model, and an output parser when it expects one. Every parser schema is valid JSON Schema with all properties required. Every value inserted into a prompt is cut with `.slice`.
- JSON bodies use `JSON.stringify`, Sheets appends use RAW, nodes that send to customers or create records elsewhere have no automatic retry, and no accented Spanish characters or common Spanish words are left.

Across the set, there are 13 files with distinct webhook paths, and each one is listed in this README. Two Code nodes are executed with a minimal `$input`, `require` and `Buffer`:

- The MercadoPago signature check, against notifications signed with a test secret. A valid signature passes, with `data.id` in the body or the query, and with or without `x-request-id`. A changed digit, a dropped `x-request-id`, another id, another `ts`, a missing header part, a non-numeric id and the placeholder secret all fail, and a `v1` with multi-byte characters returns false instead of throwing.
- The WhatsApp extraction, against a batched event. Status updates and image messages are dropped, two text messages give two items, and long text is cut.

Graph walks check that no side-effect node in the MercadoPago, Tiendanube and Calendly flows runs before the validation and deduplication steps. They also check that the invoice call is reachable only for approved payments, and that the WhatsApp flow deduplicates before Claude. The last block runs the reference finder and the secret patterns against known inputs, so a pattern that silently stops matching fails a test.

## Limits

- Only the MercadoPago notifications are authenticated. Every other webhook accepts any POST. The lead, form and sale flows send email to the address in the body. The Calendly flow sends a WhatsApp template, billed by Meta, to the phone number in the body. The classify, form and WhatsApp flows make one Claude call per request, so the number of requests sets the bill as much as their length. Before going live, add Header Auth on the webhook node or verify the provider signature. Calendly (`Calendly-Webhook-Signature`), Tiendanube (`x-linkedstore-hmac-sha256`) and Meta (`X-Hub-Signature-256`) all sign their requests, but those checks need the raw request body and are not included.
- MercadoPago signatures are not checked for age, so a captured notification can be replayed. The deduplication and the API lookup limit what a replay can do.
- Deduplication history lives in the n8n instance database, per node. Manual test runs count; clear it after testing. A send that fails after its id was recorded is not retried on a redelivery, so it has to be sent by hand.
- Sheets appends keep automatic retries, so a timeout after Google accepted the write can add a duplicate row.
- The HubSpot flow creates a contact per new message. Updating an existing contact needs a search by phone first.
- The email triage flow reads Gmail's `snippet`, the first part of the body, not the full message.
- Chains fail the execution if the model's output does not match the schema. There is no retry or fallback branch for that case.
- The executed tests cover the two Code nodes. Expressions inside If, Set and HTTP nodes are only checked statically, since evaluating them needs n8n's expression engine.
- The AFIP template assumes an invoicing provider with a REST API. It does not implement WSAA or WSFEv1, and the request body is a shape to adapt, not any provider's real schema.
