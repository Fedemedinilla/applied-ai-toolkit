# site-check

site-check reads a public website the way a visitor's browser does and writes a plain-language report on its security, speed, search visibility and contact paths. It is built around two constraints. It has to stay legal without the owner's permission, so a scope guard in the network layer refuses any request a visitor would not make. Every sentence of the report has to be reproducible, so 37 fixed rules turn measurements into pre-written text, and `--rerender` rebuilds a report byte for byte from its stored run, `run.json`. There is no language model in the loop, on purpose. The reader acts on these sentences without being able to check them, so each one has to come from a measurement that someone else can check. `--compare` turns two stored runs into a before/after report (see Before and after).

Python standard library only: about 23,000 lines in `sitecheck/` and 693 tests that run offline against a fake site and fake APIs on 127.0.0.1.

The command line, the console messages, the file names and the stored run are in English. The report is written in Spanish (Argentina, formal "usted") by default, because the tool was built for small Argentine organisations such as schools and SMEs. `--lang en` writes it in English, in a shorter form (see Report language). The operator notes that the console repeats from the stored run are in Spanish.

## What it measures

| Area | Checks |
|---|---|
| Security seen from outside | TLS certificate valid and not about to expire (EXT-07), domain expiry from RDAP (EXT-13), one canonical https address with and without www (EXT-17), mixed content (EXT-16), the six browser protection headers (EXT-01), SPF, DKIM and DMARC of the domain (EXT-05), Spamhaus DBL listing (EXT-23), visible WordPress version against the official stable-check API (EXT-02), server software versions in headers (EXT-09), spam pages injected into the site (EXT-24), privacy policy (EXT-25) |
| Speed | real-user LCP, INP and CLS from Chrome UX Report, with the Lighthouse lab median as fallback (EXT-08), page weight and third-party share (EXT-21), time to first byte against a control site measured at the same moment (EXT-20), HTTP/2 (TLS ALPN) or announced HTTP/3, and compression (EXT-18), a cache or CDN in front of the site (EXT-19) |
| Visibility | noindex and robots.txt blocks (VIS-01), sitemap (VIS-02), canonical URLs (VIS-03), title and description (VIS-04), headings (VIS-05), the WhatsApp/social preview (VIS-06), structured data (VIS-07), hreflang (VIS-08), broken links on the home (VIS-09), page language (VIS-14) |
| Accessibility | contrast and focus (VIS-10), image alt text (VIS-11), viewport and zoom (VIS-12), form labels and tap targets (VIS-13) |
| Contact and upkeep | a tap-to-call or WhatsApp link (VIS-15), signs of neglect such as an old footer year or stale news (VIS-16), admissions link for schools (VIS-17), WhatsApp numbers written so WhatsApp can open them (VIS-18), template leftovers (VIS-19), code written for Internet Explorer or Flash (VIS-20), published e-mail addresses whose domain cannot receive mail (VIS-21) |

The report header also carries the four Lighthouse category scores for mobile and desktop. That header is not a check.

## Passive only, and why

Testing a system without authorization is a crime in Argentina (Penal Code, art. 153 bis, added by Ley 26.388). So the tool only reads what any visitor sees, and the boundary is enforced in code, not by convention:

