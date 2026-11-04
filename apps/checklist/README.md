# Site checklist

Site checklist is an offline web app for working through a website audit, one site at a time: 152 checks for security, speed, visibility and commerce, filtered by platform and phase. The rules a written checklist can only ask for are enforced in code. A pass without evidence counts as not checked. Nothing can be marked Fixed before the pre-change list is acknowledged. A site's real passwords cannot be marked rotated before the site is isolated and every administrator is locked out. Colours come from a fixed table, so two runs of the same site can be compared. It pre-fills from a site-check `datos.json` and exports Markdown reports and the run JSON, with no server and no model.

Live demo: <https://fedemedinilla.github.io/applied-ai-toolkit/checklist/>

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/checklist                                   # offline, no key, about six seconds
node apps/checklist/data/build-catalogue.ts                     # rebuilds public/catalogue.json from data/source/
node apps/checklist/data/build-catalogue.ts --check             # exits 1 when the committed catalogue is stale
npm run build:checklist                                         # writes dist/apps/checklist (npm run build:apps builds every app)
npx vite build --config apps/checklist/vite.config.ts           # the same build, without the npm script
node csp-build-guard/cli.ts --dir dist/apps/checklist --config apps/checklist/csp-guard.config.json   # npm run guard:apps checks every app and needs npm run build:apps first
npx vite preview --config apps/checklist/vite.config.ts         # serves dist/apps/checklist at http://localhost:4173
npx vite --config apps/checklist/vite.config.ts                 # dev server; no service worker in dev
node apps/checklist/scripts/icons.ts                            # redraws the icons in public/
```

The output uses relative URLs only (`base: './'`), so it works at a domain root or under a subpath. The service worker needs `localhost` or HTTPS.

The build (Vite 8.3.4) writes 41.37 kB of JavaScript, 14.34 kB gzipped, 7.14 kB of CSS and a 2.14 kB service worker. The catalogue is a separate 109 kB `catalogue.json`, fetched at start and precached. csp-build-guard checks the build under a strict policy given as a `literal` (`'self'` only, no inline script or style, no plugins). It finds no regex lookbehind and measures `index.html` at 14.2 kB gzip and 12.8 kB brotli, under a 20 kB budget.

## The flow

1. **Site and profile.** Name the site and pick the platform: WordPress, WooCommerce, Joomla or Drupal, a hosted builder, a hosted store or a static site. Then tick what the site has (its own mail, public forms, two languages, a hosting panel, Elementor or Avada). The written authorization box adds the internal, hardening and monitoring checks. Without it the profile holds only what a visitor's browser can see, which for a WordPress site is 42 checks.
2. **Mark.** Each check shows its plain question and, folded, where to look, the pass condition, what to do if it fails and what not to touch. Pick a state, type the evidence. The badge and the counts update as you type: "1 to fix now, of 42 applicable".
3. **Import.** Reports and data, Import, loads a site-check `datos.json` and pre-fills the external checks it measured, each with its run date, its finding and its evidence file names. To try it on the published demo, save site-check's [example run](https://raw.githubusercontent.com/Fedemedinilla/applied-ai-toolkit/main/site-check/examples/datos.json) and import it.
4. **Change control.** Acknowledge the six-item pre-change list, record "before", make the changes and mark them Fixed. Acknowledge the post-change matrix, then close the run.
5. **Export.** The check report (template A), the before and after report (template B, once "before" exists) and the run JSON, which can be loaded back on another device.

The incident tab is separate from the run's checks: 29 steps in the six phases of the runbook (contain, preserve evidence, eradicate in every layer, recover, harden, verify and republish). A step whose prerequisites are open shows them ("Needs first: Site isolated; Admin lockout applied; ...") and refuses the tick. Each tick keeps its time to the minute, which can be corrected within the window its dependencies allow. The timeline downloads as a Markdown table. Like the checks, the incident log is read-only while the run is closed.

## Design decisions

**The catalogue is built from reviewed tables, not typed into code.** `data/source/*.md` are Markdown tables with twelve fixed columns, one file per module. `data/build-catalogue.ts` parses them and validates every cell. The id must match its file (`COM-NN` in `commerce.md`) and the priority must be one of four. Every platform token and feature must exist, and text must be printable ASCII. A typo in a platform would otherwise make a check silently never apply. The ASCII rule catches Spanish text from the source tables left in. A test rebuilds the catalogue and compares it byte for byte with the committed `public/catalogue.json`, so the two cannot drift.

**The colour is derived, never chosen.** [`src/colours.ts`](src/colours.ts) holds the method's table. Passed and Fixed are green. A failure is red when the check is about security with priority Critical or High, yellow for lower security priorities and for any speed check, and blue for visibility. A pass with a note is yellow at Critical or High, blue below. Risk accepted is yellow, labelled "decided by the owner". Not verified is grey, and not applicable leaves the count. Three exceptions are written with their reason: a noindex on the home is red, and the two broken contact paths (a chat number that does not open, a mail domain that bounces) are yellow. With colours picked by hand, two people mark the same finding differently. Two runs of the same site then cannot be compared, and a report's red stops meaning one thing. A test reads site-check's published example run and checks that this table gives the same colour as site-check's Python table for all 37 of its checks, and the same priority.

**A green needs evidence.** Passed or Fixed with an empty evidence note is grey, with "no evidence note" on the badge and in the report. The method says a green without evidence does not exist; without the rule, a check marked by habit reads the same as one that was measured.

**A count always carries its denominator, and grey stays in it.** The summary says "4 to fix now, of 38 applicable", never "4 problems". The denominator is the checks the profile includes minus the ones marked not applicable. An unmarked check is grey and counted, so a half-done run cannot look clean. The report splits the grey ones into "not marked yet" and "passed without an evidence note".

**Fixed is gated twice.** First, all six pre-change rows must be acknowledged:

- a full backup, restored as a test;
- staging, or one change at a time;
- a maintenance window;
- a written way back;
- the owner told;
- the list of what will be tested.

Second, the check must have failed earlier, in its current state or in the recorded "before". A Fixed set from Fails records that origin in the run JSON. A Fixed on a check that never failed would add a change to the before and after report that never happened. While any check is Fixed, the pre-change rows cannot be unticked. Closing needs every applicable row of the post-change matrix. The payments row is asked only on a store platform, so a brochure site is not blocked by a test it cannot run.

**The runbook is a dependency graph with times.** Each incident step lists the steps it requires, and the build script accepts only requirements that appear earlier in the table. The table order is then always a valid plan and the graph cannot have a cycle. "Real passwords rotated" requires "site isolated", "admin lockout applied" and a second pass with zero indicators. Rotating while a credential collector still runs on the site hands it the new passwords. A step cannot be unticked while a ticked step depends on it. Its time cannot be set before a step it requires, after a step that depends on it, or in the future. Without those checks the generated timeline could show a lockout before the snapshot it depended on. Times are compared to the minute, the precision the time input shows, so a time on screen can always be set back. They are shown, typed and exported in UTC, so the timeline reads the same on every device.

**A loaded run is checked against the rules, not only its shape.** A run JSON from a file, or the run stored in the browser, first passes a shape guard and then `repairRun`. That function undoes what breaks a rule and lists it. A Fixed without the pre-change list, or with no earlier failure, goes back to unmarked with its note kept. A closed run with post-change rows pending is reopened. An incident step ticked before a step it requires is unticked, and so is anything that depended on it. Without this, an edited file could show a password rotation before the lockout, and the report would carry it.

**An import never overwrites a person.** The importer validates `datos.json` field by field. It refuses a file for another domain as a whole (`www.` ignored), so one site's results cannot fill another's run. It keeps any check already marked by hand and lists it. It lists ids the catalogue does not know, checks outside the profile and unreadable entries. A note typed before the import stays, after the imported one. An imported pass gets an evidence note only when site-check recorded a finding or an evidence file, so a pass with nothing behind it stays grey. The site address is taken from the file's canonical URL only when that URL is on the file's own domain.

**Free text never becomes markup.** The DOM layer adds text with `append`, never `innerHTML` ([`src/dom.ts`](src/dom.ts)), and the build test fails if `innerHTML` appears in the bundle. In the Markdown reports every typed or imported string goes through `md()`, which collapses line breaks and escapes the characters that would open a heading, a link, a table cell or HTML. An evidence note such as `## Pwned <img src=x>` stays one line of text.

**IndexedDB, with a memory fallback that says so.** The run is one record in IndexedDB. Opening it can throw (sandboxed frames, some private modes), fail or be blocked by another tab, and each case gives a memory store plus a warning to export the run JSON. A failed write shows a warning once. Writes go through one queue, so a slow earlier write cannot land after a later one and restore an older run. A stored value that fails the run guard is copied under another key before the app starts empty, so an older format is not lost. When the read itself fails, the store refuses every write until a read succeeds. The app says so, and an empty run never replaces one it could not read.

**Colours are measured.** Each state colour, the muted text and the body text have one value per theme, and each reaches 4.5:1 against both the page and the card background. At 4.5:1 the token passes for text (WCAG 1.4.3), so it also clears the 3:1 that state shapes need (1.4.11). On this palette the lowest light-mode ratio is green on the page, 5.51:1. In dark mode it is grey on a card, 6.90:1. The button label measures 11.48:1 and 12.42:1. A test computes every pair and also reads `styles.css`, failing when a CSS value differs from the table it measured. The colour never stands alone: each state has a shape (triangle, square, diamond, circle, empty circle) and a written label.

**Offline first, with a hand-written service worker.** Hashed files under `assets/` are served cache first and everything else network first, with a 3-second timeout. When the host answers a navigation with an error page, the worker serves the cached `index.html` instead. The plugin in [`vite.config.ts`](vite.config.ts) writes the list of every built file and a hash of their contents into `sw.js`, so a new file is precached without editing a list. Cache names include a hash of the scope, so two copies of the app on one origin do not delete each other's caches.

**Every control is reachable and named.** Every control has a label that names its check ("State of EXT-04"). The tabs follow the ARIA tab pattern with arrow keys, Home and End. Focus is always visible and returns to the control that was used after a re-render. Typing evidence updates the badge without rebuilding the row, so the cursor stays put. The counts, the per-check refusal messages and the status line are live regions. While a note is typed the counts wait for a pause or for the box to lose focus, so a screen reader does not read the whole list out on every key. A blocked incident step stays focusable and describes what it needs. Light and dark follow `prefers-color-scheme`, and the layout holds at 360 px with no horizontal scroll (checked with Chromium in both themes).

## Departures from the source

- The catalogue rows are rewritten in English as generic checks, with no commands, no source references and no organisation names. Rows that were about the business rather than the site are left out.
- The source colour table names EXT, INT, SEG and COM as security modules. Here the platform (PLA) and monitoring (OPE) checks are security too, except OPE-08, which is speed, like COM-08.
- site-check's exception that turns a lab-only speed pass green is not carried over, because a hand-marked run has no field-or-lab flag to read.
- The source keeps evidence in a case folder and asks for it by rule; here an empty note turns a green grey automatically.
- The palette is my own, chosen to pass 4.5:1 everywhere, instead of the Lighthouse colours the source uses, two of which do not reach 3:1 on white.
- The runbook's order became explicit dependencies. Password rotation also requires the zero-indicator second pass, which the source asks for as "with the environment inert".

## What the tests cover

| File | Covers |
|---|---|
| `test/catalogue.test.ts` | The committed JSON equals a fresh build; the guard the browser runs; 152 checks per module with unique ids; ASCII and English only; the speed and authorization columns; the six pre-change rows, nine matrix rows and six incident phases; the parser's escaped pipes; six bad source edits refused with file and id (priority, platform, non-ASCII, a later dependency, a wrong id, a missing cell) |
| `test/colours.test.ts` | 17 table cases typed by hand; no evidence makes grey; the three exceptions only on their state; site-check's 37 example checks get the same colour and priority; "4 to fix now, of 38 applicable" and its plural; unmarked counted grey; not applicable leaves the denominator; WCAG contrast on known pairs, every palette pair in both themes, and the CSS equal to the table |
| `test/run-rules.test.ts` | Applicability by platform, feature and authorization; payments only on a store; Fixed refused before the list and on a check that never failed, accepted after a failing "before"; the list locked while a check is Fixed; closing refused until the matrix is done, and a closed run refusing every change; "before" recorded once; the run JSON round trip and nine malformed runs refused; a consistent run left as it is, Fixed included; a Fixed without the list or with no earlier failure, a run closed with rows pending and incident steps ticked out of order, each undone and listed; a closed run's incident log refused; file names |
| `test/incident.test.ts` | "Rotate real passwords" refused before isolation, lockout and the second pass, naming what is missing; the lockout refused before the snapshot; the whole table tickable in order; untick refused with dependants; times before a requirement, after a dependant, in the future or invalid refused; times kept and compared to the minute; the timeline order and elapsed times; the Markdown table with escaped notes |
| `test/import.test.ts` | A fictional `datos.json`: the five states mapped, the evidence note, unknown ids, checks outside the profile and three unreadable entries listed; the site filled in; hand marks kept and typed notes preserved; a pass with no finding or file left without a note and grey; a reason kept only for a check that did not pass; a canonical URL on another host ignored; another domain, another schema version, non-JSON and a closed run refused; site-check's own example run imports all 37 checks |
| `test/report.test.ts` | `md()` escaping; template A with every count and its denominator, the grey split, the reading order, the evidence and the action; an injected heading, link and HTML neutralised; template B's per-colour table, checks passed of the same denominator, the changed states, and the change control record |
| `test/storage.test.ts` | A small fake IndexedDB: save and load, writes kept in order when the first is slower, an invalid stored value copied aside, a failed read refusing writes until a read succeeds, a failed write reported; the memory fallback when IndexedDB is missing, throws, fails or is blocked |
| `test/sw-core.test.ts` | Strategy per request; cache first; network first online, offline, on a host error page and on a hanging network; stale caches of this scope only |
| `test/app.dom.test.ts` | jsdom against the real `index.html`: the initial counts; the profile adding checks; colours as states and evidence change, with focus kept in the evidence box and the counts waiting for a pause; Fixed refused and the select put back; the filters; closing and reopening; "before"; the incident gate, times, notes and untick refusal; the incident inputs disabled and refused on a closed run; importing a `datos.json`, a run JSON and an edited run JSON that is repaired; the three exports; the storage warnings, including an unreadable stored run and a repaired one; the tab keys |
| `test/build.test.ts` | The production build in a temp folder: the files, relative URLs only, no inline script, style attribute, eval or `innerHTML`, a precache equal to every built file, the catalogue shipped as committed |

143 tests, all offline.

## Limits

- **One device, one run.** The run lives in this browser's IndexedDB. There is no sync and no sharing; the run JSON is the copy and the way to move it.
- **The catalogue is the method's, rewritten.** The thresholds come from the method's tables. Several commerce rows have no threshold yet ("measured on the first case"), and the app does not invent one.
- **No measurement of its own.** The app records what a person or site-check found. It sends no request to the audited site, so nothing in it can probe a site without permission.
- **The import reads site-check schema version 1 only**, and only the fields listed in [`src/sitecheck-import.ts`](src/sitecheck-import.ts). Another tool's output needs its own importer.
- **One "before" per run.** It is recorded once. Measuring again for a second before and after means a new run, or exporting this one first.
- **Times come from the device clock.** A wrong clock gives wrong incident times; they can be corrected by hand within the order the dependencies allow.
- **The reports are Markdown.** There is no PDF export, and the reader's renderer decides how the tables look.
