# Security policy

This repository holds libraries and apps that sit at security boundaries. Among them are the gateway that spends money on the Claude API, the renderer that writes model output into a page, the SQL that closes gaps in Supabase Auth and the WordPress hardening plugin. A flaw in one of them can reach the sites that use it, so reports are welcome and handled in private first.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes |
| The latest published release of each `@fedemedinilla` package | Yes, once the package is published |
| Older releases and old commits | No; the fix lands on `main` and in the next release |

No package from this repository is published yet. Until one is, `main` is the only supported version.

## Scope

In scope: the code in this repository, meaning every library folder, every app under `apps/` and the workflows under `.github/workflows/`. Examples of what to report:

- A way past a spending cap in `gateway/`, or a call that the gateway reports as not billed when it was.
- Markup from model output that `safe-markdown/` lets through, or an XSS in any app.
- A gap that `supabase-auth-hardening/` claims to close and does not, or a grant its audit misses.
- A `wp-hardening/` control that can be bypassed, or one that breaks a site it should protect.
- A `site-check/` request that leaves the scope it was given.
- A `csp-build-guard/` or `import-fences/` check that passes when it should fail.
- A workflow that can read a secret or write to the repository beyond its policy.
- A key, token or real personal data committed anywhere in the history.

Out of scope:

- The hosting of the live demos on GitHub Pages, including the missing response headers that the root README already explains.
- Third-party services and their SDKs (Anthropic, Supabase, WordPress core, npm and Composer packages). Report those to their owners. A way this repository misuses one of them is in scope.
- Findings that need an attacker who already controls the machine, the repository or the deploy.

## How to report

Use GitHub private vulnerability reporting: <https://github.com/Fedemedinilla/applied-ai-toolkit/security/advisories/new>. The report stays private between you and the maintainer until an advisory is published.

