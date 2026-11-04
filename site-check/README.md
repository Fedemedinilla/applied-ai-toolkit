# site-check

site-check reads a public website the way a visitor's browser does and writes a plain-language report on its security, speed, search visibility and contact paths. It is built around two constraints. It has to stay legal without the owner's permission, so a scope guard in the network layer refuses any request a visitor would not make. Every sentence of the report has to be reproducible, so 37 fixed rules turn measurements into pre-written text, and `--rerender` rebuilds a report byte for byte from its `datos.json`. There is no language model in the loop, on purpose. The reader acts on these sentences without being able to check them, so each one has to come from a measurement that someone else can check. `--compare` turns two stored runs into a before/after report (see Before and after).

Python standard library only: about 22,000 lines in `sitecheck/` and 639 tests that run offline against a fake site and fake APIs on 127.0.0.1.

The report text is Spanish (Argentina, formal "usted"), because the tool was built for small Argentine organisations such as schools and SMEs. Code, comments, console messages and this README are in English. The exception is the operator notes that the console repeats from `datos.json`, which are in Spanish. The keys of `datos.json` are Spanish, like the report they feed.

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

- **A scope guard sits in front of every connection** (`sitecheck/scope.py`). Every HTTP request, every redirect hop, the TLS handshake, the DNS blocklist lookup and every API call asks it first. On the target it admits the home and its www/https variants, robots.txt, the sitemaps robots.txt declares, the feed the home links, and pages the home links with `<a href>`. Off the page it admits the og:image the home declares, on any host, since that is what WhatsApp fetches for the preview. It also admits the first child of a sitemap index, the three standard sitemap paths only when robots.txt declares none, and one TLS handshake per site host. Outside the target it admits the API hosts, the control URL (path `/` only), the rdap.org redirect to the authoritative RDAP server, and the two Spamhaus DNS names. The site and the control get GET only; only the CrUX and Observatory APIs get POST. Everything else raises `ScopeError` and the run stops with exit 50 before anything is sent.
- **Paths that only an attacker or a scanner would ask for are denied even when linked**: `/wp-admin`, `wp-login.php`, `xmlrpc.php`, `/wp-json`, `?author=`, `/author/`, user sitemaps, `readme.html`, `license.txt`, sensitive files and 404 probes. A redirect the site itself issues to one of those paths is refused without raising, and the run goes on.
- **One request at a time, with a pause of at least 3 seconds, and at most 90 requests to the site.** `--pause` can only make the pause longer and `--max-requests` can only lower the budget.
- **An anti-bot challenge or a "slow down" answer (429, 503 with Retry-After) stops the site phase.** The tool waits once, retries that URL once, and cuts the host on the next signal.
- **Every request resolves the host first and connects only to the public address it resolved**, so a DNS answer cannot point the tool at a private network (DNS rebinding, SSRF).
- **One fixed, honest User-Agent** with a link to this repository, never rotated after a block, so a site owner who sees it in the logs can find out what it is and what it reads.
- **Personal data is not collected.** RDAP holder data is dropped, and only the last four digits of a WhatsApp number are kept. A published e-mail address is kept only when it is an institutional role address (`info@`, `secretaria@`, `admisiones@`). Paths that can carry a person's name (`/author/<user>/`) are masked in the evidence. The next run deletes raw evidence older than 30 days.
- **An exclusion list is checked before any request.** A site owner who asks not to be measured goes on it, and an excluded domain gets zero requests and exit 10. The list never fails open. A list named with `--exclude` or `SITE_CHECK_EXCLUDE` that does not exist is exit 2, and a line that cannot be read as a domain stops the run. Only the default `<out>/exclude.txt` may be absent.

## Architecture

The flow is collect, observe, evaluate, render. Each stage has a single input type, so the stages are tested apart.

