"""The collection flow: every measurement of a run, in a fixed order.

Order:

1. PageSpeed BEFORE touching the site: ``psi_runs`` mobile runs + 1 desktop run on
   the INPUT URL (H is not known yet; PSI follows redirects itself and its
   finalDisplayedUrl is checked). CrUX fallback when field data is missing and a
   key exists.
2. DoH mail records for D and for the control domain;
   RDAP; DBL. (APIs, sequential.)
3. Site phase, one request at a time, paced, budgeted (90), challenge-checked:
   a. the input URL and its redirect chain -> home load 1, H = its final URL.
      A challenge confirmed on this first request, or no usable response, sets
      ``home_unreachable`` and STOPS the run (exit 3);
   b. TTFB interleave: control 1, home load 2, control 2, home load 3, control 3
      (loads 2 and 3 also serve EXT-19); when the control URL is on the measured
      site (the self-check), only the two reloads: the site is never its own
      control;
   c. the other three EXT-17 variants, each chain stopped at H (stop_at) so H is
      never requested again;
   d. TLS handshake to the canonical host, and to the other apex/www host when
      its https variant answered;
   e. robots.txt on the canonical origin; then the first declared sitemap (and the
      first child of an index); the three standard paths only if robots.txt was
      valid and declared none, stopping at the first valid one;
   f. the feed, only if the home links it (rel=alternate, not the comments feed);
   g. the interna: --inner-page if the home links it, else links.select_interna;
      then --form-page if the home links it;
   h. og:image (once, any host, 256 KiB);
   i. hreflang alternates on D (at most 3);
   j. VIS-09 link checks (links.select_link_checks), reusing every URL already
      fetched (never requested twice).
4. After the site phase: WordPress stable-check (only if a WP version is
   visible); the mail DNS of the mailto: domains of the home and the interna; Observatory (only with --observatory).

Every step stores its evidence through services.artifacts as soon as it has it.
Budget exhausted or host blocked: the remaining steps are recorded in
``Observations.skipped`` with the reason, never silently dropped. ScopeError is
never caught here: it propagates to the pipeline (exit 50). Before it
propagates, the partial Observations are attached to the exception as
``exc.observations`` so the pipeline can write datos.json with what exists.

The canonical host is checked against the exclusion list right after step 3a
(``no_contact_check``): a match stops the site phase (final_host_no_contact).

* The site domain (domains.site_domain) is the scope of the run. When the site
  lives under someone else's domain (obs.shared_parent: a university, a
  provincial network, a platform such as Blogger), the mail DNS, RDAP and DBL
  lookups are not made: they would describe the owner, not the site.
* A home that fails the TLS verification is not "unreachable" right away: the TLS probe measures it first. A certificate a browser accepts
  (only VERIFY_X509_STRICT rejects it) makes the client relax that flag for
  the host and fetch the home again; a certificate a browser rejects lets the
  run go on without the home HTML (EXT-07 is the finding); an inconclusive
  result stops the run with exit 3 and its own reason.
* A home that redirects to another registrable domain or to a login page
  records ``home_problem`` and ``home_redirect_target``.
* After the home, the HTTP client learns which URLs are the home and what its
  body is.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import re
from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from . import artifacts as art
from . import domains, fmt
from .challenge import Expect
from .doh import DnsBundle, DnsStatus, MailDns
from .httpclient import MAX_HTML_BYTES, MAX_IMAGE_BYTES, Response
from .imagesize import image_info
from .links import discover_links, interna_kind, links_other_pages, select_interna, select_link_checks
from .observations import (
    FeedFetch,
    LinkProbe,
    MailDomainCheck,
    MailDomainSurvey,
    Observations,
    OgImageFetch,
    PageFetch,
    RobotsFetch,
    SitemapFetch,
    SkippedRequest,
    TtfbSample,
    VariantProbe,
)
from .requestlog import utc_now_iso
from .robots import RobotsState, classify_response, parse_robots
from .scope import STANDARD_SITEMAP_PATHS, Purpose, ScopeError
from .sitemapfeed import DocKind, looks_like_sitemap, parse_feed, parse_sitemap, sitemap_body, wordpress_version_from_generator
from .wpapi import core_version_from_assets

if TYPE_CHECKING:
    from .config import RunConfig
    from .services import Services

MAX_HREFLANG_ALTERNATES = 3
# VIS-21: mailto: domains asked about per run (each takes 1 to 3 DoH questions).
MAX_MAIL_DOMAINS = 4
MAX_ROBOTS_BYTES = 512 * 1024  # Google reads the first 500 KiB of robots.txt

_WP_GENERATOR_RES = (
    re.compile(r"""<meta[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["']\s*WordPress\s+(\d+(?:\.\d+){1,2})""", re.IGNORECASE),
    re.compile(r"""<meta[^>]*content\s*=\s*["']\s*WordPress\s+(\d+(?:\.\d+){1,2})[^>]*name\s*=\s*["']generator["']""", re.IGNORECASE),
)

# Response.error -> VariantProbe/LinkProbe.error (Spanish only where the report shows it as is).
_ERROR_LABELS = {"dns": "no resuelve", "timeout": "timeout", "refused": "refused", "protocol": "protocol"}
# OpenSSL verify codes of a chain without its intermediate (20 unable to get local
# issuer, 21 unable to verify the first certificate): not "the browser rejects".
CHAIN_CODES: frozenset[int] = frozenset({20, 21})


def _say(progress: Callable[[str], None] | None, text: str) -> None:
    if progress is not None:
        try:
            progress(text)
        except Exception:
            pass


def _error_label(resp: Response) -> str | None:
    if resp.skipped:
        return f"skipped:{resp.skipped}"
    if resp.error is None:
        return None
    if resp.error.startswith("tls"):
        return "tls"
    return _ERROR_LABELS.get(resp.error, resp.error)