- **A scope guard sits in front of every connection** (`sitecheck/scope.py`). Every HTTP request, every redirect hop, the TLS handshake, the DNS blocklist lookup and every API call asks it first. On the target it admits the home and its www/https variants, robots.txt, the sitemaps robots.txt declares, the feed the home links, and pages the home links with `<a href>`. Off the page it admits the og:image the home declares, on any host that is not on the exclusion list, since that is what WhatsApp fetches for the preview. It also admits the first child of a sitemap index, the three standard sitemap paths only when robots.txt declares none, and one TLS handshake per site host. Outside the target it admits the API hosts, the control URL (path `/` only), the rdap.org redirect to the authoritative RDAP server, and the two Spamhaus DNS names. The site and the control get GET only; only the CrUX and Observatory APIs get POST. Everything else raises `ScopeError` and the run stops with exit 50 before anything is sent.
- **Paths that only an attacker or a scanner would ask for are denied even when linked**: `/wp-admin`, `wp-login.php`, `xmlrpc.php`, `/wp-json`, `?author=`, `/author/`, user sitemaps, `readme.html`, `license.txt`, sensitive files and 404 probes. A redirect the site itself issues to one of those paths is refused without raising, and the run goes on.
- **One request at a time, with a pause of at least 3 seconds, and at most 90 requests to the site.** `--pause` can only make the pause longer and `--max-requests` can only lower the budget.
- **An anti-bot challenge or a "slow down" answer (429, 503 with Retry-After) stops the site phase.** The tool waits once, retries that URL once, and cuts the host on the next signal.
- **A request to a host the tool did not choose connects only to a public address it resolved first.** A DNS answer cannot point the tool at a private network (DNS rebinding, SSRF). That covers the site, the control, the og:image and the RDAP server rdap.org redirects to, which must also be an https name on port 443. The fixed API hosts are the only ones left to the system resolver.
- **One fixed, honest User-Agent** with a link to this repository, never rotated after a block, so a site owner who sees it in the logs can find out what it is and what it reads.
- **Personal data is not collected.** RDAP holder data is dropped, and only the last four digits of a WhatsApp number are kept. A published e-mail address is kept only when it is an institutional role address (`info@`, `secretaria@`, `admisiones@`). Paths that can carry a person's name (`/author/<user>/`) are masked in the evidence. The next run deletes raw evidence older than 30 days.
- **An exclusion list is checked before any request.** A site owner who asks not to be measured goes on it, and an excluded domain gets zero requests and exit 10. The list never fails open. A list named with `--exclude` or `SITE_CHECK_EXCLUDE` that does not exist is exit 2, and a line that cannot be read as a domain stops the run. Only the default `<out>/exclude.txt` may be absent. A domain with ß, ς or an invisible joiner is refused, on the command line and in the list, and has to be written in its `xn--` form. Python converts those characters differently from a browser, so `faß.de` would turn into `fass.de`, which is another domain.

## Architecture

The flow is collect, observe, evaluate, render. Each stage has a single input type, so the stages are tested apart.

```
cli.py          argparse -> RunConfig (frozen)
pipeline.py     the run end to end, exit code, run.json
  services.py   wires the network objects; the only place where test mode changes behaviour
  collect.py    COLLECT: PageSpeed first, then DoH, RDAP, DBL, then the site phase
    scope.py      the scope guard (allow-list, deny patterns)
    httpclient.py one request at a time: pacing, budget, manual redirects, decoding, address pinning
    challenge.py  anti-bot detection
    psi.py crux.py doh.py rdap.py dbl.py tlsprobe.py wpapi.py   one client per public service
    artifacts.py  every measurement is written to evidence/ as soon as it is obtained
  observations.py OBSERVE: everything measured in one run; the only input of the checks
  evaluate.py   EVALUATE: run the 37 evaluators, then the evidence gate, then the colours
    registry.py   the 37 checks: ID, priority, flags, evaluator
    checks/*.py   pure functions Observations + EvalContext -> Finding
    gate.py       no finding without the file that proves it
    colours.py    a fixed table plus documented exceptions, then --overrides
  render_report.py RENDER: report.md and technical-annex.md
    i18n.py       the report strings, from catalogs/es.json and catalogs/en.json
  textlint.py   control of the report text before the run ends
  runformat.py  the names of run.json, and the migration of older runs
  sarif.py      --sarif
```

The data model lives in `sitecheck/model.py`. A `Finding` has a state (`pass`, `pass_with_note`, `fail`, `not_applicable`, `not_verified` in `run.json`), the raw measured values and the evidence files. It carries the report sentence in four columns: what was found, what can happen, what to do, who does it. Its trace names, for each measured number the sentence prints, the key in `run.json` that holds it (`checks[EXT-07].measured.calendar_days`). The colour is derived from the state, the module and the priority, never chosen by eye.

Inside the package the rules keep the Spanish names they were written with (`State.FALLA`, `mediciones`). `sitecheck/runformat.py` translates at the file boundary, in both directions, and refuses to write a run that would not read back the same.

## Determinism and traceability