```
cli.py          argparse -> RunConfig (frozen)
pipeline.py     the run end to end, exit code, datos.json
  services.py   wires the network objects; the only place where test mode changes behaviour
  collect.py    COLLECT: PageSpeed first, then DoH, RDAP, DBL, then the site phase
    scope.py      the scope guard (allow-list, deny patterns)
    httpclient.py one request at a time: pacing, budget, manual redirects, decoding, address pinning
    challenge.py  anti-bot detection
    psi.py crux.py doh.py rdap.py dbl.py tlsprobe.py wpapi.py   one client per public service
    artifacts.py  every measurement is written to evidencia/ as soon as it is obtained
  observations.py OBSERVE: everything measured in one run; the only input of the checks
  evaluate.py   EVALUATE: run the 37 evaluators, then the evidence gate, then the colours
    registry.py   the 37 checks: ID, priority, flags, evaluator
    checks/*.py   pure functions Observations + EvalContext -> Finding
    gate.py       no finding without the file that proves it
    colours.py    a fixed table plus documented exceptions, then --overrides
  render_report.py RENDER: informe.md and anexo-tecnico.md
  textlint.py   control of the report text before the run ends
```

The data model lives in `sitecheck/model.py`. A `Finding` has a state (`APROBADO`, `APROBADO_CON_OBSERVACION`, `FALLA`, `NO_APLICA`, `NO_VERIFICADO`), the raw measured values and the evidence files. It carries the report sentence in four columns: what was found, what can happen, what to do, who does it. Its trace names, for each measured number the sentence prints, the key in `datos.json` that holds it (`checks[EXT-07].measured.dias_calendario`). The colour is derived from the state, the module and the priority, never chosen by eye.

## Determinism and traceability

- Evaluators are pure: no network, no clock other than the run date, no file access. Missing data becomes `NO_VERIFICADO` with a stated reason, never a guessed number.
- Every sentence is written in full in the code, per case, including singular and plural. Nothing is assembled from fragments that could disagree in gender or number.
- `datos.json` keeps the measurements, the evidence list, the state, the colour and the filled sentences. `--rerender datos.json` rebuilds the report from it with zero requests, and the result is byte-identical. A colour override needs a written reason, and both the derived and the final colour stay in `datos.json`.
- One clock (`fmt.now_utc`) feeds the run date and the day counts of the certificate and the domain, so a sentence such as "vence el 11 de diciembre de 2026, en 58 días" cannot mix two instants.
- A test runs the same observations twice with a fixed clock and compares `datos.json`, `informe.md` and `anexo-tecnico.md` byte by byte.
- On the full fake-school run, a test reads every number the report sentences print. Each one must be either a fixed threshold of its rule or the rendering of a value its trace points at. The fixed thresholds are listed by hand in the test, such as Google's LCP threshold of 2.5 seconds, printed "2,5". Every trace must resolve to a stored value. Traces are written per case in the evaluators; the test covers the cases the fake school triggers (13 of the 37 checks print a measured number there), not every branch of every rule.
- `examples/` is rebuilt by `examples/make_example.py` with a fixed clock, and a test checks that a fresh build matches the committed files byte for byte.

## Design decisions