def _note_skip(obs: Observations, purpose: Purpose | str, url: str, reason: str) -> None:
    obs.skipped.append(SkippedRequest(purpose=str(purpose), url=url, reason=reason))
    if reason == "budget":
        obs.budget_exhausted = True


def _note_response(obs: Observations, purpose: Purpose | str, resp: Response) -> None:
    """Record a request that the client did not send (budget or blocked)."""
    if resp.skipped:
        _note_skip(obs, purpose, resp.url, resp.skipped)


def _record_error(services: "Services", obs: Observations, where: str, exc: BaseException) -> None:
    message = f"{where}: {type(exc).__name__}: {exc}"
    obs.errors.append(services.redactor.scrub(message)[:300])


def _store_response(services: "Services", resp: Response, body_name: str | None, headers_name: str | None) -> tuple[str | None, str | None]:
    """Store body and headers evidence of one response; return the names actually written."""
    body_written = headers_written = None
    if resp.status is None:
        return None, None
    if headers_name:
        text = art.headers_as_text(resp.status, resp.reason, resp.headers, resp.final_url)
        if services.artifacts.put_text(headers_name, text):
            headers_written = headers_name
    if body_name and resp.body_read:
        if services.artifacts.put_bytes(body_name, resp.body):
            body_written = body_name
    return body_written, headers_written


def _page_links(resp: Response) -> Any:
    if not resp.usable or not resp.body:
        return None
    ctype = resp.content_type
    if ctype is not None and ctype not in ("text/html", "application/xhtml+xml"):
        return None
    text, _bad = resp.text()
    return discover_links(text, resp.final_url)