- Evaluators are pure: no network, no clock other than the run date, no file access. Missing data becomes `not_verified` with a stated reason, never a guessed number.
- Every sentence is written in full in the code, per case, including singular and plural. Nothing is assembled from fragments that could disagree in gender or number.
- `run.json` keeps the measurements, the evidence list, the state, the colour and the filled sentences. `--rerender run.json` rebuilds the report from it with zero requests, and the result is byte-identical. A colour override needs a written reason, and both the derived and the final colour stay in `run.json`.
- One clock (`fmt.now_utc`) feeds the run date and the day counts of the certificate and the domain, so a sentence such as "vence el 11 de diciembre de 2026, en 58 días" cannot mix two instants.
- A test runs the same observations twice with a fixed clock and compares `run.json`, `report.md` and `technical-annex.md` byte by byte.
- On the full fake-school run, a test reads every number the report sentences print. Each one must be either a fixed threshold of its rule or the rendering of a value its trace points at. The fixed thresholds are listed by hand in the test, such as Google's LCP threshold of 2.5 seconds, printed "2,5". Every trace must resolve to a stored value. Traces are written per case in the evaluators; the test covers the cases the fake school triggers (13 of the 37 checks print a measured number there), not every branch of every rule.
- `examples/` is rebuilt by `examples/make_example.py` with a fixed clock, and a test checks that a fresh build matches the committed files byte for byte.

## Design decisions

- **Standard library only.** The tool is meant to run on any machine with Python, with nothing to install. The CLI refuses to run if any module outside the standard library was loaded, and `python3 -I -S site_check.py` proves it. This is also why there is no XML parser for sitemaps (regular expressions over a capped body) and no Public Suffix List package (the Argentine suffixes and the hosting platforms are embedded).
- **PageSpeed runs before the first request to the site.** Google loads the site from its own servers, so if the site later blocks this tool, the speed numbers still stand.
- **Three mobile PageSpeed runs, and the median is used.** Lighthouse results vary between runs; the middle of three is steadier than any single run.
- **Real-user data wins over lab data.** LCP, INP and CLS come from Chrome UX Report when Google has it; a lab-only result is labelled as such in the report.
- **The three measurements that compare against something outside the site have a control.** TTFB is measured against a control site at the same moment, and the mail DNS answers are checked against a control domain that is known to publish SPF, DMARC and MX. Before it trusts a "not listed", the Spamhaus lookup also asks the documented test point (RFC 5782). If the control fails, the check is grey, because the instrument failed and not the site. RDAP, PageSpeed, TLS and the HTML reads have no control; their failures become grey with the reason.
- **Grey is a first-class result.** `not_verified` lists why the check could not see (an anti-bot page, a truncated body, a refused DNS lookup), and the report has a section for it. A green without its evidence file is downgraded to grey by the evidence gate (`gate.py`).
- **The evidence gate also guards against false failures.** A failure read from the HTML (no WhatsApp button, no viewport) needs a home that is really the home. That means status 200, an HTML body that arrived whole, and no challenge page, meta-refresh or JavaScript wrapper, or empty single-page-app shell. Otherwise it turns grey.
- **The hack gate.** Spamhaus abuse codes or spam pages injected into the site set a flag, the exit code becomes 30 and the report leads with "check the site in depth before any other change". The spam detector needs strong terms or repeated signals, because words like "casino" or "apuestas" are ordinary Spanish.
- **Speed failures are yellow, never red.** A slow site is worth fixing, not an emergency. Red is reserved for things that break the site or put its visitors at risk.
- **Report text is linted** (`textlint.py`). It rejects em and en dashes, unfilled placeholders, e-mail addresses from the site, secrets, and Markdown links or HTML tags taken from the site. It also rejects voseo and the words "certificado" and "inseguro", because a non-technical reader takes a "certificado" for a legal document, and "inseguro" alarms without saying what to do. A problem is exit 4. The report is still written, and every problem is listed on the console and in `run.json` so it can be fixed in the code and the report rerendered.
- **The PageSpeed key comes only from `PAGESPEED_API_KEY`.** It travels only in the `X-goog-api-key` header, never in a URL, and a redactor scrubs every log line, evidence file and `run.json`. A final sweep deletes any output file that still contains it. In test mode the real key is ignored, so a test hook can never send it to a fake server.

## How to run

Requires Python 3.11 or newer. Python 3.14 adds zstd decoding; on older versions the tool does not offer zstd.

