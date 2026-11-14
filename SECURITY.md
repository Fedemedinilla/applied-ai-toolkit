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

The form works only while private vulnerability reporting is enabled in the repository (Settings > Security > Private vulnerability reporting). If the link shows no form, open a public issue that asks for a private contact and says nothing else about the problem: no folder, no description, no proof of concept.

A useful report says:

- the folder and the commit or package version;
- what an attacker can do, and what they need first;
- the smallest reproduction you have, with fictional data;
- whether you have told anyone else.

Please do not test against sites or accounts you do not own, and do not put real keys or personal data in the report.

## What happens next

This is a one-person project, so what follows is intent, not a guarantee with a deadline. I aim to acknowledge a report soon after it arrives and to confirm or reject it with the reasoning. A confirmed issue is fixed on `main` with a test that reproduces it, the way every fix here is made. When the fix ships, the advisory is published with credit to the reporter, unless you ask to stay anonymous.
