# Procedures

The method's phases, the list read before any change, the test matrix run after each change, and the incident runbook. Rewritten in English from the audit method's playbook, its do-not-touch list and its incident runbook. Each table is read by `data/build-catalogue.ts` by its heading.

## Phases

Without written authorization only phase 1 exists.

| Phase | Name | Produces |
|---|---|---|
| 0 | Intake | The request, the authorization when there will be internal work, and an inventory of accounts without passwords |
| 1 | External diagnosis | Every EXT and VIS check in one of the seven states, and the main findings by priority |
| 2 | Internal diagnosis | Every INT check in a state, and the decision between ordinary work and the incident runbook |
| 3 | Plan | The order of changes, what will not be touched, a low-traffic window and a written way back |
| 4 | Execution | One change at a time, each followed by the post-change matrix, and every SEG and VEL check fixed or passed |
| 5 | Verification | The phase 1 and 2 measurements repeated with the same tool and conditions, as a before and after table |
| 6 | Handover | The before and after report, ordered access, a short manual and a record of what was delivered |
| 7 | Monitoring | The weekly, fortnightly and monthly tasks, and a monthly report |

## Pre-change list

Read before the first change, with the owner.

| ID | Item |
|---|---|
| backup-restored | A full backup of files and database, restored as a test on a subdomain or locally. A backup nobody restored does not count. |
| staging | Staging if it exists; otherwise one change at a time with the way back written down. |
| window | A low-traffic window agreed with the owner. |
| rollback-plan | A written way back: which file or setting is put back, and how. |
| owner-notice | The owner told what will be touched, and when. |
| test-inventory | The list of what will be tested afterwards (the post-change matrix). |

## Post-change matrix

After each change that touches forms, cache, PHP, the theme or the database, and always at the end.

| ID | What | How | Pass when | Needs |
|---|---|---|---|---|
| forms | Forms | A real send from each public form, marked as a test; for forms wired to a CRM, with the action neutralised or in the CRM sandbox | It reaches its destination and shows in the form's panel | forms |
| payments | Payments | A test order with the gateway in test mode | The whole checkout completes | store |
| admin-sign-in | Admin sign-in | Sign in with a test account and its second factor | It signs in | - |
| key-pages | Key pages | The home, the main enquiry page, a news item and a page with a slider | They look as before, with no raw shortcodes | - |
| phone | Phone | A real phone, or developer tools at 375 px | No horizontal scroll; the menu works | - |
| cache-purged | Cache purged | Purge the plugin, server and CDN caches | The changes show | - |
| anonymous | As an anonymous visitor | A private window, on the www host when the site uses it | It looks the same as when signed in | - |
| console | Browser console | The developer tools console on the home | No new errors (policy or script) | - |
| outgoing-mail | Outgoing mail | Reset the password of the test account | The mail arrives | - |

## Incident phases

| Phase | Name |
|---|---|
| 1 | Contain |
| 2 | Preserve evidence |
| 3 | Eradicate in every layer |
| 4 | Recover |
| 5 | Harden before republishing |
| 6 | Verify, republish and report |

## Incident steps

A step can be ticked only after every step it requires.

| ID | Phase | Step | Requires |
|---|---|---|---|
| site-isolated | 1 | Site isolated: public access blocked (maintenance mode, or deny all except your own address) | - |
| host-ticket | 1 | Written ticket to the host: isolate without deleting, preserve logs and a snapshot, and keep the site offline until you confirm | - |
| owner-told | 1 | Owner told what happened and what you are doing, and asked not to change passwords yet | - |
| snapshot | 2 | Full snapshot of files, database and access and error logs, stored apart from the site | - |
| indicators-recorded | 2 | Indicators recorded with path, date and hash (INT-01 to INT-05, INT-14, INT-15, INT-19 to INT-21, INT-26, INT-28 to INT-30) | snapshot |
| evidence-local | 2 | Evidence that holds the attacker's live secrets kept in an encrypted local folder, out of any cloud or repository | snapshot |
| layer-files | 3 | Files: PHP in uploads, unknown mu-plugins and drop-ins, modified core, recently changed files, rewrite rules | snapshot |
| layer-database | 3 | Database: autoloaded options with encoded code, fake administrators, foreign cron hooks, posts with scripts | snapshot |
| layer-users | 3 | Users: unknown administrators, application passwords, sessions | snapshot |
| layer-hosting | 3 | Hosting: server cron jobs that fetch remote code, FTP and SSH accounts, API tokens, mail forwarders | snapshot |
| layer-dns-mail | 3 | DNS and mail: changed MX, odd TXT records, new subdomains | snapshot |
| layer-plugins | 3 | Plugins disguised as legitimate ones, and migration or export plugins | snapshot |
| path-decided | 3 | Path decided: restore a clean backup from before the infection, or clean in place | layer-files, layer-database |
| content-inventory | 3 | Inventory of legitimate content created after the backup date, to put back by hand | path-decided |
| admin-lockout | 4 | Admin lockout applied: every administrator password replaced by a random hash and every session cleared | site-isolated, snapshot |
| restored-or-cleaned | 4 | Clean backup restored (files and database), or the site cleaned in place | admin-lockout, path-decided, content-inventory |
| second-pass-zero | 4 | Second full pass over the six layers counts zero indicators | restored-or-cleaned, layer-files, layer-database, layer-users, layer-hosting, layer-dns-mail, layer-plugins |
| content-restored | 4 | Legitimate content created after the backup put back from the inventory | second-pass-zero |
| rotate-passwords | 4 | Real passwords rotated with the environment inert, in order: salts, administrators, hosting panel, FTP and SSH, database, API tokens, application passwords, integrations | site-isolated, admin-lockout, second-pass-zero |
| export-plugins-removed | 4 | Migration and export plugins uninstalled | second-pass-zero |
| hardening-applied | 5 | Hardening list applied, starting with named accounts, second factor, file editing, XML-RPC, sign-in limits, uploads and access left by former contractors | rotate-passwords |
| updates-applied | 5 | Core, plugins and themes updated | rotate-passwords |
| attacker-blocked | 5 | Attacker addresses blocked, and what the restore does not touch rotated (hosting panel, SSH, system cron, FTP, forwarders) | rotate-passwords |
| final-pass-clean | 6 | Second full pass of the internal and external lists: zero indicators, scanners clean, no Safe Browsing warning, no spam in a site: search | hardening-applied, updates-applied, attacker-blocked |
| matrix-passed | 6 | Post-change matrix passed (forms, sign-in, key pages, phone, anonymous) | final-pass-clean |
| republished | 6 | Site republished, and the host asked to lift any network block | final-pass-clean, matrix-passed, content-restored, export-plugins-removed |
| review-requested | 6 | Review requested from the search engine if there was a warning | republished |
| reports-written | 6 | Two reports written: a technical one with the timeline and a one-page plain one | republished |
| first-week-watch | 6 | Daily scan and sign-in review during the first week after republishing | republished |