Install: **not yet published.** `pyproject.toml` declares the distribution `site-check-passive` with the console command `site-check`, but nothing has been uploaded to PyPI and the name has not been checked there. Until it is, run it from a checkout, which needs nothing installed:

```bash
cd site-check

# Offline: the test suite against the local fake site (no network, no key).
# The tests import their harness (support.py, fakesite.py) as top-level modules,
# so discovery starts in tests/, without "-t .".
python3 -m unittest discover -s tests -q

# Offline: rebuild examples/ from a run against the fictional school
python3 examples/make_example.py

# A real run (makes network requests to the site, to the control site and to public APIs)
export SITE_CHECK_CONTROL_DOMAIN=your-own-site.example   # required, see below
export PAGESPEED_API_KEY=...        # optional; without it PageSpeed has a lower quota
python3 -I -S site_check.py https://www.example.org/ --name "Example School" --kind school --out ./runs

# The same run with the report in English, the stored run on stdout and a SARIF file
python3 -I -S site_check.py https://www.example.org/ --lang en --json --sarif ./example.sarif > run.json

# Rebuild the report of an earlier run, with zero requests
python3 site_check.py --rerender ./runs/example.org/2026-10-14/run.json

# Compare two stored runs (folders or run.json files), with zero requests
python3 site_check.py --compare ./runs/example.org/2026-10-14 ./runs/example.org/2026-11-18

# Offline: rebuild examples/after/ (the improved school) and its comparison
python3 examples/make_compare_example.py
```

Once the package is installed, `site-check` and `python3 -m sitecheck` take the same arguments as `site_check.py`. From the repository root, `npm run test:python` runs the same test command.

| Option | What it does |
|---|---|
| `URL` | the home page of the site, http or https, without a path |
| `--name NAME` | the organisation's name, for the title check and the report header |
| `--kind KIND` | `school`, `institute`, `kindergarten`, `company` or `organisation` (default). It chooses the noun the Spanish report uses and whether the admissions check applies. With `--rerender` it may change the noun only: a kind that would change whether the admissions check applies is exit 2, because the stored run has no data to evaluate that check again. The Spanish nouns are accepted too: `colegio`, `escuela`, `instituto`, `jardín`, `empresa`, `institución` |
| `--to TEXT` | who the report is addressed to (default "Dirección", or "Management" with `--lang en`) |
| `--lang LANG` | report language, `es` (default) or `en`; see Report language |
| `--inner-page URL`, `--form-page URL` | an inner page and a page with a form; each is read only if the home links it |
| `--psi-runs N` | mobile PageSpeed runs, 1 to 5 (default 3; the median is used) |
| `--no-pagespeed` | skips PageSpeed and CrUX; the speed checks stay grey |
| `--observatory` | also asks MDN Observatory. Off by default because it makes a third party scan the site |
| `--pause SECONDS`, `--max-requests N` | a longer pause (3 to 60) and a lower request budget (1 to 90) |
| `--json` | prints the stored run, the exact text of `run.json`, on stdout; the console summary moves to stderr |
| `--sarif FILE` | also writes the rules that did not pass as SARIF 2.1.0; see Machine output |
| `--overrides FILE` | colour overrides, each with its reason: `{"EXT-09": {"colour": "blue", "reason": "..."}}` |
| `--rerender RUN_JSON` | rebuilds the report from a stored run. It keeps the earlier file as `run-N.json` and writes the new `run.json`, `report.md` and `technical-annex.md` |
| `--compare BEFORE AFTER` | compares two stored runs; see Before and after |
| `--out DIR` | output root (default `$SITE_CHECK_OUT`, else `./site-check-runs`) |
| `--exclude FILE` | the exclusion list, which must exist (also `SITE_CHECK_EXCLUDE`); `<out>/exclude.txt` is read too when present |

`SITE_CHECK_CONTROL_DOMAIN` names the control site for the TTFB and DNS comparisons, and a real run refuses to start without it (exit 2). There is no default because the control gets three GET requests and a few DNS questions on every run, so it has to be a site you own. Without SPF, DMARC and MX records on it, EXT-05 turns grey.

A run leaves `<out>/<domain>/<date>/` with these files:

- `report.md`, the report;
- `technical-annex.md`, the state of each check, the broken link addresses and the manual checks;
- `run.json`, every measurement, state, colour and sentence;
- `00-time.txt`, the start and end time of the run (Buenos Aires time);
- `evidence/`, every response and API answer the states rest on, plus `requests.log` with one JSON line per request.

`examples/` holds the report, the annex and `run.json` of a run against the fictional school on 14/10/2026. `examples/after/` holds the same school on 18/11/2026, after the fixes listed in `tests/comparefixtures.py`, and `comparison.md` between the two. `examples/datos.json` is the first run in the format of earlier versions; see Runs of earlier versions.

| Exit | Meaning |
|---|---|
| 0 | report written |
| 1 | unexpected error (traceback on stderr, key redacted) |
| 2 | invalid options, a missing control domain, or a missing or unreadable exclusion list |
| 3 | the home did not answer, or an anti-bot check blocked it from the first request |
| 4 | the report text failed the control (the report is written; the problems are listed) |
| 5 | `--compare`: the two runs were taken with different tools or conditions (nothing written; the reasons are listed) |
| 10 | the domain is on the exclusion list (no request made) |
| 30 | signs that the site was compromised |
| 50 | the scope guard refused a request the tool itself built (a bug; the run aborts) |

## Report language

`--lang es` is the default and is what the tool printed before the option existed: without `--lang`, a report is byte for byte the same. The strings of the report frame (headings, counts, fixed paragraphs, labels) live in `sitecheck/catalogs/es.json` and `en.json`. A test checks that both files have exactly the same keys and that each key has the same placeholders.

The sentences of the 37 rules are not in the catalogs. Each one is written in full in its evaluator, per case, in Spanish, and stored in `run.json` as printed. Translating them means writing every case of every rule again, with its own tests, and that has not been done. So `--lang en` does not print them:

- `report.md` states each rule that did not pass with its English name, one fixed sentence on what the rule looks at, and the result ("Fails", "Passes, with a note"). The green and grey folds list the rules by name. The counts, the Google scores, the next step and the fixed paragraphs are in English.
- `technical-annex.md` adds a table of every number and yes/no value each check stored, under its name in `run.json`, so the figures are available without a Spanish sentence around them. A test reads that table back against `run.json`.
- The speed and mail tables are not printed; their rows are Spanish text and stay in `run.json` under `tables`.

A run records its language in `meta.report_language`, and `--rerender` keeps it unless `--lang` asks for the other one. `--compare` writes its report in Spanish only.

## Machine output

`run.json` is described by [`schema/run.schema.json`](schema/run.schema.json) (JSON Schema 2020-12, `schema_version` 2). Its objects are closed, except `measured`, which has one set of keys per check. A test validates both example runs against the schema with a small validator in `tests/minischema.py`, since the tool takes no dependency. `--json` prints that same document on stdout.

`--sarif FILE` writes SARIF 2.1.0 from the stored run, so the same run always gives the same bytes. Each rule that did not pass is one result, and its level comes from its colour:

| Colour in `run.json` | Report label | SARIF level |
|---|---|---|
| `red` | Fix now | `error` |
| `yellow` | Review | `warning` |
| `blue` | Optional improvement | `note` |
| `green`, `grey`, `hidden` | fine, could not be seen, not applicable | no result |

A grey rule could not be checked, which says nothing about the site, so it gives no result; the run's `properties` carry the count. The SARIF log lists a rule by its state and takes only the level from its colour, so an override cannot turn a passed rule into a warning. A failed rule that an override coloured green is left out too, and `properties.notPassedWithoutResult` counts it. The location of every result is the page that was checked: `artifactLocation.uri` is the canonical URL of the run, or the input URL when the home never answered. A web page has no lines, so there is no region, and GitHub code scanning lists such a result without attaching it to a file. The message is the text the report of that language prints for the rule: the stored sentence with `--lang es`, the fixed description with `--lang en`. `partialFingerprints` hashes the rule id and the URL.

## Runs of earlier versions

Before this version the tool wrote `datos.json` with Spanish keys and values (`schema_version` 1), next to `informe.md`, `anexo-tecnico.md`, `00-tiempo.txt` and `evidencia/`. Those runs still work:

- `--rerender old/datos.json` reads the old run, leaves every old file as it is, and writes `run.json`, `report.md` and `technical-annex.md` next to them. That is the migration command.
- `--compare` takes an old run and a new one, in either order. A folder that holds both files is read from `run.json`.
- The 30-day evidence retention deletes `evidencia/` as well as `evidence/`.
- An `--overrides` file with the keys `color` and `motivo` and Spanish colour names (`"azul"`) is read the same way as one with `colour` and `reason`.
- A file with any other `schema_version`, or with none, is refused with exit 2 and the versions the tool reads.

The migration is a rename by position, and `sitecheck/runformat.py` holds every table. The main ones:

| `datos.json` (version 1) | `run.json` (version 2) |
|---|---|
| `encabezado`, `tablas`, `resumen`, `senales_hackeo`, `salida` | `header`, `tables`, `summary`, `hack_signals`, `output` |
| `meta.dominio`, `url_canonica`, `url_interna`, `institucion`, `tipo`, `para` | `meta.domain`, `canonical_url`, `inner_url`, `organisation`, `kind`, `to` |
| `meta.inicio_utc`, `fin_utc`, `version_script`, `version_lighthouse` | `meta.started_utc`, `finished_utc`, `tool_version`, `lighthouse_version` |
| `meta.corridas_psi.pedidas`, `validas`, `computadora_valida` | `meta.psi_runs.requested`, `valid`, `desktop_valid` |
| `meta.alcance`, `sin_pagespeed`, `max_pedidos`, `modo_prueba`, `sitio_cortado`, `portada_no_respondio` | `meta.scope`, `no_pagespeed`, `max_requests`, `test_mode`, `site_cut`, `home_unreachable` |
| `checks[].nombre_llano`, `modulo`, `prioridad`, `estado` | `checks[].name`, `module`, `priority`, `state` |
| `checks[].color_derivado`, `color_final`, `motivo_ajuste` | `checks[].derived_colour`, `colour`, `colour_reason` |
| `checks[].mediciones`, `evidencia`, `trazas`, `motivo`, `nota` | `checks[].measured`, `evidence`, `traces`, `reason`, `note` |
| `checks[].frase_informe_llena.que_se_encontro`, `que_puede_pasar`, `que_se_hace`, `quien` | `checks[].sentence.found`, `consequence`, `action`, `who` |
| states `APROBADO`, `APROBADO_CON_OBSERVACION`, `FALLA`, `NO_APLICA`, `NO_VERIFICADO` | `pass`, `pass_with_note`, `fail`, `not_applicable`, `not_verified` |
| colours `rojo`, `amarillo`, `azul`, `verde`, `gris`, `oculto` | `red`, `yellow`, `blue`, `green`, `grey`, `hidden` |
| priorities `Crítica`, `Alta`, `Media`, `Baja` | `critical`, `high`, `medium`, `low` |
| `comparacion.md`, `comparacion.json` (`antes`, `despues`, `filas`, `transiciones`, `quedan`) | `comparison.md`, `comparison.json` (`before`, `after`, `rows`, `transitions`, `still_open`) |

The Spanish keys inside `measured` are renamed too (`dias_calendario` becomes `calendar_days`), and the traces follow them. Version 1 did not record a report language, so a migrated run gets `meta.report_language: "es"`. Four things keep their Spanish form in version 2, because they are data and not names: the report text (`sentence`, `reason`, `note`, `label`, the table rows, `conditions`, `tools`), the placeholder names in `traces` (`{dias}`), code values inside `measured` (`scope: "laboratorio"`) with `meta.kind`, and the evidence file names.

`examples/datos.json` is the example run in the old format. A test checks that it migrates to exactly `examples/run.json`, and that `run.json` exports back to exactly that file. It is also the file the checklist app under `apps/checklist` imports.

## Before and after

`--compare BEFORE AFTER` reads two stored runs of the same site and writes a before/after report, `comparison.md`, with its numbers in `comparison.json`, into the AFTER folder. It makes no request and reads no clock, so the same two stored runs always give the same bytes. Both runs must come from the same site-check and Lighthouse versions and the same options, with three or more valid mobile PageSpeed runs, so the lab rows are medians. Mobile and desktop rows stay separate. Real-user rows never take a lab value, and each table names its cache condition. Time to first byte is compared only when the control site answered on both dates. The report has these rows.

