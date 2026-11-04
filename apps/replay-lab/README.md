# Replay Lab

Replay Lab is an installable, offline browser app for [`deterministic-sim`](../../deterministic-sim/), the replayable simulation core. You pick a seed and play a twenty-round dice tournament, with the state, the log and two SHA-256 hashes on screen after every input. A run exports as a file of its seed, ruleset version and inputs. Importing it replays the inputs and reports whether the inputs hash and the final state hash still match. A batch tab plays up to 10,000 runs in a Web Worker and draws the score distribution as an SVG histogram. The point is to make the core's guarantee visible: undo is a replay, an edited file is caught, and the same batch gives the same report hash on any machine. The interface is in English.

Live demo: <https://fedemedinilla.github.io/applied-ai-toolkit/replay-lab/>

## The flow

1. Type a seed (or press Random seed) and Start. The state shows round 0, ten chips and the first house mood, which the seed decides.
2. Roll one to five dice or rest, with the buttons or the keys 1 to 5, R and U. Each round shows the faces, the outcome and the formula with its factors, such as `13 x1.25 x1.1 x1.0 = 17`. A roll the chips cannot pay is disabled.
3. Undo rebuilds the state by replaying every input but the last from the seed. There is no undo stack.
4. Export run shows a download link to `run-<seed>-<hash>.json`. Choosing that file under "Replay a run file" replays it and loads the run. Changing one `"dice"` value in the file before importing it marks both hashes as not matching.
5. In the Batch tab, choose the number of runs, the dice per roll and a seed prefix, and press Run batch. A progress bar fills while the worker plays; Cancel stops it. The result is a table of min, p10, p50, p90, max and mean for score, busts and chips left, the histogram, the same bins as a table, and the report hash. Chips left is the same in every run of a fixed-dice policy, since chips depend only on the inputs; it is reported for policies that react to the dice.

## Run it

From the repository root:

```sh
npm ci
npx vitest run apps/replay-lab                              # offline, about 3 seconds, includes a production build
npx vite build --config apps/replay-lab/vite.config.ts      # writes dist/apps/replay-lab
npx vite preview --config apps/replay-lab/vite.config.ts    # serves the build at http://localhost:4173
npx vite --config apps/replay-lab/vite.config.ts            # dev server with reload; no service worker in dev
node csp-build-guard/cli.ts --dir dist/apps/replay-lab --config apps/replay-lab/csp-guard.config.json
node apps/replay-lab/scripts/icons.ts                       # redraws the icons in public/
```

The output uses relative URLs only (`base: './'`), so it works at a domain root or under a subpath. The service worker needs `localhost` or HTTPS.

The current build (Vite 8.3.4) writes 25.42 kB of page JavaScript, 10.18 kB gzipped. Beside it are a 12.92 kB worker, 5.29 kB of CSS and a 2.06 kB service worker. [`csp-build-guard`](../../csp-build-guard/) passes on it with [`csp-guard.config.json`](csp-guard.config.json). It checks the strict policy a host should send (`'self'` only, no inline script or style), the absence of regex lookbehind, and the page's JavaScript at 10.1 kB gzipped against a 20 kB budget.

## Design decisions

