"""Regression tests of the network layer: home copies that are not challenges,
redirects to denied paths, a home that moved to another domain, TLS failures,
shared domains, og:image SSRF, throttling, personal data in the evidence, the
deny list, hostile parsing time, control characters, decoding and the total
deadline. Expected values are written by hand per case.
"""

from __future__ import annotations

import gzip
import json
import re
import socket
import threading
import time
import unittest
from unittest import mock

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder

from sitecheck import domains
from sitecheck.challenge import ChallengeDetector, Expect
from sitecheck.credentials import Redactor
from sitecheck.endpoints import Endpoints
from sitecheck.httpclient import ClientConfig, HttpClient, LoopbackRoute, Response, _Exchange, decode_body
from sitecheck.links import discover_links, select_interna
from sitecheck.requestlog import RequestLog
from sitecheck.scope import Purpose, ScopeGuard, matches_deny_pattern
from fakeapis import FakeApis, tls_fixture
from fakesite import FakeSite, Route, Scenario
from fixhelp import HTML, control_route, run_e2e, small_home
from sitefixtures import SchoolOptions, default_apis, school_scenario

BASE = "https://www.colegio.test"


def static_scenario(home: bytes, extra: dict[str, Route] | None = None, *, http_apex_200: bool = False) -> Scenario:
    redirect = Route(301, [("Location", f"{BASE}/")])
    page = (
        '<!DOCTYPE html><html lang="es-AR"><head><meta charset="utf-8"><title>Institucional - Colegio Ejemplo</title>'
        '<meta name="description" content="Página institucional del Colegio Ejemplo para las familias."></head><body>'
        + "".join(f"<p>Texto institucional {i} para las familias del colegio.</p>" for i in range(30))
        + "</body></html>"
    ).encode("utf-8")
    routes = {
        "http://colegio.test/": Route(200, list(HTML), home) if http_apex_200 else redirect,
        "https://colegio.test/": redirect,
        "http://www.colegio.test/": redirect,
        f"{BASE}/": Route(200, list(HTML), home),
        "https://control.test/": control_route(),
        f"{BASE}/robots.txt": Route(200, [("Content-Type", "text/plain")], b"User-agent: *\nDisallow:\n"),
        f"{BASE}/institucional/": Route(200, list(HTML), page),
        f"{BASE}/contacto/": Route(200, list(HTML), page.replace(b"Institucional", b"Contacto")),
    }
    routes.update(extra or {})
    return Scenario(name="static", routes=routes)


class _Rig:
    def __init__(self, site: FakeSite, apis: FakeApis, **cfg) -> None:
        self.sleeps = SleepRecorder()
        self.redactor = Redactor([TEST_KEY])
        self.guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test(apis.base), test_loopback=True)
        self.guard.set_canonical(f"{BASE}/")
        self.log = RequestLog(None, self.redactor)
        config = ClientConfig(pace_seconds=0.0, pace_jitter=0.0, challenge_wait=60.0, challenge_pace=6.0, loopback=LoopbackRoute(port=site.port), **cfg)
        self.client = HttpClient(self.guard, self.log, ChallengeDetector(), self.redactor, config, sleeper=self.sleeps)


# ---------------------------------------------------------------------------
# copies of the home are not an anti-bot challenge
# ---------------------------------------------------------------------------