- real-user LCP, INP and CLS on mobile from Chrome UX Report, with a heading that says whether Google gave data for the home page or for the whole site;
- the lab mobile score and lab LCP, both from the median run, and the desktop score, labelled as one run;
- time to first byte, with the control site's median next to it;
- page weight and the third-party share;
- how many of the six browser protection headers are set, and the MDN Observatory grade when both runs asked for it;
- the three mail authentication rows (SPF, DKIM, DMARC), each marked as added, removed, better, worse or changed;
- checks passed over applicable, per module and in total;
- every check that changed colour, grouped as improved, worse, or other (to or from grey);
- what is still not green on the AFTER date, by colour.

Each value in `comparison.json` names where it lives in its own run, in the trace notation of `model.py`. `checks[EXT-08].measured.lcp_ms` is the `measured.lcp_ms` of the check whose id is EXT-08. `tables.mail.rows[2].value` is the third mail row of that run. A cell without a value has no trace.

**Runs taken with different tools or conditions are refused.** Any difference refuses the comparison with exit 5 and writes nothing, and every reason is listed. A key that one run does not record is a reason of its own, so a truncated or hand-made `run.json` cannot pass because two missing values look equal.

| Condition | `run.json` key | Why a difference moves a number |
|---|---|---|
| domain and measured page | `meta.domain`, `meta.canonical_url` | another site |
| inner page read | `meta.inner_url` | other content checks read another page |
| site-check version | `meta.tool_version` | other rules, other colours |
| Lighthouse major version | `meta.lighthouse_version` | other scoring |
| PageSpeed on or off | `meta.no_pagespeed` | speed checks grey on one date only |
| mobile runs asked and valid | `meta.psi_runs.requested`, `.valid` | another median; fewer than three, or an even count, has no middle run and is refused even when both dates match |
| desktop run valid | `meta.psi_runs.desktop_valid` | a desktop score on one date only |
| MDN Observatory asked | `meta.scope.observatory` | a grade on one date only |
| request budget | `meta.max_requests` | fewer links read |
| kind of organisation | `meta.kind` | other checks apply (admissions for schools) |
| test mode | `meta.test_mode` | a fake site compared with a real one |
| run cut or home down | `meta.site_cut`, `meta.home_unreachable` | checks that did not see the site |
| order of the runs | `meta.started_utc` | AFTER must be later than BEFORE |

The other errors it guards against, and how.

- **Lab data shown as field data.** A run without Chrome UX Report data stores its lab LCP in the same `lcp_ms` key with `scope: "laboratorio"`. The field rows read that key only when the scope is `pagina` or `origen`; otherwise the cell says "sin datos de campo" and the row is not compared. Page-level and origin-level field data are not compared with each other either.
- **A change column that contradicts its cells.** The change is the difference of the two printed numbers, not of the raw values. 2949 ms and 2951 ms print as "2,9" and "3,0" seconds (decimal comma), so the change is 0.1 seconds more. 2860 ms and 2940 ms both print "2,9", so the change column says "sin cambio".
- **A change in the instrument read as a change in the site.** Time to first byte is compared only when EXT-20 had a valid control on both dates, and the control medians are printed in the next row.
- **A grey check counted as passed.** `not_applicable` leaves the denominator; `not_verified` stays in it and never counts as passed. A check that turns grey is listed under other changes, never as improved or worse.
- **Field data that still holds the old site.** Chrome UX Report covers the 28 days before each run. When the two runs are fewer than 28 days apart, the report says that the AFTER numbers still include visits from before the change.
- **An option that looks like it did something.** `--compare` takes no other option. A URL, a measurement option such as `--observatory` or `--psi-runs`, or an output option such as `--lang`, `--json` or `--sarif` is a usage error (exit 2).

The report goes through the same text control as `report.md` (exit 4 on a problem, files written). Its shape follows the before/after version of the report template the tool was built with. It leaves out the two parts only a person can write, what was done on the site and what to do next.

## How the tests work

`tests/support.py` replaces `socket.connect` and `getaddrinfo` for the whole test process: any connection or name lookup that is not loopback raises. No test can reach a real site or a real API, whatever the code under test does.