**The page computes no rule.** Every number on screen comes from the core through its public entry. That covers the state, the formula factors (the log entry's `multipliers` and `rollSum` of its faces), the next streak multiplier (`heatPermille`), which buttons are enabled (`canApply`, which accepts exactly what `advance` accepts), the hashes and the batch statistics. Round and chip limits come from `rulesFor(state.rulesetVersion)`, the ruleset the run names, not the newest one. A second copy of a rule in the UI would drift from the core, and the screen would then show a number that does not replay.

**Undo is a replay.** [`src/session.ts`](src/session.ts) keeps the seed and the inputs. Undo replays all inputs but the last, so the feature only works if replay is exact, and the tests check the result against `replay()`.

**Import verifies before it trusts.** The page refuses a file larger than 64 KB from its size, before reading it, and [`src/run-file.ts`](src/run-file.ts) refuses it again for direct callers, along with one that is not JSON. It then calls the core's `verifyRun`, which parses the record strictly, replays it and compares both stated hashes with recomputed ones. The result names each hash as matching, not matching or not stated, with the recomputed value, and shows "OK" or "Problem" in text as well as in colour. A file whose inputs are illegal at some round (rolling with no chips) is refused with the reason the core gave.

**Batches run in a worker, one worker per batch.** 1,000 runs took between 363 and 542 ms in headless Chromium on this machine. That is long enough to freeze input handling on the main thread, so [`src/batch-worker.ts`](src/batch-worker.ts) plays them. Cancel terminates the worker, which stops the loop at once; a cancel flag would wait for the loop to read it. The job itself is a plain function ([`src/batch-protocol.ts`](src/batch-protocol.ts)) that the tests run in process, and its report equals the library's `runBatch` for the same request.

**The same batch, the same hash, in two engines.** The 1,000-run reference batch (seed prefix `batch`, three dice) gave report hash `872e88eea3451bb8...` in this app's worker in Chromium and from `node deterministic-sim/batch.ts --runs 1000` in Node 24.

**A histogram that works under a strict CSP and in both themes.** [`src/histogram.ts`](src/histogram.ts) builds the SVG with `createElementNS` and attributes only. An inline `style` would need `'unsafe-inline'`, and a test checks there is none. Bars use `currentColor`, so the colour comes from CSS for light and dark. The SVG has a title and a description naming the tallest bin, each bar has a tooltip, and the same bins are in a table under a disclosure.

**Progress announced by quarters.** The worker reports every 50 runs. The progress bar takes each report, but the `role="status"` line changes only at each quarter, so a screen reader is not read twenty updates.

**The app's own validation messages.** The batch form has `novalidate`, so a run count of 20,000 gets "Not started: runs must be a whole number from 1 to 10,000." in the status line. That is the message the worker would send. A browser bubble differs between browsers, and some screen readers skip it.

**Offline with a hand-written service worker.** [`src/sw-core.ts`](src/sw-core.ts) holds the decisions and [`src/sw.ts`](src/sw.ts) wires them to the events. Hashed files under `assets/` are served cache first. Everything else goes to the network first with a 3-second limit, so a new build is picked up and a dead connection still opens the app. The plugin in [`vite.config.ts`](vite.config.ts) writes the list of every built file and a content hash into an unhashed `sw.js`. The build fails if index.html or the batch worker is missing from that list, because an offline batch would otherwise fail on the first run.

**Text in, never markup.** Seeds, file names and file contents reach the page through text nodes only (`h()` in [`src/dom.ts`](src/dom.ts)). A seed like `<img src=x onerror=...>` shows as those characters.

**Accessible at 360 px.** Every control has a label. The tabs follow the ARIA tab pattern with arrow keys, Home and End, and focus is always visible. The play status and the import result are live regions. A one in a roll is marked by border and colour, a bust by its label and a side rule. Light and dark follow `prefers-color-scheme`. At 360 px wide the page has no horizontal scroll, which the check below measured in both themes.

## What the tests cover

| File | Covers |
|---|---|
| `test/session-file.test.ts` | Inputs applied through the core, undo equal to a replay, both hashes; the exported file and its name, a round trip that verifies, an edited input caught, non-JSON and oversized files, seed slugs |
| `test/batch-protocol.test.ts` | Progress every 50 runs and a report equal to the library's `runBatch`, with its hash; bad requests answered with one error and no runs |
| `test/histogram.dom.test.ts` | Bin edges, tick spacing, one bar per bin scaled to the tallest, the title, description and tooltips, no inline style |
| `test/sw-core.test.ts` | Strategy per request, cache first, network first online and offline, a navigation with a query served the cached index.html, a hanging network after the timeout, a host error page replaced by the cached app, a full cache, stale cache cleanup |
| `test/app.dom.test.ts` | jsdom against the real `index.html`: start, an empty seed refused, rolls equal to a replay, unaffordable rolls disabled, undo, keyboard shortcuts from the Start button and their limit to non-text targets, a seed that looks like markup shown as text, a full game to the end, Random seed; export, the download link revoked by the next input, import with both hashes matching, an edited file with both failing, an illegal run refused with the reason, an oversized file refused without being read; a batch with histogram, table and report hash, the same hash twice, an out-of-range count, progress by quarters, Cancel, a worker error; tabs by keyboard; a label for every control |
| `test/build.test.ts` | The production build into a temporary folder: the manifest and icons, relative URLs, the batch worker emitted and referenced, `sw.js` a classic script with its placeholders replaced, a precache equal to every file in the output |

62 tests, offline. Beyond the suite, I loaded the built app in headless Chromium at 360 by 800 px, in light and in dark. Each pass played six rounds with the keys and the buttons, exported the run and ran a 1,000-run batch. The page width stayed at 360 px, the service worker registered, and the console showed no errors.

## Limits

- **The hashes detect changes, not forgery.** Someone who edits a file can recompute both hashes. The import check shows that a file was changed by hand or saved under other rules; trusting a reported score needs a replay on a machine you control.
- **One device.** Runs are not stored; a reload starts over. A run survives as an exported file.
- **10,000 runs at most per batch.** The worker holds every final state until the report is built. The library allows 100,000 from Node.
- **One policy family.** The batch tab offers "roll n dice whenever the chips allow". Other policies exist only in code.
- **Not tested in a real phone browser.** The checks ran in jsdom and in headless Chromium; installation and offline start on iOS and Android were not tried.
- **No host config.** There is no deploy file. The CSP in `csp-guard.config.json` is the policy a host should send, checked against the build, not one the app sends itself.