class HomeCopiesAreNotChallengesTest(unittest.TestCase):
    def test_http_variant_serving_the_home_is_not_a_challenge(self) -> None:
        r = run_e2e(static_scenario(small_home(), http_apex_200=True), default_apis())
        self.assertEqual(r.datos["meta"]["eventos_desafio"], [])
        self.assertFalse(r.datos["meta"]["sitio_cortado"])
        ext17 = r.check("EXT-17")
        self.assertEqual(ext17["estado"], "FALLA")
        self.assertEqual(ext17["frase_informe_llena"]["que_se_encontro"], "Escrito con http:// el sitio se abre sin candado")

    def test_index_php_link_is_the_home_not_the_interna(self) -> None:
        home = small_home('<a href="index.php">Inicio</a>')
        links = discover_links(home.decode("utf-8"), f"{BASE}/")
        # the contact page is preferred; index.php is still never the interna.
        self.assertEqual(select_interna(links, "colegio.test", None), f"{BASE}/contacto/")
        r = run_e2e(static_scenario(home, {f"{BASE}/index.php": Route(200, list(HTML), home)}), default_apis())
        self.assertFalse(r.datos["meta"]["sitio_cortado"])
        self.assertEqual(r.datos["meta"]["eventos_desafio"], [])
        self.assertNotIn(f"{BASE}/index.php", r.site_urls)

    def test_markerless_challenge_without_links_is_still_caught(self) -> None:
        # Safety net of the fix: a small page WITHOUT on-site links served for every
        # URL (a markerless challenge) must still cut the host and never prove a FALLA.
        page = small_home(links=False)
        sc = Scenario(name="markerless", challenge=True, challenge_page=Route(200, list(HTML), page))
        r = run_e2e(sc, default_apis())
        self.assertTrue(r.datos["meta"]["sitio_cortado"])
        html_derived = {"VIS-04", "VIS-06", "VIS-15", "VIS-16", "VIS-17", "EXT-24", "EXT-25", "VIS-07", "VIS-05"}
        for c in r.datos["checks"]:
            if c["id"] in html_derived:
                self.assertNotEqual(c["estado"], "FALLA", c["id"])

    def test_robots_answered_with_the_spa_home_is_not_a_challenge(self) -> None:
        home = small_home(pad=260)
        self.assertGreater(len(home), 20 * 1024)
        r = run_e2e(static_scenario(home, {f"{BASE}/robots.txt": Route(200, list(HTML), home)}), default_apis())
        self.assertEqual(r.datos["meta"]["eventos_desafio"], [])
        self.assertFalse(r.datos["meta"]["sitio_cortado"])
        self.assertIn(f"{BASE}/institucional/", r.site_urls)
        vis01 = r.check("VIS-01")
        self.assertNotEqual(vis01["estado"], "NO_VERIFICADO")
        self.assertEqual(vis01["mediciones"]["robots_state"], "soft-404")

    def test_og_image_pointing_to_a_big_html_page_is_not_a_challenge(self) -> None:
        og = (
            f'<meta property="og:title" content="Colegio Ejemplo"><meta property="og:description" content="Educación inicial y primaria.">'
            f'<meta property="og:image" content="{BASE}/adjunto/portada/">'
        )
        home = small_home(pad=60).replace(b"</head>", og.encode("utf-8") + b"</head>")
        attachment = small_home(pad=260).replace(b"<h1>Colegio Ejemplo</h1>", b"<h1>Adjunto portada</h1>")
        r = run_e2e(static_scenario(home, {f"{BASE}/adjunto/portada/": Route(200, list(HTML), attachment)}), default_apis())
        self.assertEqual(r.datos["meta"]["eventos_desafio"], [])
        vis06 = r.check("VIS-06")
        self.assertEqual(vis06["estado"], "FALLA")


# ---------------------------------------------------------------------------
# a redirect the SITE issues to a denied path is not a bug (exit 50)
# ---------------------------------------------------------------------------