`tests/fakesite.py` is a threaded HTTP server on 127.0.0.1 that plays a website and records every request. `tests/sitefixtures.py` describes a fictional WordPress school under the reserved `.test` TLD. It carries a hand-written list of the URLs the tool may request, and another of URLs it must never request, such as the login page, the REST API and author pages. `tests/fakeapis.py` plays PageSpeed, CrUX, DoH, RDAP, the WordPress stable-check and Observatory. It also stands in for the TLS handshake and the Spamhaus DNS lookup. Two hidden CLI flags (`--test-loopback`, `--test-services`) route the real CLI to them, and they only accept a `.test` URL and loopback addresses.

What the tests cover:

- the scope guard case by case, and end to end. After a full run the fake site's request log holds no forbidden URL and nothing outside the allowed set, PageSpeed ran before the first site request, and the budget held;
- the HTTP client: pacing, budget, manual redirects, decoding bombs, slow-drip servers, the total deadline, address pinning, the challenge cut;
- every check against hand-made pages, with expected sentences typed by hand, never computed with the code under test, and a control case for each rule;
- the evidence gate, the colour table and its exceptions, the text control;
- the full CLI against the fake site: the report, the annex, `run.json`, exit codes, the exclusion list, `--rerender`, no personal data and no key in any output file;
- the stored-run format: the old example migrates to exactly the new one and back, no old name is left in a written file, every trace resolves in the file it is written in, and an old run still rerenders and compares;
- the two catalogs key by key, the English report against the stored run, the schema, the SARIF structure and level mapping, and the packaging (the sdist is built offline from a copy of the sources);
- determinism: byte-identical output for the same observations and clock, every printed number traced to its measurement on the fake-school run, and `examples/` equal to a fresh build;
- `--compare` on the fake school before and after its fixes: the rows, counts and colour changes typed by hand, every stored value resolved through its trace (also with the mail rows reordered), each refusal case including one, two and four valid runs and missing keys, a lab-only run that must not reach the field rows, origin-level field data, both rounding cases of the change column, a control that failed on one date, the 28-day overlap note, the text control, and `examples/after/` equal to a fresh build.

## Limits

- It reads HTML without running JavaScript. A WhatsApp button built by a script is invisible in that HTML; when the loader belongs to a known widget family, VIS-15 reports an observation instead of a failure.
- Google Safe Browsing is not queried; the annex gives the link to check by hand. EXT-23 needs both lists to be green, so it is grey unless Spamhaus lists the domain.
- `.edu.ar` domains have no RDAP service, so EXT-13 is grey for them and the annex points to nic.ar.
- Accessibility checks are the automatic subset Lighthouse can see. Zoom at 200 % and keyboard navigation need a browser and a person.
- The WordPress release table (`wpversions.py`) is maintained by hand. A branch missing from it gives no age, and the run warns on the console and in `run.json`.
- Nothing behind a login is seen: users, backups, installed plugins, files and database. The report says so in its own section.
- `--compare` cannot check that both runs used the same control site, because `run.json` does not record its name; it prints both control medians instead. The tool makes one desktop PageSpeed run, not three, and the desktop row says so. A lab number that moves within its usual run-to-run spread is still printed as a change; the tool has no noise threshold.

## What it does not do

- It does not test anything a visitor's browser would not ask for. No login, no plugin or user enumeration, no directory or path guessing, no port scan, no probe for a vulnerability. The scope guard refuses those requests in code.
- It does not find vulnerabilities and is not a penetration test. A report without red rows says the public surface looks cared for; it says nothing about what is behind the login.
- It does not run JavaScript, crawl the site or read more than the home, one inner page and the pages the checks name, within 90 requests.
- It does not run over a list of sites. One run measures one site, at a visitor's pace.
- It does not fix anything, and it does not send anything: no mail, no form, no report to a third party. MDN Observatory is asked only with `--observatory`.
- It does not use a language model, so it does not explain or advise beyond the pre-written sentence of each rule.
- It does not translate the detailed sentences. They exist in Spanish; the English report states each rule's result and lists the stored numbers.
- It does not check the Spanish spelling or wording of a site, and several content rules (the spam detector, the neglect signs) are written for sites in Spanish.