def _safe_name(code: str) -> str:
    cleaned = re.sub(r"[^a-z0-9-]+", "-", code.lower()).strip("-")
    return cleaned[:20] or "x"


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _jsonable(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _jsonable(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (dt.datetime, dt.date)):
        return obj.isoformat()
    return obj


# ---------------------------------------------------------------------------- flow


def collect(
    config: "RunConfig",
    services: "Services",
    *,
    no_contact_check: Callable[[str], bool] | None = None,
    progress: Callable[[str], None] | None = None,
) -> "Observations":
    """Run steps 1 to 4 and return the Observations.

    ``no_contact_check(host) -> bool`` is supplied by the pipeline (the exclusion list)
    and called with the host of the first PageSpeed answer's final URL and with the canonical host
    after step 3a. ``progress`` receives short
    English status lines for the console (never secrets). Records started_utc,
    finished_utc, site_requests, artifacts_written and challenge_events.
    """
    obs = Observations(
        input_url=config.url,
        registrable=services.guard.registrable,
        started_utc=utc_now_iso(),
        key_present=services.key.present,
    )
    try:
        obs.shared_parent = domains.shared_parent(domains.host_of(config.url))
    except ValueError:
        obs.shared_parent = None
    try:
        _say(progress, "PageSpeed and APIs")
        collect_apis(config, services, obs, no_contact_check=no_contact_check)
        _say(progress, "home")
        if probe_home(config, services, obs, no_contact_check=no_contact_check):
            steps: list[tuple[str, Callable[[], None]]] = [
                ("variants", lambda: probe_variants(services, obs)),
                ("tls", lambda: probe_tls(services, obs)),
                ("robots and sitemaps", lambda: fetch_robots_and_sitemaps(services, obs)),
                ("feed", lambda: fetch_feed(services, obs)),
                ("linked pages", lambda: fetch_linked_pages(config, services, obs)),
                ("og:image", lambda: fetch_og_image(services, obs)),
                ("hreflang", lambda: fetch_hreflang(services, obs)),
                ("link checks", lambda: check_links(services, obs)),
            ]
            for name, step in steps:
                _say(progress, name)
                try:
                    step()
                except ScopeError:
                    raise
                except Exception as exc:  # one broken step never loses the rest
                    _record_error(services, obs, name, exc)
        _say(progress, "after the site")
        collect_after_site(config, services, obs)
    except ScopeError as exc:
        _finish(services, obs)
        exc.observations = obs  # type: ignore[attr-defined]
        raise
    _finish(services, obs)
    return obs


def _finish(services: "Services", obs: Observations) -> None:
    http = services.http
    obs.site_requests = http.site_requests
    obs.blocked = obs.blocked or http.blocked
    obs.block_cause = getattr(http, "cut_cause", None) if obs.blocked else None
    obs.challenge_events = http.challenge_events
    if getattr(http, "budget_exhausted", False) and any(s.reason == "budget" for s in obs.skipped):
        obs.budget_exhausted = True
    _refresh_challenges(obs)
    try:
        services.artifacts.put_json(art.SCOPE, services.guard.describe())
    except (ValueError, OSError):
        pass
    try:
        report = services.artifacts.masking_report()
        if report:  # what the evidence masked, with the SHA-256 of each original
            services.artifacts.put_json(art.MASKED, report)
    except (ValueError, OSError, AttributeError):
        pass
    obs.finished_utc = utc_now_iso()
    obs.artifacts_written = services.artifacts.written_map()


def _refresh_challenges(obs: Observations) -> None:
    """Rule (b) can flag a response after its derived records were built: propagate the flag."""
    flagged = {domains.compare_key(e.url) for e in obs.challenge_events if e.url}
    if not flagged:
        return

    def hit(url: str | None) -> bool:
        return bool(url) and domains.compare_key(url) in flagged

    for sample in obs.ttfb.site:
        if hit(sample.url):
            sample.challenged = True
    for probe in obs.variants:
        if any(hit(u) for u in probe.urls):
            probe.challenged = True
    for probe in obs.links.probes:
        if hit(probe.final_url) or hit(probe.url):
            probe.challenged = True


def collect_apis(
    config: "RunConfig",
    services: "Services",
    obs: "Observations",
    no_contact_check: Callable[[str], bool] | None = None,
) -> None:
    """Steps 1 and 2: PSI series (+ CrUX fallback), DoH for D and control, RDAP, DBL.

    ``no_contact_check``: PageSpeed runs before the site
    phase, so a home that redirects to a listed domain was loaded by Lighthouse
    four times before the pipeline saw the redirect. The first PageSpeed answer's
    final URL is checked against the list; a match stops the series there.
    """
    d = obs.registrable

    def stop(run: Any) -> bool:
        if no_contact_check is None or not getattr(run, "final_url", None):
            return False
        try:
            host = domains.host_of(run.final_url)
        except ValueError:
            return False
        return bool(no_contact_check(host))

    try:
        series = services.psi.run_series(config.url, config.psi_runs, stop=stop)
        obs.psi = series
        if series.field_data is None and services.key.present:
            page_url = config.url
            for run in series.mobile:
                if run.ok and run.final_url and domains.is_same_site(run.final_url, d):
                    page_url = run.final_url
                    break
            obs.crux_field = services.crux.field_for(page_url, _origin(page_url))
            if obs.crux_field is not None:
                series.field_data = obs.crux_field
    except ScopeError:
        raise
    except Exception as exc:
        _record_error(services, obs, "psi", exc)

    if obs.shared_parent:
        # The site lives under someone else's domain: its mail DNS, expiry and
        # blocklist status would describe the owner, never the site.
        for purpose in (Purpose.DOH, Purpose.RDAP, Purpose.DBL):
            _note_skip(obs, purpose, obs.shared_parent, "shared-domain")
        return

    try:
        site = services.doh.mail_dns(d)
        control_is_site = _same_domain(d, services.endpoints.control_domain)
        # The control domain measured as a site (README step 5, self-check): its own
        # answers are the control; the same queries are never sent twice.
        control = site if control_is_site else services.doh.mail_dns(services.endpoints.control_domain)
        obs.dns = DnsBundle(site=site, control=control, control_ok=_control_ok(control))
        payload = {"sitio": _jsonable(site), "control": _jsonable(control), "control_ok": obs.dns.control_ok}
        if control_is_site:
            payload["control_es_el_sitio"] = True
        services.artifacts.put_json(art.DNS, payload)
    except ScopeError:
        raise
    except Exception as exc:
        _record_error(services, obs, "dns", exc)

    try:
        obs.rdap = services.rdap.lookup(d, fmt.now_utc())
    except ScopeError:
        raise
    except Exception as exc:
        _record_error(services, obs, "rdap", exc)

    try:
        obs.dbl = services.dbl.lookup(d)
        services.artifacts.put_json(art.DBL, _jsonable(obs.dbl))
    except ScopeError:
        raise
    except Exception as exc:
        _record_error(services, obs, "dbl", exc)


def _same_domain(a: str, b: str) -> bool:
    """True when two domain names are the same after normalization."""
    try:
        return domains.normalize_host(a) == domains.normalize_host(b)
    except ValueError:
        return False


def _control_site_is_site(services: "Services", obs: "Observations") -> bool:
    """True when the TTFB control URL is on the measured site: the site is never its own control."""
    return domains.is_same_site(services.endpoints.control_url, obs.registrable)


def _control_ok(control: MailDns) -> bool:
    spf = control.txt.status is DnsStatus.NOERROR and any(r.lower().startswith("v=spf1") for r in control.txt.records)
    dmarc = control.dmarc.status is DnsStatus.NOERROR and any(r.lower().startswith("v=dmarc1") for r in control.dmarc.records)
    mx = control.mx.status is DnsStatus.NOERROR and bool(control.mx.records)
    return spf and dmarc and mx


def _home_usable(resp: Response) -> bool:
    return (
        resp.usable
        and resp.status is not None
        and 200 <= resp.status < 300
        and not resp.left_site
        and not resp.hops_exceeded
        and resp.stopped_at is None
    )


def _home_tls_failure(config: "RunConfig", services: "Services", obs: "Observations", r1: Response) -> Response:
    """The home failed the TLS verification. Measure the certificate before deciding.

    Returns the response to use as home load 1: the same one, or a second load
    when the certificate is accepted by browsers and only VERIFY_X509_STRICT
    rejected it. Sets ``obs.home_problem`` ("tls-invalid" when a browser would
    show a warning, "tls-unverified" when it could not be decided).
    """
    try:
        host = domains.host_of(r1.final_url or r1.url)
    except ValueError:
        return r1
    d = obs.registrable
    if host not in (d, "www." + d) or any(t.host == host for t in obs.tls):
        obs.home_problem = "tls-unverified"
        return r1
    result = services.tls.probe(host, 443)
    obs.tls.append(result)
    if (result.error or "").startswith("skipped"):
        obs.home_problem = "tls-unverified"
        return r1
    if result.ok and result.strict_only_failure:
        services.http.relax_strict_tls(host)
        r2 = services.http.fetch(config.url, purpose=Purpose.HOME, expect=Expect.HTML)
        if not (r2.error and r2.error.startswith("tls")):
            return r2
        obs.home_problem = "tls-unverified"
        return r2
    expired = result.days_left is not None and result.days_left < 0
    if not expired and result.verify_code in CHAIN_CODES:
        # Codes 20/21: the leaf came without its intermediate (or, on Windows, the
        # root is not loaded yet). Browsers usually complete the chain, so the site
        # phase runs; EXT-07 reports the chain from the probe.
        services.http.accept_incomplete_chain(host)
        r2 = services.http.fetch(config.url, purpose=Purpose.HOME, expect=Expect.HTML)
        if not (r2.error and r2.error.startswith("tls")):
            return r2
        obs.home_problem = "tls-unverified"
        return r2
    definitive = expired or (not result.ok and not result.inconclusive and (result.verify_code is not None or result.error == "verify"))
    obs.home_problem = "tls-invalid" if definitive else "tls-unverified"
    return r1


def _ttfb_sample(url: str, resp: Response) -> TtfbSample:
    return TtfbSample(url=url, ttfb_ms=resp.ttfb_ms, status=resp.status, challenged=bool(resp.challenge), error=_error_label(resp))


def probe_home(
    config: "RunConfig",
    services: "Services",
    obs: "Observations",
    *,
    no_contact_check: Callable[[str], bool] | None = None,
) -> bool:
    """Steps 3a and 3b. Returns False when the home is unreachable or challenged (exit 3).

    Also returns False (with ``final_host_no_contact`` set) when
    ``no_contact_check`` matches the canonical host: the site phase stops there.
    """
    http = services.http
    r1 = http.fetch(config.url, purpose=Purpose.HOME, expect=Expect.HTML)
    # Whatever the status: an http:// input answers 301 and then fails on the
    # https:// hop, and that certificate is measured too.
    if r1.error and r1.error.startswith("tls"):
        r1 = _home_tls_failure(config, services, obs, r1)
    home = PageFetch(role="home", url=config.url, response=r1)
    obs.home = home
    _note_response(obs, Purpose.HOME, r1)
    body_name, headers_name = _store_response(services, r1, art.HOME_HTML, art.HOME_HEADERS)
    home.body_artifact, home.headers_artifact = body_name, headers_name
    obs.blocked = http.blocked

    if not _home_usable(r1):
        if obs.tls:
            services.artifacts.put_json(art.TLS, _jsonable(obs.tls))
        if obs.home_problem == "tls-invalid":
            # A browser shows a warning on this home: EXT-07 measured it, and the
            # checks that do not need the HTML still run. Not exit 3.
            return False
        obs.home_unreachable = True
        if r1.denied_redirect:
            obs.home_problem = "private"
            obs.home_redirect_target = r1.refused_next_url
        elif r1.left_site:
            obs.home_problem = "left-site"
            obs.home_redirect_target = r1.refused_next_url
            obs.errors.append("home: the input URL redirects outside the registrable domain")
        return False

    h = r1.final_url
    services.guard.set_canonical(h)
    obs.canonical_url = h
    host = domains.host_of(h)
    obs.canonical_host = host
    d = obs.registrable
    obs.other_host = d if host == "www." + d else ("www." + d if host == d else None)
    home.links = _page_links(r1)
    # Copies of the home (http and https, with and without www, /index.php) are
    # not an anti-bot challenge when the home is a real page with links.
    genuine = home.links is not None and links_other_pages(home.links, d)
    http.set_home_reference([h, config.url, *domains.site_variants(d)], r1.sha256, genuine)

    if no_contact_check is not None and no_contact_check(host):
        obs.final_host_no_contact = True
        _note_skip(obs, "site-phase", h, "no-contact")
        return False

    obs.ttfb.site.append(_ttfb_sample(h, r1))
    control_url = services.endpoints.control_url
    # Measuring the control site itself (the self-check): no control GETs, so the
    # site is never compared with itself and every request to it counts as a site
    # request. The two reloads still run.
    obs.ttfb.control_is_site = _control_site_is_site(services, obs)
    for n in (1, 2, 3):
        if not obs.ttfb.control_is_site:
            c = http.fetch(control_url, purpose=Purpose.CONTROL, expect=Expect.HTML)
            obs.ttfb.control.append(_ttfb_sample(control_url, c))
        if n == 3:
            break
        reload_ = http.fetch(h, purpose=Purpose.HOME_RELOAD, expect=Expect.HTML)
        obs.home_reloads.append(reload_)
        obs.ttfb.site.append(_ttfb_sample(h, reload_))
        _note_response(obs, Purpose.HOME_RELOAD, reload_)
        _store_response(services, reload_, None, art.HOME_RELOAD_HEADERS.format(n=n + 1))
    ttfb_payload: dict[str, Any] = {"sitio": _jsonable(obs.ttfb.site), "control": _jsonable(obs.ttfb.control)}
    if obs.ttfb.control_is_site:
        ttfb_payload["control_es_el_sitio"] = True
    services.artifacts.put_json(art.TTFB, ttfb_payload)
    obs.blocked = http.blocked
    return True


def _variant_from_response(start_url: str, resp: Response, canonical: str, canonical_status: int | None) -> VariantProbe:
    probe = VariantProbe(start_url=start_url)
    probe.urls = [hop.url for hop in resp.redirects]
    probe.statuses = [hop.status for hop in resp.redirects]
    probe.hops = len(resp.redirects)
    probe.left_site = resp.left_site or resp.denied_redirect
    probe.challenged = bool(resp.challenge)
    probe.error = _error_label(resp)
    if resp.stopped_at is not None:
        probe.final_url = canonical
        probe.final_status = canonical_status
        probe.reached_canonical = True
        return probe
    if resp.status is not None:
        probe.urls.append(resp.final_url)
        probe.statuses.append(resp.status)
        probe.final_url = resp.final_url
        probe.final_status = resp.status
        probe.reached_canonical = domains.compare_key(resp.final_url) == domains.compare_key(canonical)
    return probe


def probe_variants(services: "Services", obs: "Observations") -> None:
    """Step 3c: the three remaining variants of EXT-17, stopping at H."""
    if obs.canonical_url is None or obs.home is None or obs.home.response is None:
        return
    h = obs.canonical_url
    h_key = domains.compare_key(h)
    r1 = obs.home.response
    input_key = domains.compare_key(obs.input_url)
    for variant in domains.site_variants(obs.registrable):
        key = domains.compare_key(variant)
        if key == input_key:
            probe = _variant_from_response(variant, r1, h, r1.status)
        elif key == h_key:
            # H itself, already fetched as the final hop of load 1: never requested again.
            probe = VariantProbe(
                start_url=variant,
                statuses=[r1.status] if r1.status is not None else [],
                urls=[h],
                final_url=h,
                final_status=r1.status,
                hops=0,
                reached_canonical=True,
                challenged=bool(r1.challenge),
            )
        else:
            resp = services.http.fetch(variant, purpose=Purpose.VARIANT, expect=Expect.HTML, stop_at=h_key)
            _note_response(obs, Purpose.VARIANT, resp)
            probe = _variant_from_response(variant, resp, h, r1.status)
        obs.variants.append(probe)
    services.artifacts.put_json(art.VARIANTS, _jsonable(obs.variants))


def probe_tls(services: "Services", obs: "Observations") -> None:
    """Step 3d."""
    if obs.canonical_host is None or obs.canonical_url is None:
        return

    def https_answered(host: str) -> bool:
        key = domains.compare_key(f"https://{host}/")
        for v in obs.variants:
            if domains.compare_key(v.start_url) == key:
                return bool(v.statuses) and v.error is None
        return False

    targets: list[str] = []
    if urlsplit(obs.canonical_url).scheme == "https" or https_answered(obs.canonical_host):
        targets.append(obs.canonical_host)
    else:
        _note_skip(obs, Purpose.TLS, f"tls://{obs.canonical_host}:443", "no-https")
    if obs.other_host:
        if https_answered(obs.other_host):
            targets.append(obs.other_host)
        else:
            _note_skip(obs, Purpose.TLS, f"tls://{obs.other_host}:443", "no-https")
    probed = {t.host for t in obs.tls}  # the home's TLS failure may have probed one already
    targets = [h for h in targets if h not in probed]
    for host in targets:
        result = services.tls.probe(host, 443)
        if result.error and result.error.startswith("skipped:"):
            _note_skip(obs, Purpose.TLS, f"tls://{host}:443", result.error.split(":", 1)[1])
        obs.tls.append(result)
    if obs.tls:
        services.artifacts.put_json(art.TLS, _jsonable(obs.tls))


def _fetch_sitemap(services: "Services", obs: Observations, url: str, *, declared: bool, purpose: Purpose) -> SitemapFetch:
    resp = services.http.fetch(url, purpose=purpose, expect=Expect.XML, max_bytes=MAX_HTML_BYTES)
    _note_response(obs, purpose, resp)
    sf = SitemapFetch(url=url, declared=declared, response=resp)
    sf.soft_404 = resp.soft_404
    xml: bytes | None = None
    if resp.usable and resp.status == 200 and resp.body_read:
        xml, sf.unreadable = sitemap_body(resp)  # a .xml.gz is decompressed
    sf.valid = looks_like_sitemap(resp, xml)
    if sf.valid and xml is not None:
        gzipped = bytes(resp.body[:2]) == b"\x1f\x8b"
        sf.doc = parse_sitemap(xml.decode("utf-8", errors="replace") if gzipped else resp.text()[0])
        if sf.doc.kind in (DocKind.INVALID, DocKind.REFUSED):
            sf.valid = False
    sf.evidence_body = xml if xml is not None else (resp.body if resp.body_read else None)
    return sf


def _fetch_child(services: "Services", obs: Observations, parent: SitemapFetch) -> None:
    if not parent.valid or parent.doc is None or parent.doc.kind is not DocKind.SITEMAPINDEX or not parent.doc.locs:
        return
    child_url = parent.doc.locs[0]
    if services.guard.admit_sitemap_child(child_url):
        parent.child = _fetch_sitemap(services, obs, child_url, declared=parent.declared, purpose=Purpose.SITEMAP_CHILD)
        if parent.child.response is not None and parent.child.evidence_body is not None:
            services.artifacts.put_bytes(art.SITEMAP_CHILD, parent.child.evidence_body)
    else:
        _note_skip(obs, Purpose.SITEMAP_CHILD, child_url, "off-site")


def fetch_robots_and_sitemaps(services: "Services", obs: "Observations") -> None:
    """Step 3e, including guard.allow_standard_sitemaps only when robots.txt declares none."""
    if obs.canonical_url is None:
        return
    origin = _origin(obs.canonical_url)
    robots_url = origin + "/robots.txt"
    resp = services.http.fetch(robots_url, purpose=Purpose.ROBOTS, expect=Expect.TEXT, max_bytes=MAX_ROBOTS_BYTES)
    _note_response(obs, Purpose.ROBOTS, resp)
    state = classify_response(resp)
    parsed = parse_robots(resp.text()[0]) if state is RobotsState.OK else None
    obs.robots = RobotsFetch(url=robots_url, response=resp, state=state, parsed=parsed)
    if resp.status is not None and resp.body_read:
        services.artifacts.put_bytes(art.ROBOTS, resp.body)

    if state is not RobotsState.OK or parsed is None:
        _note_skip(obs, Purpose.SITEMAP, "", f"robots-{state.value}")
        return
    stored = False
    if parsed.sitemaps:
        admitted = services.guard.admit_declared_sitemaps(parsed.sitemaps)
        if not admitted:
            _note_skip(obs, Purpose.SITEMAP, parsed.sitemaps[0], "off-site")
            return
        sf = _fetch_sitemap(services, obs, admitted[0], declared=True, purpose=Purpose.SITEMAP)
        obs.sitemaps.append(sf)
        if sf.response is not None and sf.evidence_body is not None:
            stored = services.artifacts.put_bytes(art.SITEMAP, sf.evidence_body)
        _fetch_child(services, obs, sf)
        return

    services.guard.allow_standard_sitemaps()
    for path in STANDARD_SITEMAP_PATHS:
        sf = _fetch_sitemap(services, obs, origin + path, declared=False, purpose=Purpose.SITEMAP_STANDARD)
        obs.sitemaps.append(sf)
        if sf.response is not None and sf.response.skipped:
            break
        if sf.valid:
            if sf.response is not None and sf.evidence_body is not None and not stored:
                stored = services.artifacts.put_bytes(art.SITEMAP, sf.evidence_body)
            _fetch_child(services, obs, sf)
            break


def fetch_feed(services: "Services", obs: "Observations") -> None:
    """Step 3f."""
    links = obs.home.links if obs.home else None
    linked = links.feeds if links else []
    candidates = [u for u in linked if domains.is_same_site(u, obs.registrable)]
    if not candidates:
        _note_skip(obs, Purpose.FEED, linked[0] if linked else "", "off-site" if linked else "not-linked")
        return
    url = candidates[0]
    if not services.guard.admit_feed(url):
        _note_skip(obs, Purpose.FEED, url, "not-admitted")
        return
    resp = services.http.fetch(url, purpose=Purpose.FEED, expect=Expect.XML, max_bytes=MAX_HTML_BYTES)
    _note_response(obs, Purpose.FEED, resp)
    feed = FeedFetch(url=url, response=resp)
    if resp.usable and resp.status == 200 and resp.body:
        doc = parse_feed(resp.text()[0])
        feed.doc = doc if doc.kind in (DocKind.RSS, DocKind.ATOM) else None
    if resp.status is not None and resp.body_read:
        services.artifacts.put_bytes(art.FEED, resp.body)
    obs.feed = feed


_PAGE_ARTIFACTS: dict[str, tuple[str, str]] = {
    "interna": (art.INTERNA_HTML, art.INTERNA_HEADERS),
    "formulario": (art.FORM_HTML, "headers-formulario.txt"),
}


def fetch_page(services: "Services", url: str, role: str, purpose: str) -> "PageFetch":
    """GET one HTML page, store body and headers as evidence, discover its links."""
    p = Purpose(purpose)
    resp = services.http.fetch(url, purpose=p, expect=Expect.HTML)
    if role in _PAGE_ARTIFACTS:
        body_name, headers_name = _PAGE_ARTIFACTS[role]
    else:
        stem = _safe_name(role.split(":", 1)[-1]) if ":" in role else _safe_name(role)
        prefix = _safe_name(role.split(":", 1)[0]) if ":" in role else "pagina"
        body_name, headers_name = f"{prefix}-{stem}.html", f"headers-{prefix}-{stem}.txt"
    # Two roles can sanitize to the same name ("es_AR" and "es-AR"): never write a name twice.
    taken = services.artifacts.written_map()
    n = 2
    base_body, base_headers = body_name, headers_name
    while body_name in taken or headers_name in taken:
        body_name = base_body.replace(".html", f"-{n}.html")
        headers_name = base_headers.replace(".txt", f"-{n}.txt")
        n += 1
    written_body, written_headers = _store_response(services, resp, body_name, headers_name)
    return PageFetch(
        role=role,
        url=url,
        response=resp,
        links=_page_links(resp),
        body_artifact=written_body,
        headers_artifact=written_headers,
    )


def _home_anchor_for(obs: Observations, url: str) -> str | None:
    """The home anchor that denotes the same page as ``url`` (compare_key), or None."""
    links = obs.home.links if obs.home else None
    if links is None:
        return None
    wanted = domains.compare_key(url)
    return next((a for a in links.anchors if domains.compare_key(a) == wanted), None)


def fetch_linked_pages(config: "RunConfig", services: "Services", obs: "Observations") -> None:
    """Step 3g: interna and form page, each only if the home links it."""
    links = obs.home.links if obs.home else None
    robots = obs.robots.parsed if obs.robots and obs.robots.state is RobotsState.OK else None

    if config.interna:
        anchor = _home_anchor_for(obs, config.interna)
        reused = _fetched_page(obs, anchor) if anchor is not None else None
        if reused is not None:
            obs.interna = dataclasses.replace(reused, role="interna")
            obs.interna_source = "cli"
        elif anchor is not None and services.guard.admit_linked([anchor], purpose=Purpose.INTERNA, source="home <a href> (--inner-page)"):
            obs.interna = fetch_page(services, anchor, "interna", Purpose.INTERNA)
            obs.interna_source = "cli"
            _note_response(obs, Purpose.INTERNA, obs.interna.response)  # type: ignore[arg-type]
        else:
            obs.interna = PageFetch(role="interna", url=config.interna, note="interna no enlazada desde la portada")
            obs.interna_source = "cli"
            _note_skip(obs, Purpose.INTERNA, config.interna, "not-linked")
    elif links is not None:
        url = select_interna(links, obs.registrable, robots)
        if url is not None and services.guard.admit_linked([url], purpose=Purpose.INTERNA, source="home <a href> (auto)"):
            obs.interna = fetch_page(services, url, "interna", Purpose.INTERNA)
            obs.interna_source = "auto"
            _note_response(obs, Purpose.INTERNA, obs.interna.response)  # type: ignore[arg-type]
        else:
            _note_skip(obs, Purpose.INTERNA, "", "not-linked")

    if config.form_page:
        anchor = _home_anchor_for(obs, config.form_page)
        reused = _fetched_page(obs, anchor) if anchor is not None else None
        if reused is not None:
            obs.form_page = dataclasses.replace(reused, role="formulario")
        elif anchor is not None and services.guard.admit_linked([anchor], purpose=Purpose.FORM_PAGE, source="home <a href> (--form-page)"):
            obs.form_page = fetch_page(services, anchor, "formulario", Purpose.FORM_PAGE)
            _note_response(obs, Purpose.FORM_PAGE, obs.form_page.response)  # type: ignore[arg-type]
        else:
            obs.form_page = PageFetch(role="formulario", url=config.form_page, note="página del formulario no enlazada desde la portada")
            _note_skip(obs, Purpose.FORM_PAGE, config.form_page, "not-linked")


def _fetched_page(obs: Observations, url: str) -> PageFetch | None:
    """A page already fetched in this run under the same compare_key (never requested twice).

    The home counts too: an --inner-page or a hreflang alternate that IS the home
    reuses load 1 instead of requesting H a fourth time.
    """
    key = domains.compare_key(url)
    for page in (obs.interna, obs.form_page, *obs.hreflang_pages):
        if page is not None and page.response is not None and not page.response.skipped:
            if domains.compare_key(page.url) == key:
                return page
    home = obs.home
    if home is not None and home.response is not None and obs.canonical_url is not None:
        if key in (domains.compare_key(obs.canonical_url), domains.compare_key(home.url)):
            return home
    return None


def fetch_og_image(services: "Services", obs: "Observations") -> None:
    """Step 3h."""
    links = obs.home.links if obs.home else None
    if links is None or not links.og_images:
        _note_skip(obs, Purpose.OG_IMAGE, "", "not-linked")
        return
    url = links.og_images[0]
    if not services.guard.admit_og_image(url):
        _note_skip(obs, Purpose.OG_IMAGE, url, "not-admitted")
        return
    resp = services.http.fetch(url, purpose=Purpose.OG_IMAGE, expect=Expect.IMAGE, max_bytes=MAX_IMAGE_BYTES)
    _note_response(obs, Purpose.OG_IMAGE, resp)
    fetch = OgImageFetch(url=url, response=resp)
    if resp.skipped:
        fetch.error = f"skipped:{resp.skipped}"
    elif resp.error:
        fetch.error = _error_label(resp)
    elif resp.challenge:
        fetch.error = "challenged"
    elif resp.status == 200 and resp.body:
        fetch.image = image_info(resp.body)
        if fetch.image is None:
            fetch.error = "tamaño no legible"
    obs.og_image = fetch
    services.artifacts.put_json(
        art.OG_IMAGE,
        {
            "url": url,
            "url_final": resp.final_url,
            "estado_http": resp.status,
            "content_type": resp.content_type,
            "content_length": resp.header("Content-Length"),
            "bytes_leidos": len(resp.body),
            "truncado": resp.truncated,
            "saltos": len(resp.redirects),
            "formato": fetch.image.format if fetch.image else None,
            "ancho": fetch.image.width if fetch.image else None,
            "alto": fetch.image.height if fetch.image else None,
            "desafio": resp.challenge,
            "error": fetch.error,
        },
    )


def fetch_hreflang(services: "Services", obs: "Observations") -> None:
    """Step 3i."""
    links = obs.home.links if obs.home else None
    if links is None or not links.hreflang or obs.canonical_url is None:
        return
    h_key = domains.compare_key(obs.canonical_url)
    chosen: list[tuple[str, str]] = []
    seen: set[str] = set()
    for code, url in links.hreflang:
        if not domains.is_same_site(url, obs.registrable):
            continue  # alternates on another domain are not fetched 
        key = domains.compare_key(url)
        if key == h_key or key in seen:
            continue
        seen.add(key)
        chosen.append((code, url))
        if len(chosen) >= MAX_HREFLANG_ALTERNATES:
            break
    summary: list[dict[str, Any]] = []
    for code, url in chosen:
        reused = _fetched_page(obs, url)
        if reused is not None:
            page = dataclasses.replace(reused, role=f"hreflang:{code}")
        elif services.guard.admit_linked([url], purpose=Purpose.HREFLANG, source="home <link rel=alternate hreflang>"):
            page = fetch_page(services, url, f"hreflang:{code}", Purpose.HREFLANG)
            _note_response(obs, Purpose.HREFLANG, page.response)  # type: ignore[arg-type]
        else:
            _note_skip(obs, Purpose.HREFLANG, url, "not-admitted")
            continue
        obs.hreflang_pages.append(page)
        r = page.response
        summary.append(
            {
                "codigo": code,
                "url": url,
                "estado_http": r.status if r else None,
                "url_final": r.final_url if r else None,
                "desafio": r.challenge if r else None,
                "artefacto": page.body_artifact,
            }
        )
    if summary:
        services.artifacts.put_json(art.HREFLANG, summary)


def _probe_from_response(url: str, resp: Response, reused_from: str | None = None) -> LinkProbe:
    probe = LinkProbe(url=url, reused_from=reused_from)
    probe.statuses = [hop.status for hop in resp.redirects]
    if resp.status is not None and resp.stopped_at is None:
        probe.statuses.append(resp.status)
    probe.final_url = resp.final_url if resp.status is not None else None
    probe.final_status = resp.status
    probe.hops = len(resp.redirects)
    probe.left_site = resp.left_site
    probe.private = resp.denied_redirect  # a login or admin page: never requested, not broken
    probe.challenged = bool(resp.challenge)
    probe.error = _error_label(resp)
    if resp.hops_exceeded and probe.error is None:
        probe.error = "hops-exceeded"
    return probe


def check_links(services: "Services", obs: "Observations") -> None:
    """Step 3j."""
    links = obs.home.links if obs.home else None
    if links is None:
        return
    robots = obs.robots.parsed if obs.robots and obs.robots.state is RobotsState.OK else None
    selection = select_link_checks(links, obs.registrable, robots)
    obs.links.selection = selection

    already: dict[str, tuple[str, Response]] = {}
    for page in (obs.interna, obs.form_page, *obs.hreflang_pages):
        if page is not None and page.response is not None and not page.response.skipped:
            already.setdefault(domains.compare_key(page.url), (page.role, page.response))
    if obs.canonical_url and obs.home is not None and obs.home.response is not None:
        already.setdefault(domains.compare_key(obs.canonical_url), ("home", obs.home.response))

    to_request = [u for u in selection.selected if domains.compare_key(u) not in already]
    admitted = {domains.compare_key(u) for u in services.guard.admit_linked(to_request, purpose=Purpose.LINK_CHECK, source="home <a href>")}
    for url in selection.selected:
        key = domains.compare_key(url)
        if key in already:
            role, resp = already[key]
            obs.links.probes.append(_probe_from_response(url, resp, reused_from=role))
            continue
        if key not in admitted:
            obs.links.probes.append(LinkProbe(url=url, error="not-admitted"))
            continue
        resp = services.http.fetch(url, purpose=Purpose.LINK_CHECK, expect=Expect.ANY, headers_only=True)
        _note_response(obs, Purpose.LINK_CHECK, resp)
        obs.links.probes.append(_probe_from_response(url, resp))
    services.artifacts.put_json(
        art.LINKS,
        {
            "seleccion": {
                "elegidos": list(selection.selected),
                "salteados": [{"url": u, "motivo": r} for u, r in selection.skipped],
                "candidatos": selection.total_candidates,
                "tope": selection.capped,
            },
            "sondeos": _jsonable(obs.links.probes),
        },
    )


def _visible_wp_version(obs: Observations) -> str | None:
    """The WordPress version the site shows: meta generator, then /wp-includes/ ?ver=, then the feed."""
    home = obs.home.response if obs.home else None
    if home is not None and home.usable and home.body:
        text = home.text()[0]
        for rx in _WP_GENERATOR_RES:
            m = rx.search(text)
            if m:
                return m.group(1)
        links = obs.home.links if obs.home else None
        assets = [a for a in ((links.scripts + links.stylesheets) if links else []) if domains.is_same_site(a, obs.registrable)]
        # Shared with checks/security.py (EXT-02): library assets carry their own ?ver=.
        version = core_version_from_assets(assets)
        if version is not None:
            return version
    if obs.feed is not None and obs.feed.doc is not None:
        return wordpress_version_from_generator(obs.feed.doc.generator)
    return None


def check_mail_domains(services: "Services", obs: "Observations") -> None:
    """Step 4, VIS-21: can the domains of the published mailto: links receive mail?

    The domains come from the mailto: links of the home and of the interna
    (links.LinkSet.mail_domains; an address leaves links.py only as the local
    part of an institutional role address, LinkSet.role_locals, kept per domain
    with the page it was first seen on). The survey also records whether the
    interna was read whole and what the home's anchor says it is (interna_kind).
    Free mail services (domains.FREE_MAIL_DOMAINS) are never asked; at most
    MAX_MAIL_DOMAINS domains are, in document order (home first). For each:
    MX; only when MX has no record (NODATA), A; only when A has none too, AAAA
    (RFC 5321 5.1: without MX, mail goes to the A/AAAA address). The site's own
    domain reuses the MX answer of step 2 (never asked twice). Every question
    goes through the same DohClient as step 2 (DoH endpoints, scope guard,
    request log; APIs are sequential and never paced, like step 2). Nothing is
    asked when the control lookup of step 2 failed or was not made (a shared
    domain): an NXDOMAIN is only believed from a resolver that answered the
    control. The evidence is MAIL_DOMAINS (dominios-correo.json).
    """
    found: list[tuple[str, str]] = []
    roles: dict[str, tuple[str, str]] = {}  # domain -> (role local part, page), the first one seen (home first)
    survey = MailDomainSurvey()
    obs.mail_domains = survey
    for role, page in (("inicio", obs.home), ("interna", obs.interna)):
        links = page.links if page is not None else None
        resp = page.response if page is not None else None
        if role == "interna":
            if links is None or resp is None or resp.truncated or resp.short_body:
                continue  # a cut body could cut an address in half
            survey.interna_read = True
            home_links = obs.home.links if obs.home is not None else None
            survey.interna_kind = interna_kind(page.url, home_links) if home_links is not None else None
        for d in links.mail_domains if links is not None else []:
            found.append((d, role))
        for d, local in (links.role_locals.items() if links is not None else []):
            roles.setdefault(d, (local, role))
    order: list[str] = []
    pages: dict[str, list[str]] = {}
    for d, role in found:
        if d in domains.FREE_MAIL_DOMAINS:
            if d not in survey.free_mail:
                survey.free_mail.append(d)
            continue
        if d not in pages:
            pages[d] = []
            order.append(d)
        if role not in pages[d]:
            pages[d].append(role)
    if not found:
        return
    bundle = obs.dns
    if obs.shared_parent:
        survey.not_queried = "shared-domain"
    elif bundle is None or bundle.site is None:
        survey.not_queried = "dns-error"
    elif not bundle.control_ok:
        survey.not_queried = "no-control"
    for d in order[:MAX_MAIL_DOMAINS]:
        local, role_page = roles.get(d, (None, None))
        check = MailDomainCheck(domain=d, pages=pages[d], role_local=local, role_page=role_page)
        survey.checked.append(check)
        if survey.not_queried is not None or bundle is None or bundle.site is None:
            continue
        site = bundle.site
        if _same_domain(d, site.domain) and site.mx is not None:
            check.mx, check.mx_from_site = site.mx, True
        else:
            check.mx = services.doh.query(d, "MX")
        if check.mx.status is DnsStatus.NODATA:
            check.a = services.doh.query(d, "A")
            if check.a.status is DnsStatus.NODATA:
                check.aaaa = services.doh.query(d, "AAAA")
    survey.over_cap = order[MAX_MAIL_DOMAINS:]
    payload = {
        "dominios": [
            {
                "dominio": c.domain,
                "paginas": list(c.pages),
                "mx": _jsonable(c.mx),
                "a": _jsonable(c.a),
                "aaaa": _jsonable(c.aaaa),
                "mx_del_sitio": c.mx_from_site,
            }
            for c in survey.checked
        ],
        "gratuitos": list(survey.free_mail),
        "fuera_del_tope": list(survey.over_cap),
        "sin_consultar": survey.not_queried,
        "interna_leida": survey.interna_read,
        "tipo_de_interna": survey.interna_kind,
    }
    services.artifacts.put_json(art.MAIL_DOMAINS, payload)


def collect_after_site(config: "RunConfig", services: "Services", obs: "Observations") -> None:
    """Step 4."""
    if obs.home_unreachable or obs.final_host_no_contact:
        return
    try:
        version = _visible_wp_version(obs)
        if version is not None:
            obs.wp_status = services.wp.status_of(version)
    except ScopeError:
        raise
    except Exception as exc:
        _record_error(services, obs, "wordpress", exc)
    try:
        check_mail_domains(services, obs)
    except ScopeError:
        raise
    except Exception as exc:
        _record_error(services, obs, "mail domains", exc)
    if config.observatory and services.observatory is not None and obs.canonical_host:
        try:
            obs.observatory = services.observatory.scan(obs.canonical_host)
        except ScopeError:
            raise
        except Exception as exc:
            _record_error(services, obs, "observatory", exc)