- **Standard library only.** The tool is meant to run on any machine with Python, with nothing to install. The CLI refuses to run if any module outside the standard library was loaded, and `python3 -I -S site_check.py` proves it. This is also why there is no XML parser for sitemaps (regular expressions over a capped body) and no Public Suffix List package (the Argentine suffixes and the hosting platforms are embedded).
- **PageSpeed runs before the first request to the site.** Google loads the site from its own servers, so if the site later blocks this tool, the speed numbers still stand.
- **Three mobile PageSpeed runs, and the median is used.** Lighthouse results vary between runs; the middle of three is steadier than any single run.
- **Real-user data wins over lab data.** LCP, INP and CLS come from Chrome UX Report when Google has it; a lab-only result is labelled as such in the report.
- **The three measurements that compare against something outside the site have a control.** TTFB is measured against a control site at the same moment, and the mail DNS answers are checked against a control domain that is known to publish SPF, DMARC and MX. Before it trusts a "not listed", the Spamhaus lookup also asks the documented test point (RFC 5782). If the control fails, the check is grey, because the instrument failed and not the site. RDAP, PageSpeed, TLS and the HTML reads have no control; their failures become grey with the reason.
- **Grey is a first-class result.** `NO_VERIFICADO` lists why the check could not see (an anti-bot page, a truncated body, a refused DNS lookup), and the report has a section for it. A green without its evidence file is downgraded to grey by the evidence gate (`gate.py`).
- **The evidence gate also guards against false failures.** A failure read from the HTML (no WhatsApp button, no viewport) needs a home that is really the home. That means status 200, an HTML body that arrived whole, and no challenge page, meta-refresh or JavaScript wrapper, or empty single-page-app shell. Otherwise it turns grey.
- **The hack gate.** Spamhaus abuse codes or spam pages injected into the site set a flag, the exit code becomes 30 and the report leads with "check the site in depth before any other change". The spam detector needs strong terms or repeated signals, because words like "casino" or "apuestas" are ordinary Spanish.
- **Speed failures are yellow, never red.** A slow site is worth fixing, not an emergency. Red is reserved for things that break the site or put its visitors at risk.
- **Report text is linted** (`textlint.py`). It rejects em and en dashes, unfilled placeholders, e-mail addresses from the site, secrets, and Markdown links or HTML tags taken from the site. It also rejects voseo and the words "certificado" and "inseguro", because a non-technical reader takes a "certificado" for a legal document, and "inseguro" alarms without saying what to do. A problem is exit 4. The report is still written, and every problem is listed on the console and in `datos.json` so it can be fixed in the code and the report rerendered.
- **The PageSpeed key comes only from `PAGESPEED_API_KEY`.** It travels only in the `X-goog-api-key` header, never in a URL, and a redactor scrubs every log line, evidence file and `datos.json`. A final sweep deletes any output file that still contains it. In test mode the real key is ignored, so a test hook can never send it to a fake server.

## How to run

Requires Python 3.11 or newer. Python 3.14 adds zstd decoding; on older versions the tool does not offer zstd.

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
python3 -I -S site_check.py https://www.example.org/ --name "Example School" --kind colegio --out ./runs

# Rebuild the report of an earlier run, with zero requests
python3 site_check.py --rerender ./runs/example.org/2026-10-14/datos.json

# Compare two stored runs (folders or datos.json files), with zero requests
python3 site_check.py --compare ./runs/example.org/2026-10-14 ./runs/example.org/2026-11-18