class SiteRedirectToDeniedPathTest(unittest.TestCase):
    def test_guard_refuses_without_raising(self) -> None:
        g = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test("http://127.0.0.1:9"), test_loopback=True)
        g.set_canonical(f"{BASE}/")
        self.assertFalse(g.check_redirect(f"{BASE}/intranet/", f"{BASE}/wp-login.php?redirect_to=%2Fintranet%2F", Purpose.LINK_CHECK, 1))
        self.assertTrue(any("deny" in r["reason"] for r in g.refusals))

    def test_link_to_a_private_area_keeps_the_run(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/contacto/"] = Route(302, [("Location", "/wp-login.php?redirect_to=%2Fcontacto%2F")])
        r = run_e2e(sc, default_apis())
        self.assertEqual(r.code, 0, r.err)
        self.assertIn("informe.md", r.files)
        self.assertEqual(len(r.datos["checks"]), 37)  # VIS-20 and VIS-21 
        self.assertFalse(any("wp-login" in u for u in r.site_urls))
        refused = [x for x in r.log_lines() if x["outcome"] == "refused-scope"]
        self.assertTrue(any("wp-login" in x["url"] for x in refused))
        vis09 = r.check("VIS-09")["mediciones"]
        self.assertEqual(vis09["n404"], 1)
        self.assertEqual(vis09["n_private"], 1)

    def test_home_behind_a_login_is_exit_3_not_50(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/"] = Route(302, [("Location", "/wp-login.php?redirect_to=%2F")])
        r = run_e2e(sc, default_apis())
        self.assertEqual(r.code, 3, r.err)
        self.assertFalse(any("wp-login" in u for u in r.site_urls))


# ---------------------------------------------------------------------------
# the home redirects to another registrable domain
# ---------------------------------------------------------------------------


class HomeMovedToAnotherDomainTest(unittest.TestCase):
    def _scenario(self) -> Scenario:
        sc = school_scenario()
        sc.routes[f"{BASE}/"] = Route(301, [("Location", "https://www.colegionuevo.test/")])
        return sc

    def test_says_where_it_went(self) -> None:
        r = run_e2e(self._scenario(), default_apis())
        self.assertEqual(r.code, 3)
        self.assertIn("colegionuevo.test", r.out + r.err)

    def test_destination_on_no_contactar_is_exit_10(self) -> None:
        r = run_e2e(self._scenario(), default_apis(), exclude="colegionuevo.test\n")
        self.assertEqual(r.code, 10)


# ---------------------------------------------------------------------------
# a TLS failure on the home is measured, not "no respondió"
# ---------------------------------------------------------------------------


def _tls_failing_exchange(always: bool):
    original = HttpClient._exchange

    def fake(self, method, url, *args, **kwargs):  # type: ignore[no-untyped-def]
        relaxed = getattr(self, "_relaxed_hosts", set())
        if url.startswith(f"{BASE}/") and (always or "www.colegio.test" not in relaxed):
            return _Exchange(error="tls:10" if always else "tls:1", ms=1.0)
        return original(self, method, url, *args, **kwargs)

    return fake


class HomeTlsFailureTest(unittest.TestCase):
    def test_expired_lock_is_ext07_failure(self) -> None:
        apis = default_apis()
        expired = tls_fixture("www.colegio.test", days_from_now=-3)
        expired.update(ok=False, verify_code=10, verify_message="certificate has expired", error="verify")
        apis.tls["www.colegio.test"] = expired
        with mock.patch.object(HttpClient, "_exchange", _tls_failing_exchange(always=True)):
            r = run_e2e(school_scenario(), apis)
        self.assertNotEqual(r.code, 3, r.err)
        self.assertIn("/tls", r.api_paths)
        ext07 = r.check("EXT-07")
        self.assertEqual(ext07["estado"], "FALLA")
        # it, and without the home nothing else is measured, so it stays alone: no mail (exit 20).
        self.assertEqual(r.code, 0, r.err)

    def test_strict_only_failure_retries_the_home_like_a_browser(self) -> None:
        apis = default_apis()
        apis.tls["www.colegio.test"].update(strict_only_failure=True, strict_message="1 strict")
        with mock.patch.object(HttpClient, "_exchange", _tls_failing_exchange(always=False)):
            r = run_e2e(school_scenario(), apis)
        self.assertEqual(r.code, 0, r.err)
        self.assertEqual(r.check("EXT-07")["estado"], "APROBADO")
        self.assertFalse(r.datos["meta"]["portada_no_respondio"])

    def test_inconclusive_windows_code_20_is_exit_3_with_the_tls_reason(self) -> None:
        apis = default_apis()
        apis.tls["www.colegio.test"].update(ok=False, verify_code=20, verify_message="unable to get local issuer", inconclusive=True, error="verify")
        with mock.patch.object(HttpClient, "_exchange", _tls_failing_exchange(always=True)):
            r = run_e2e(school_scenario(), apis)
        self.assertEqual(r.code, 3)
        self.assertIn("no fue concluyente", r.check("EXT-07")["motivo"])


# ---------------------------------------------------------------------------
# a site under someone else's domain
# ---------------------------------------------------------------------------


class SharedDomainTest(unittest.TestCase):
    def test_platform_suffixes(self) -> None:
        for host in ("colegio.blogspot.com", "colegio.blogspot.com.ar", "tienda.mitiendanube.com", "colegio.wixsite.com", "colegio.github.io", "escuela.wordpress.com"):
            self.assertEqual(domains.registrable_domain(host), host, host)
        self.assertEqual(domains.shared_parent("colegio.blogspot.com"), "blogspot.com")

    def test_site_domain_of_a_subdomain(self) -> None:
        self.assertEqual(domains.site_domain("www.colegio.universidad-ejemplo.edu.ar"), "colegio.universidad-ejemplo.edu.ar")
        self.assertEqual(domains.shared_parent("www.colegio.universidad-ejemplo.edu.ar"), "universidad-ejemplo.edu.ar")
        self.assertEqual(domains.site_domain("www.colegio-ejemplo.edu.ar"), "colegio-ejemplo.edu.ar")
        self.assertIsNone(domains.shared_parent("www.colegio-ejemplo.edu.ar"))
        self.assertEqual(domains.site_domain("escuela123.provincia-ejemplo.gov.ar"), "escuela123.provincia-ejemplo.gov.ar")

    def test_a_guard_on_a_public_suffix_is_refused(self) -> None:
        for suffix in ("blogspot.com.ar", "com.ar", "mitiendanube.com"):
            with self.assertRaises(ValueError, msg=suffix):
                ScopeGuard(suffix, f"https://x.{suffix}/", Endpoints())

    def test_guard_never_admits_a_sibling_site(self) -> None:
        g = ScopeGuard(domains.site_domain("colegio.blogspot.com.ar"), "https://colegio.blogspot.com.ar/", Endpoints())
        g.set_canonical("https://colegio.blogspot.com.ar/")
        self.assertEqual(g.admit_linked(["https://otro-colegio.blogspot.com.ar/2024/"], purpose=Purpose.LINK_CHECK, source="t"), [])

    def test_e2e_scope_is_the_site_not_the_network(self) -> None:
        d = "colegio.red.test"
        r = run_e2e(school_scenario(SchoolOptions(domain=d)), default_apis(d), url=f"https://www.{d}/")
        self.assertEqual(r.folder, d)
        hosts = {re.match(r"https?://([^/]+)/", u).group(1) for u in r.site_urls}
        self.assertFalse(hosts & {"red.test", "www.red.test"}, hosts)
        for q in r.api_queries:
            self.assertNotRegex(q, r"(name=|domain/)(_dmarc\.)?red\.test\b", q)
            self.assertNotIn("red.test.dbl", q)
        for cid in ("EXT-05", "EXT-13", "EXT-23"):
            self.assertEqual(r.check(cid)["estado"], "NO_APLICA", cid)
        self.assertGreater(r.check("VIS-09")["mediciones"]["n_selected"], 0)


# ---------------------------------------------------------------------------
# og:image never reaches a private address
# ---------------------------------------------------------------------------


class OgImageSsrfTest(unittest.TestCase):
    def _guard(self) -> ScopeGuard:
        g = ScopeGuard("colegio-ejemplo.com.ar", "https://www.colegio-ejemplo.com.ar/", Endpoints())
        g.set_canonical("https://www.colegio-ejemplo.com.ar/")
        return g

    def test_ip_literals_and_odd_ports_are_refused(self) -> None:
        g = self._guard()
        for url in ("http://192.168.0.1:8080/cgi-bin/x?y=1", "http://127.0.0.1:5678/webhook/abc", "http://169.254.169.254/latest/meta-data/", "https://cdn.example.com:8443/a.png"):
            self.assertFalse(g.admit_og_image(url), url)
        self.assertTrue(g.admit_og_image("https://cdn.example.com/a.png"))
        for to in ("http://10.1.2.3:22/", "http://127.0.0.1:5678/webhook/abc", "http://[::1]/x"):
            self.assertFalse(g.check_redirect("https://cdn.example.com/a.png", to, Purpose.OG_IMAGE, 1), to)
        self.assertEqual(g.admit_linked(["https://www.colegio-ejemplo.com.ar:8443/x"], purpose=Purpose.LINK_CHECK, source="t"), [])

    def test_a_name_that_resolves_to_a_private_address_is_never_connected(self) -> None:
        g = self._guard()
        self.assertTrue(g.admit_og_image("https://cdn.example.com/a.png"))
        calls: list[tuple[str, int]] = []

        def resolver(host: str, port: int) -> list[str]:
            calls.append((host, port))
            return ["127.0.0.1"]

        client = HttpClient(g, RequestLog(None, Redactor([])), ChallengeDetector(), Redactor([]), ClientConfig(pace_seconds=0, pace_jitter=0), sleeper=SleepRecorder(), resolver=resolver)
        resp = client.fetch("https://cdn.example.com/a.png", purpose=Purpose.OG_IMAGE, expect=Expect.IMAGE)
        self.assertEqual(calls, [("cdn.example.com", 443)])
        self.assertEqual(resp.error, "blocked-address")
        self.assertIsNone(resp.status)

    def test_every_checked_public_address_is_tried_and_only_those(self) -> None:
        g = self._guard()
        self.assertTrue(g.admit_og_image("https://cdn.example.com/a.png"))
        tried: list[str] = []

        def fake_connect(address, timeout=None, source_address=None):  # type: ignore[no-untyped-def]
            tried.append(address[0])
            raise ConnectionRefusedError("refused in the test")

        resolver = lambda host, port: ["10.0.0.7", "2606:4700:4700::1111", "1.1.1.1"]  # noqa: E731
        client = HttpClient(g, RequestLog(None, Redactor([])), ChallengeDetector(), Redactor([]), ClientConfig(pace_seconds=0, pace_jitter=0), sleeper=SleepRecorder(), resolver=resolver)
        with mock.patch("sitecheck.httpclient.socket.create_connection", fake_connect):
            resp = client.fetch("https://cdn.example.com/a.png", purpose=Purpose.OG_IMAGE, expect=Expect.IMAGE)
        self.assertEqual(tried, ["2606:4700:4700::1111", "1.1.1.1"], "the private address is never tried")
        self.assertEqual(resp.error, "refused")

    def test_e2e_og_image_to_loopback_sends_nothing(self) -> None:
        victim = FakeSite(Scenario(name="victim"))
        with victim:
            sc = school_scenario()
            route = sc.routes[f"{BASE}/"]
            target = f"http://127.0.0.1:{victim.port}/admin/reboot?confirm=1"
            route.body = route.body.replace(f"{BASE}/wp-content/uploads/2024/03/portada.png".encode(), target.encode())
            run_e2e(sc, default_apis())
            self.assertEqual(victim.requests, [])


# ---------------------------------------------------------------------------
# 429, 503 + Retry-After and repeated 403 slow the tool down, then cut
# ---------------------------------------------------------------------------


class ThrottleTest(unittest.TestCase):
    def _sc(self, routes: dict[str, Route]) -> Scenario:
        sc = school_scenario()
        sc.routes.update(routes)
        return sc

    def test_429_waits_retry_after_once_then_cuts(self) -> None:
        busy = Route(429, [("Content-Type", "text/html"), ("Retry-After", "120")], b"<html><body>Too many</body></html>")
        with FakeSite(self._sc({f"{BASE}/a/": busy, f"{BASE}/b/": busy})) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/", f"{BASE}/b/"], purpose=Purpose.LINK_CHECK, source="t")
            first = rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertIn(120.0, rig.sleeps.calls)
            self.assertTrue(rig.client.blocked)
            self.assertTrue((first.challenge or "").startswith("e:"))
            self.assertEqual(rig.client.fetch(f"{BASE}/b/", purpose=Purpose.LINK_CHECK, headers_only=True).skipped, "blocked")

    def test_retry_after_is_capped_at_two_minutes(self) -> None:
        busy = Route(503, [("Retry-After", "600")], b"")
        with FakeSite(self._sc({f"{BASE}/a/": busy})) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/"], purpose=Purpose.LINK_CHECK, source="t")
            rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertIn(120.0, rig.sleeps.calls)
            self.assertNotIn(600.0, rig.sleeps.calls)

    def test_two_plain_403_on_distinct_urls_are_not_a_stop_signal(self) -> None:
        # Audit (changed on purpose): two ordinary pages that answer 403
        # (directories without an index) are not the site asking to slow down. A 403
        # counts only with Retry-After or on a URL that answered 2xx earlier
        # (test_regressions_hardening.ForbiddenThrottleTest).
        forbidden = Route(403, [("Content-Type", "text/html")], b"<html><body>Forbidden</body></html>")
        with FakeSite(self._sc({f"{BASE}/a/": forbidden, f"{BASE}/b/": forbidden})) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/", f"{BASE}/b/"], purpose=Purpose.LINK_CHECK, source="t")
            one = rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertIsNone(one.challenge, "a single 403 is just a page")
            two = rig.client.fetch(f"{BASE}/b/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertIsNone(two.challenge)
            self.assertFalse(rig.client.blocked)

    def test_two_503_on_distinct_urls_is_a_stop_signal(self) -> None:
        # A WAF page behind a 503 is never read on a headers-only link check: the
        # repetition is the signal (skeptic run "waf503+marker").
        waf = Route(503, [("Content-Type", "text/html")], b"<html><title>Attention Required</title>Sucuri Website Firewall</html>")
        with FakeSite(self._sc({f"{BASE}/a/": waf, f"{BASE}/b/": waf})) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/", f"{BASE}/b/"], purpose=Purpose.LINK_CHECK, source="t")
            one = rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertIsNone(one.challenge, "a single 503 is just a server error")
            rig.client.fetch(f"{BASE}/b/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue(rig.client.blocked)

    def test_throttled_links_are_not_verified(self) -> None:
        busy = Route(429, [("Retry-After", "120")], b"")
        routes = {f"{BASE}/niveles/inicial/": busy, f"{BASE}/inscripciones/": busy, f"{BASE}/contacto/": busy, f"{BASE}/historia/": busy}
        r = run_e2e(self._sc(routes), default_apis())
        self.assertTrue(r.datos["meta"]["sitio_cortado"])
        vis09 = r.check("VIS-09")
        self.assertEqual(vis09["mediciones"]["n_other_errors"], 0)
        self.assertEqual(vis09["estado"], "NO_VERIFICADO")
        self.assertEqual(vis09["motivo"], "el sitio pidió bajar el ritmo")


# ---------------------------------------------------------------------------
# no personal data in the evidence
# ---------------------------------------------------------------------------


class EvidencePersonalDataTest(unittest.TestCase):
    def test_geometry_and_dates_are_not_phone_numbers(self) -> None:
        from sitecheck.artifacts import mask_personal_data

        svg = '<svg viewBox="0 0 400 300"><path d="M 212,206 A 27,27 0 0 1 244,206 L 10 20 30 40"/><polygon points="0 0 100 100 200 200"/></svg>'
        self.assertEqual(mask_personal_data(svg), svg)
        kept = "<p>&copy; 1960 - 2026</p><time>2024-05-20</time> 20/05/2024 ver=6.1.1"
        self.assertEqual(mask_personal_data(kept), kept)
        self.assertEqual(mask_personal_data("<p>Tel 11 5555-1234</p>"), "<p>Tel [numero]</p>")

    def test_evidence_is_masked(self) -> None:
        sc = school_scenario()
        route = sc.routes[f"{BASE}/"]
        route.body = route.body.replace(b"</main>", "<p>Directora: María Gómez, maria.gomez@colegio.test, cel 11 5555-1234</p></main>".encode("utf-8"))
        r = run_e2e(sc, default_apis())
        self.assertIn("home.html", r.evidence)
        for name, data in r.evidence.items():
            for bad in (b"maria.gomez@", b"info@colegio.test", b"5491123456789", b"5555-1234", b"/author/admin", b"usuario-autor"):
                self.assertNotIn(bad, data, f"{name}: {bad!r}")
            if name.endswith(".json"):
                json.loads(data.decode("utf-8"))
        self.assertIn(b"2024-05-20", r.evidence["sitemap.xml"], "dates are not phone numbers")


# ---------------------------------------------------------------------------
# holes in the deny list
# ---------------------------------------------------------------------------


class DenyListHolesTest(unittest.TestCase):
    def test_patterns(self) -> None:
        for path in ("/wp-admin?x=1", "/WP-ADMIN?x=1", "/?rest_route=/wp/v2/users", "/index.php?rest_route=%2Fwp%2Fv2%2Fusers", "/wp-sitemap-users-1.xml", "/author-sitemap.xml", "/?p=1&rest_route=/x"):
            self.assertIsNotNone(matches_deny_pattern(path), path)
        for path in ("/wp-adminfoo/", "/sitemap.xml", "/page-sitemap.xml"):
            self.assertIsNone(matches_deny_pattern(path), path)


# ---------------------------------------------------------------------------
# hostile sitemaps, feeds and robots.txt run in bounded time
# ---------------------------------------------------------------------------


class HostileParsingTimeTest(unittest.TestCase):
    def test_sitemap_with_unclosed_locs(self) -> None:
        from sitecheck.sitemapfeed import parse_sitemap

        t0 = time.perf_counter()
        doc = parse_sitemap("<urlset>" + "<loc>" * 16000)
        self.assertLess(time.perf_counter() - t0, 0.5)
        self.assertEqual(doc.locs, [])

    def test_feed_with_unclosed_items(self) -> None:
        from sitecheck.sitemapfeed import parse_feed

        t0 = time.perf_counter()
        parse_feed("<rss>" + "<item>" * 16000)
        self.assertLess(time.perf_counter() - t0, 0.5)

    def test_robots_with_many_wildcards(self) -> None:
        from sitecheck.robots import is_allowed, parse_robots

        robots = parse_robots("User-agent: *\nDisallow: /" + "*a" * 10 + "*b\n")
        t0 = time.perf_counter()
        self.assertTrue(is_allowed(robots, "/" + "a" * 39, "*"))
        self.assertLess(time.perf_counter() - t0, 0.2)


# ---------------------------------------------------------------------------
# no terminal control characters from the site reach the console
# ---------------------------------------------------------------------------


class ControlCharactersTest(unittest.TestCase):
    def test_audit_url_and_console(self) -> None:
        import io

        from sitecheck import pipeline, scope

        nasty = "https://www.colegio.test/wp-login.php?x=\x1b]0;PWNED\x07\x1b[1A\x1b[2KCodigo 0"
        cleaned = scope._audit_url(nasty)
        self.assertNotRegex(cleaned, r"[\x00-\x1f\x7f-\x9f]")
        out, err = io.StringIO(), io.StringIO()
        con = pipeline._Console(out, err)
        con.warn("aviso " + nasty)
        con.say("dice " + nasty)
        self.assertNotRegex(out.getvalue() + err.getvalue().replace("\n", ""), r"[\x00-\x09\x0b-\x1f\x7f-\x9f]")


# ---------------------------------------------------------------------------
# decoding and transport
# ---------------------------------------------------------------------------


class DecodingTest(unittest.TestCase):
    def test_no_charset_and_not_utf8_reads_as_windows_1252(self) -> None:
        body = "<html><head><title>Colegio Ejemplo Sur | Educación</title></head></html>".encode("latin-1")
        resp = Response(url=f"{BASE}/", final_url=f"{BASE}/", purpose=Purpose.HOME, kind="site", status=200, headers=[("Content-Type", "text/html")], body=body)
        text, bad = resp.text()
        self.assertIn("Ejemplo Sur | Educación", text)
        self.assertEqual(bad, 0)

    def test_truncated_utf8_stays_utf8(self) -> None:
        body = ("<html><title>Educación</title>" + "ñ" * 10).encode("utf-8")[:-1]
        resp = Response(url=f"{BASE}/", final_url=f"{BASE}/", purpose=Purpose.HOME, kind="site", status=200, headers=[("Content-Type", "text/html")], body=body)
        self.assertIn("Educación", resp.text()[0])


    def test_raw_utf8_location_is_read_as_utf8(self) -> None:
        sc = school_scenario()
        raw = "/inscripción-2027/".encode("utf-8").decode("latin-1")
        sc.routes[f"{BASE}/inscripciones/"] = Route(301, [("Location", raw)])
        sc.routes[f"{BASE}/inscripci%C3%B3n-2027/"] = Route(200, list(HTML), b"<html><body>ok</body></html>")
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/inscripciones/"], purpose=Purpose.LINK_CHECK, source="t")
            r = rig.client.fetch(f"{BASE}/inscripciones/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertEqual(r.status, 200)
            self.assertIn(f"{BASE}/inscripci%C3%B3n-2027/", site.requested_urls())

    def test_bytes_after_the_gzip_member_are_ignored(self) -> None:
        html = b"<html><head><title>x</title></head><body>" + b"hola " * 40 + b"</body></html>"
        for tail in (b"\r\n", b"\x00" * 8):
            decoded, undecodable, truncated = decode_body(gzip.compress(html) + tail, "gzip", 1 << 20)
            self.assertIsNone(undecodable)
            self.assertEqual(decoded, html)

    def test_gzipped_sitemap_is_read(self) -> None:
        sc = school_scenario()
        urlset = (
            '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"<url><loc>{BASE}/</loc></url><url><loc>{BASE}/institucional/</loc></url></urlset>"
        ).encode("utf-8")
        sc.routes[f"{BASE}/robots.txt"] = Route(200, [("Content-Type", "text/plain")], f"User-agent: *\nDisallow:\nSitemap: {BASE}/sitemap.xml.gz\n".encode())
        sc.routes[f"{BASE}/sitemap.xml.gz"] = Route(200, [("Content-Type", "application/x-gzip")], gzip.compress(urlset))
        r = run_e2e(sc, default_apis())
        self.assertEqual(r.check("VIS-02")["estado"], "APROBADO")


class _Tarpit:
    """A local server that sends a response one byte at a time (headers or body)."""

    def __init__(self, drip_headers: bool) -> None:
        self.drip_headers = drip_headers
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self) -> None:
        try:
            conn, _ = self.sock.accept()
        except OSError:
            return
        with conn:
            conn.settimeout(1.0)
            try:
                conn.recv(4096)
                head = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 100\r\nX-Pad: "
                if self.drip_headers:
                    conn.sendall(b"HTTP/1.1 200 OK\r\n")
                    payload = b"X-Slow: " + b"a" * 200
                else:
                    conn.sendall(head + b"x\r\n\r\n")
                    payload = b"b" * 100
                for ch in payload:
                    if self.stop.is_set():
                        return
                    conn.sendall(bytes([ch]))
                    time.sleep(0.3)
            except OSError:
                return

    def __enter__(self) -> "_Tarpit":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop.set()
        self.sock.close()


class TotalDeadlineTest(unittest.TestCase):
    def _fetch(self, drip_headers: bool) -> tuple[Response, float]:
        with _Tarpit(drip_headers) as tarpit:
            guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test("http://127.0.0.1:9"), test_loopback=True)
            cfg = ClientConfig(pace_seconds=0, pace_jitter=0, read_timeout=1.0, total_deadline=1.5, loopback=LoopbackRoute(port=tarpit.port))
            client = HttpClient(guard, RequestLog(None, Redactor([])), ChallengeDetector(), Redactor([]), cfg, sleeper=SleepRecorder())
            t0 = time.perf_counter()
            resp = client.fetch(f"{BASE}/", purpose=Purpose.HOME, expect=Expect.HTML)
            return resp, time.perf_counter() - t0

    def test_dripping_body(self) -> None:
        resp, elapsed = self._fetch(drip_headers=False)
        self.assertEqual(resp.error, "timeout")
        self.assertLess(elapsed, 3.5)

    def test_dripping_headers(self) -> None:
        resp, elapsed = self._fetch(drip_headers=True)
        self.assertEqual(resp.error, "timeout")
        self.assertLess(elapsed, 3.5)


if __name__ == "__main__":
    unittest.main()