The form works only while private vulnerability reporting is enabled in the repository (Settings > Security > Private vulnerability reporting). If the link shows no form, open an issue with the "Ask for a private security contact" form (<https://github.com/Fedemedinilla/applied-ai-toolkit/issues/new?template=security_contact.yml>). It is public and asks for nothing about the problem, so name no folder and give no description or proof of concept; the maintainer replies with a private channel.

A useful report says:

- the folder and the commit or package version;
- what an attacker can do, and what they need first;
- the smallest reproduction you have, with fictional data;
- whether you have told anyone else.

Please do not test against sites or accounts you do not own, and do not put real keys or personal data in the report.

## What happens next

This is a one-person project, so what follows is intent, not a guarantee with a deadline. I aim to acknowledge a report soon after it arrives and to confirm or reject it with the reasoning. A confirmed issue is fixed on `main` with a test that reproduces it, the way every fix here is made. When the fix ships, the advisory is published with credit to the reporter, unless you ask to stay anonymous.

## Threat model

Each row names a threat, the folder that mitigates it and the test that shows the mitigation working. The LLM ids are from the [OWASP Top 10 for LLM Applications 2026](https://genai.owasp.org/top-10-for-llm-applications-2026/). A row without a test is left out, so this table covers less than the Scope above.

### Threats to an LLM application

| Threat | OWASP | Mitigation | Evidence |
|---|---|---|---|
| A visitor forges an earlier assistant turn to steer the model | LLM01:2026 Prompt Injection | The chat handlers sign every reply they send with HMAC over the conversation so far, and refuse a history whose signatures do not verify before calling the model ([grounded-assistant/src/history.ts:52](grounded-assistant/src/history.ts#L52), [evals/example/chat.ts:36](evals/example/chat.ts#L36)) | [grounded-assistant/test/handler.test.ts:178](grounded-assistant/test/handler.test.ts#L178), [evals/test/redteam.test.ts:206](evals/test/redteam.test.ts#L206) |
| The model commits the business to a booking it cannot honour | LLM03:2026 Excessive Agency | The model only proposes a booking. `decide()` checks it against the salon's tables, and the price, duration and stylist on the card come from those tables ([grounded-assistant/src/decide.ts:159](grounded-assistant/src/decide.ts#L159)) | [grounded-assistant/test/handler.test.ts:72](grounded-assistant/test/handler.test.ts#L72), [:78](grounded-assistant/test/handler.test.ts#L78), [grounded-assistant/test/decide.test.ts](grounded-assistant/test/decide.test.ts) |
| A dependency or an action changes under a pinned name | LLM04:2026 Supply Chain | Every remote action is pinned to a full commit SHA, and Dependabot proposes exact pins after a 7-day cooldown ([agent-playbook/src/workflow-secrets.ts](agent-playbook/src/workflow-secrets.ts), [.github/dependabot.yml](.github/dependabot.yml)) | [agent-playbook/test/workflow-secrets.test.ts:210](agent-playbook/test/workflow-secrets.test.ts#L210), [test/maintenance/dependabot.test.ts:86](test/maintenance/dependabot.test.ts#L86), [:119](test/maintenance/dependabot.test.ts#L119) |
| Calls spend past the budget | LLM06:2026 Unbounded Consumption | The gateway writes a reservation at the call's worst case before the call goes out, and makes no call when that row cannot be written ([gateway/src/gateway.ts:688](gateway/src/gateway.ts#L688), [gateway/src/caps.ts:149](gateway/src/caps.ts#L149)). It checks the caps again after reserving, so concurrent calls see each other; calls that read before the next one reserves can still pass a cap by at most one worst case | [gateway/test/gateway.test.ts:146](gateway/test/gateway.test.ts#L146), [:463](gateway/test/gateway.test.ts#L463), [:481](gateway/test/gateway.test.ts#L481), [:833](gateway/test/gateway.test.ts#L833), [gateway/test/caps.test.ts:71](gateway/test/caps.test.ts#L71) |
| The model states a price that is not on the list | LLM07:2026 Misinformation | A money guard reads every `$` figure in the reply and withdraws the card when one is not a price from the table, a sum of the rows shown or a multiple by a quantity the visitor wrote ([grounded-assistant/src/money-guard.ts:149](grounded-assistant/src/money-guard.ts#L149)). Its known misses are pinned as tests | [grounded-assistant/test/handler.test.ts:90](grounded-assistant/test/handler.test.ts#L90), [grounded-assistant/test/money-guard.test.ts:38](grounded-assistant/test/money-guard.test.ts#L38), [:58](grounded-assistant/test/money-guard.test.ts#L58) |
| A reply repeats the system prompt | LLM08:2026 Hidden Context Exposure | The red-team runner fails an attack whose reply matches a pattern the attack declares, such as a sentence from the rules ([evals/src/redteam.ts:110](evals/src/redteam.ts#L110)). This detects a leak in a run; it does not stop one in production | [evals/test/redteam.test.ts:227](evals/test/redteam.test.ts#L227) |
| Model output written into a page with `innerHTML` carries markup | LLM10:2026 Improper Output Handling | `renderMarkdown()` escapes the text first, so every tag in its output was written by the renderer ([safe-markdown/src/index.ts:245](safe-markdown/src/index.ts#L245)); output that fails its zod schema never reaches the caller ([gateway/src/gateway.ts:591](gateway/src/gateway.ts#L591)) | [safe-markdown/test/xss.test.ts:14](safe-markdown/test/xss.test.ts#L14), [:43](safe-markdown/test/xss.test.ts#L43), [safe-markdown/test/properties.test.ts:47](safe-markdown/test/properties.test.ts#L47), [gateway/test/gateway.test.ts:216](gateway/test/gateway.test.ts#L216) |

### Threats to the sites and the pipeline

| Threat | Mitigation | Evidence |
|---|---|---|
| A workflow reads a secret or writes beyond its policy | `agent-playbook` checks every workflow against a named policy ([agent-playbook/src/workflow-secrets.ts](agent-playbook/src/workflow-secrets.ts)) | [agent-playbook/test/workflow-secrets.test.ts:22](agent-playbook/test/workflow-secrets.test.ts#L22), [:76](agent-playbook/test/workflow-secrets.test.ts#L76) |
| A key ends up inside a built app | `csp-build-guard` searches each build for the configured secret values, in every encoding it knows | [csp-build-guard/test/checks.test.ts:58](csp-build-guard/test/checks.test.ts#L58) |
| A Content-Security-Policy that the browser reads differently from the one written | `csp-build-guard` parses the policy as the browser does and compares it as sets | [csp-build-guard/test/csp.test.ts:51](csp-build-guard/test/csp.test.ts#L51), [:103](csp-build-guard/test/csp.test.ts#L103), [:131](csp-build-guard/test/csp.test.ts#L131) |
| Anyone signs up to a Supabase project meant for a known list | `supabase-auth-hardening` refuses addresses off the list, under Supabase's default grants | [supabase-auth-hardening/test/closed-signups.test.ts:61](supabase-auth-hardening/test/closed-signups.test.ts#L61), [:73](supabase-auth-hardening/test/closed-signups.test.ts#L73) |
| Password guessing on a WordPress login | `wp-hardening`'s login limiter locks the client address after the limit, even for a correct password | [wp-hardening/tests/Unit/LoginLimiterTest.php:46](wp-hardening/tests/Unit/LoginLimiterTest.php#L46) |
| `site-check` requests pages it was not given | A scope guard in the network layer refuses unlinked and denied paths ([site-check/sitecheck/scope.py:267](site-check/sitecheck/scope.py#L267)) | [site-check/tests/test_net_scope.py:37](site-check/tests/test_net_scope.py#L37), [:49](site-check/tests/test_net_scope.py#L49) |
| The contact form is used to send mail to third parties | `safe-contact-form` takes the owner's destination from its config only. The acknowledgment goes to the address the visitor typed, and a link in their name does not reach it ([safe-contact-form/src/handler.ts:158](safe-contact-form/src/handler.ts#L158)) | [safe-contact-form/test/handler.test.ts:95](safe-contact-form/test/handler.test.ts#L95), [:174](safe-contact-form/test/handler.test.ts#L174) |

## Trust boundaries

Input from these sources is untrusted, and each is checked at one place before the code acts on it:

- **Model output.** The gateway validates structured output with zod before returning it ([gateway/src/gateway.ts:591](gateway/src/gateway.ts#L591)). A proposed booking goes through `decide()` and the money guard (above). Text for a page goes through `renderMarkdown()`.
- **The chat history a browser sends back.** Its signatures are verified before the model sees it ([grounded-assistant/src/history.ts:52](grounded-assistant/src/history.ts#L52)).
- **Visitor input to a server.** The handlers check method, content type and declared size before reading the body, and refuse a body over the limit ([grounded-assistant/src/handler.ts:152](grounded-assistant/src/handler.ts#L152), [safe-contact-form/src/handler.ts:158](safe-contact-form/src/handler.ts#L158)).
- **Text a user types as an amount.** `parseAmount()` returns `ambiguous: true` instead of guessing ([amount-parser/src/money.ts:777](amount-parser/src/money.ts#L777)).
- **Imported files.** Replay Lab caps a run file's size, replays it and compares the hashes it states ([apps/replay-lab/src/run-file.ts:39](apps/replay-lab/src/run-file.ts#L39), [deterministic-sim/src/tournament/replay.ts:118](deterministic-sim/src/tournament/replay.ts#L118)), and the site checklist validates an imported site-check run ([apps/checklist/src/sitecheck-import.ts:144](apps/checklist/src/sitecheck-import.ts#L144)).

## Known gaps

- **LLM05:2026 Data and Model Poisoning and LLM09:2026 Vector and Embedding Weaknesses** are out of scope: nothing here trains a model or keeps a retrieval index.
- **LLM02:2026 Sensitive Information Disclosure** has no row. The fixtures hold no personal data, and no test checks what a model reply discloses.
- **The prompt leak check (LLM08) runs only in the red-team runner.** No production code filters a reply for the rules' text.
- **No code scanning is configured.** CI writes SARIF files and checks that they parse, but does not upload them (root README, "Run everything").
- **The live demos on GitHub Pages run without the Content-Security-Policy header**, since Pages cannot send response headers (root README, "Live demos").