# Offline: rebuild examples/after/ (the improved school) and its comparison
python3 examples/make_compare_example.py
```

From the repository root, `npm run test:python` runs the same test command.

Options worth knowing:

- `--no-pagespeed` skips PageSpeed and CrUX; the speed checks stay grey.
- `--observatory` also asks MDN Observatory. It is off by default because it makes a third party scan the site.
- `--exclude FILE` or `SITE_CHECK_EXCLUDE` points at the exclusion list, which must exist; `<out>/exclude.txt` is read too when present.
- `--rerender DATOS_JSON` keeps the earlier file: it renames it to `datos-N.json` in the same folder and writes the new `datos.json`, `informe.md` and `anexo-tecnico.md`.
- `SITE_CHECK_OUT` sets the output root.
- `SITE_CHECK_CONTROL_DOMAIN` names the control site for the TTFB and DNS comparisons, and a real run refuses to start without it (exit 2). There is no default because the control gets three GET requests and a few DNS questions on every run, so it has to be a site you own. Without SPF, DMARC and MX records on it, EXT-05 turns grey.

A run leaves `<out>/<domain>/<date>/` with these files:

- `informe.md`, the report;
- `anexo-tecnico.md`, the state of each check, the broken link addresses and the manual checks;
- `datos.json`, every measurement, state, colour and sentence;
- `00-tiempo.txt`, the start and end time of the run (Buenos Aires time);
- `evidencia/`, every response and API answer the states rest on, plus `requests.log` with one JSON line per request.

`examples/` holds the report, the annex and `datos.json` of a run against the fictional school on 14/10/2026. `examples/after/` holds the same school on 18/11/2026, after the fixes listed in `tests/comparefixtures.py`, and `comparacion.md` between the two.

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

## Before and after

`--compare BEFORE AFTER` reads two stored runs of the same site and writes a before/after report, `comparacion.md`, with its numbers in `comparacion.json`, into the AFTER folder. It makes no request and reads no clock, so the same two `datos.json` files always give the same bytes. Both runs must come from the same site-check and Lighthouse versions and the same options, with three or more valid mobile PageSpeed runs, so the lab rows are medians. Mobile and desktop rows stay separate. Real-user rows never take a lab value, and each table names its cache condition. Time to first byte is compared only when the control site answered on both dates. The report has these rows.

- real-user LCP, INP and CLS on mobile from Chrome UX Report, with a heading that says whether Google gave data for the home page or for the whole site;
- the lab mobile score and lab LCP, both from the median run, and the desktop score, labelled as one run;
- time to first byte, with the control site's median next to it;
- page weight and the third-party share;
- how many of the six browser protection headers are set, and the MDN Observatory grade when both runs asked for it;
- the three mail authentication rows (SPF, DKIM, DMARC), each marked as added, removed, better, worse or changed;
- checks passed over applicable, per module and in total;
- every check that changed colour, grouped as improved, worse, or other (to or from grey);
- what is still not green on the AFTER date, by colour.

Each value in `comparacion.json` names where it lives in its own run, in the trace notation of `model.py`. `checks[EXT-08].measured.lcp_ms` is the `mediciones.lcp_ms` of the check whose id is EXT-08. `tablas.correo.filas[2].valor` is the third mail row of that run. A cell without a value has no trace.

**Runs taken with different tools or conditions are refused.** Any difference refuses the comparison with exit 5 and writes nothing, and every reason is listed. A key that one run does not record is a reason of its own, so a truncated or hand-made `datos.json` cannot pass because two missing values look equal.

| Condition | `datos.json` key | Why a difference moves a number |
|---|---|---|
| domain and measured page | `meta.dominio`, `meta.url_canonica` | another site |
| inner page read | `meta.url_interna` | other content checks read another page |
| site-check version | `meta.version_script` | other rules, other colours |
| Lighthouse major version | `meta.version_lighthouse` | other scoring |
| PageSpeed on or off | `meta.sin_pagespeed` | speed checks grey on one date only |
| mobile runs asked and valid | `meta.corridas_psi.pedidas`, `.validas` | another median; fewer than three, or an even count, has no middle run and is refused even when both dates match |
| desktop run valid | `meta.corridas_psi.computadora_valida` | a desktop score on one date only |
| MDN Observatory asked | `meta.alcance.observatory` | a grade on one date only |
| request budget | `meta.max_pedidos` | fewer links read |
| kind of organisation | `meta.tipo` | other checks apply (admissions for schools) |
| test mode | `meta.modo_prueba` | a fake site compared with a real one |
| run cut or home down | `meta.sitio_cortado`, `meta.portada_no_respondio` | checks that did not see the site |
| order of the runs | `meta.inicio_utc` | AFTER must be later than BEFORE |

The other errors it guards against, and how.

- **Lab data shown as field data.** A run without Chrome UX Report data stores its lab LCP in the same `lcp_ms` key with `scope: "laboratorio"`. The field rows read that key only when the scope is `pagina` or `origen`; otherwise the cell says "sin datos de campo" and the row is not compared. Page-level and origin-level field data are not compared with each other either.
- **A change column that contradicts its cells.** The change is the difference of the two printed numbers, not of the raw values. 2949 ms and 2951 ms print as "2,9" and "3,0" seconds (decimal comma), so the change is 0.1 seconds more. 2860 ms and 2940 ms both print "2,9", so the change column says "sin cambio".
- **A change in the instrument read as a change in the site.** Time to first byte is compared only when EXT-20 had a valid control on both dates, and the control medians are printed in the next row.
- **A grey check counted as passed.** `NO_APLICA` leaves the denominator; `NO_VERIFICADO` stays in it and never counts as passed. A check that turns grey is listed under other changes, never as improved or worse.
- **Field data that still holds the old site.** Chrome UX Report covers the 28 days before each run. When the two runs are fewer than 28 days apart, the report says that the AFTER numbers still include visits from before the change.
- **An option that looks like it did something.** `--compare` takes no other option. A URL, a measurement option such as `--observatory` or `--psi-runs`, or an output option is a usage error (exit 2).

The report goes through the same text control as `informe.md` (exit 4 on a problem, files written). Its shape follows the before/after version of the report template the tool was built with. It leaves out the two parts only a person can write, what was done on the site and what to do next.

## How the tests work

`tests/support.py` replaces `socket.connect` and `getaddrinfo` for the whole test process: any connection or name lookup that is not loopback raises. No test can reach a real site or a real API, whatever the code under test does.

`tests/fakesite.py` is a threaded HTTP server on 127.0.0.1 that plays a website and records every request. `tests/sitefixtures.py` describes a fictional WordPress school under the reserved `.test` TLD. It carries a hand-written list of the URLs the tool may request, and another of URLs it must never request, such as the login page, the REST API and author pages. `tests/fakeapis.py` plays PageSpeed, CrUX, DoH, RDAP, the WordPress stable-check and Observatory. It also stands in for the TLS handshake and the Spamhaus DNS lookup. Two hidden CLI flags (`--test-loopback`, `--test-services`) route the real CLI to them, and they only accept a `.test` URL and loopback addresses.

What the tests cover:

- the scope guard case by case, and end to end. After a full run the fake site's request log holds no forbidden URL and nothing outside the allowed set, PageSpeed ran before the first site request, and the budget held;
- the HTTP client: pacing, budget, manual redirects, decoding bombs, slow-drip servers, the total deadline, address pinning, the challenge cut;
- every check against hand-made pages, with expected sentences typed by hand, never computed with the code under test, and a control case for each rule;
- the evidence gate, the colour table and its exceptions, the text control;
- the full CLI against the fake site: the report, the annex, `datos.json`, exit codes, the exclusion list, `--rerender`, no personal data and no key in any output file;
- determinism: byte-identical output for the same observations and clock, every printed number traced to its measurement on the fake-school run, and `examples/` equal to a fresh build;
- `--compare` on the fake school before and after its fixes: the rows, counts and colour changes typed by hand, every stored value resolved through its trace (also with the mail rows reordered), each refusal case including one, two and four valid runs and missing keys, a lab-only run that must not reach the field rows, origin-level field data, both rounding cases of the change column, a control that failed on one date, the 28-day overlap note, the text control, and `examples/after/` equal to a fresh build.

## Limits

- It reads HTML without running JavaScript. A WhatsApp button built by a script is invisible in that HTML; when the loader belongs to a known widget family, VIS-15 reports an observation instead of a failure.
- Google Safe Browsing is not queried; the annex gives the link to check by hand. EXT-23 needs both lists to be green, so it is grey unless Spamhaus lists the domain.
- `.edu.ar` domains have no RDAP service, so EXT-13 is grey for them and the annex points to nic.ar.
- Accessibility checks are the automatic subset Lighthouse can see. Zoom at 200 % and keyboard navigation need a browser and a person.
- The WordPress release table (`wpversions.py`) is maintained by hand. A branch missing from it gives no age, and the run warns on the console and in `datos.json`.
- Nothing behind a login is seen: users, backups, installed plugins, files and database. The report says so in its own section.
- `--compare` cannot check that both runs used the same control site, because `datos.json` does not record its name; it prints both control medians instead. The tool makes one desktop PageSpeed run, not three, and the desktop row says so. A lab number that moves within its usual run-to-run spread is still printed as a change; the tool has no noise threshold.

Not included: anything that needs authorization (logins, plugin enumeration, directory or path guessing, port scans) and batch runs over lists of sites.
