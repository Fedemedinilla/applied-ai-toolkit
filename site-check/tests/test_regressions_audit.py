"""Regression tests for the audit findings fixed in November 2026.

Each test reproduces one confirmed finding and failed before its fix.
"""

from __future__ import annotations

import json
import time
import unittest
from unittest import mock
from pathlib import Path
from typing import Any

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder, run_cli, temp_dir

from sitecheck import runformat

from sitecheck.challenge import ChallengeDetector
from sitecheck.credentials import Redactor
from sitecheck.endpoints import Endpoints
from sitecheck.httpclient import ClientConfig, HttpClient, LoopbackRoute, _declared_length, _Exchange, public_address
from sitecheck.requestlog import RequestLog
from sitecheck.scope import Purpose, RedirectVerdict, ScopeGuard
from fakeapis import FakeApis
from fakesite import FakeSite, Route
from fixhelp import run_e2e
from sitefixtures import default_apis, school_scenario

BASE = "https://colegio.test"
EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


class _Rig:
    def __init__(self, site: FakeSite, apis: FakeApis) -> None:
        self.sleeps = SleepRecorder()
        redactor = Redactor([TEST_KEY])
        self.guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test(apis.base), test_loopback=True)
        self.guard.set_canonical(f"{BASE}/")
        config = ClientConfig(pace_seconds=0.0, pace_jitter=0.0, challenge_wait=60.0, challenge_pace=6.0, loopback=LoopbackRoute(port=site.port))
        self.client = HttpClient(self.guard, RequestLog(None, redactor), ChallengeDetector(), redactor, config, sleeper=self.sleeps)


class Nat64AddressTest(unittest.TestCase):
    """public_address looks through the IPv4 address that NAT64 and 6to4 embed."""

    def test_well_known_nat64_prefix_to_private_ipv4_is_refused(self) -> None:
        for ip in ("64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::c0a8:101"):
            with self.subTest(ip=ip):
                self.assertFalse(public_address(ip))

    def test_local_use_nat64_prefix_to_private_ipv4_is_refused(self) -> None:
        self.assertFalse(public_address("64:ff9b:1::a00:1"))

    def test_6to4_to_private_ipv4_is_refused(self) -> None:
        self.assertFalse(public_address("2002:a00:1::1"))
        self.assertFalse(public_address("2002:7f00:1::1"))

    def test_nat64_to_public_ipv4_is_allowed(self) -> None:
        self.assertTrue(public_address("64:ff9b::101:101"))  # 1.1.1.1
        self.assertTrue(public_address("2606:4700:4700::1111"))
        self.assertFalse(public_address("::ffff:10.0.0.1"))


class NonAsciiDigitHeaderTest(unittest.TestCase):
    """str.isdigit() accepts the latin-1 superscripts that http.client can decode."""

    def test_content_length_superscript_is_not_a_length(self) -> None:
        self.assertIsNone(_declared_length([("Content-Length", "²")]))
        self.assertEqual(_declared_length([("Content-Length", "12")]), 12)

    def test_retry_after_superscript_still_cuts_the_host(self) -> None:
        busy = Route(429, [("Content-Type", "text/html"), ("Retry-After", "²")], b"<html><body>Too many</body></html>")
        sc = school_scenario()
        sc.routes.update({f"{BASE}/a/": busy, f"{BASE}/b/": busy})
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/", f"{BASE}/b/"], purpose=Purpose.LINK_CHECK, source="t")
            rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue(rig.client.blocked)
            self.assertEqual(rig.client.fetch(f"{BASE}/b/", purpose=Purpose.LINK_CHECK, headers_only=True).skipped, "blocked")


def _stored_run(root: Path, name: str, edit: Any) -> Path:
    """A copy of examples/<name> in its own folder, changed by ``edit(document)``."""
    folder = root / "run"
    folder.mkdir()
    document = json.loads((EXAMPLES / name).read_text(encoding="utf-8"))
    edit(document)
    path = folder / name
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    return path


class MalformedStoredRunTest(unittest.TestCase):
    """A stored run that is not valid is exit 2 on --rerender, never a traceback and exit 1."""

    def _rerender(self, edit: Any) -> tuple[int, str]:
        with temp_dir() as root:
            code, _, err = run_cli(["--rerender", str(_stored_run(root, "run.json", edit))])
        return code, err

    def test_unknown_state_is_a_usage_error(self) -> None:
        code, err = self._rerender(lambda d: d["checks"][0].__setitem__("state", "bogus"))
        self.assertEqual(code, 2, err)
        self.assertIn("--rerender", err)
        self.assertNotIn("Traceback", err)

    def test_unknown_colour_is_a_usage_error(self) -> None:
        code, err = self._rerender(lambda d: d["checks"][0].__setitem__("colour", "purple"))
        self.assertEqual(code, 2, err)
        self.assertNotIn("Traceback", err)

    def test_checks_that_are_not_a_list_of_objects_are_a_usage_error(self) -> None:
        for value in ("abc", ["abc"], {"EXT-01": {}}):
            with self.subTest(checks=value):
                code, err = self._rerender(lambda d, v=value: d.__setitem__("checks", v))
                self.assertEqual(code, 2, err)
                self.assertNotIn("Traceback", err)


class SchemaVersionTypeTest(unittest.TestCase):
    """schema_version is an integer: JSON true is not 1 and 2.0 is not 2."""

    def test_bool_and_float_versions_are_refused(self) -> None:
        for version in (True, 2.0, 1.0, False):
            with self.subTest(version=version):
                with self.assertRaises(runformat.RunFormatError):
                    runformat.to_internal({"schema_version": version, "meta": {}})
                self.assertFalse(runformat.is_legacy({"schema_version": version}))

    def test_rerender_refuses_a_boolean_version_with_exit_2(self) -> None:
        for name, version in (("datos.json", True), ("run.json", 2.0)):
            with self.subTest(name=name), temp_dir() as root:
                path = _stored_run(root, name, lambda d, v=version: d.__setitem__("schema_version", v))
                code, _, err = run_cli(["--rerender", str(path)])
                self.assertEqual(code, 2, err)
                self.assertIn("schema_version", err)
                self.assertFalse((path.parent / "report.md").exists())


class RerenderKindTest(unittest.TestCase):
    """--kind on --rerender cannot change whether VIS-17 (admissions) applies: the run holds no data for that."""

    def test_school_run_rerendered_as_a_company_is_refused(self) -> None:
        with temp_dir() as root:
            path = _stored_run(root, "run.json", lambda d: None)
            code, _, err = run_cli(["--rerender", str(path), "--kind", "company"])
            self.assertEqual(code, 2, err)
            self.assertIn("--kind", err)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["meta"]["kind"], "colegio")
            self.assertFalse((path.parent / "report.md").exists())

    def test_company_run_rerendered_as_a_school_is_refused(self) -> None:
        with temp_dir() as root:
            path = _stored_run(root, "run.json", lambda d: d["meta"].__setitem__("kind", "empresa"))
            code, _, err = run_cli(["--rerender", str(path), "--kind", "school"])
            self.assertEqual(code, 2, err)

    def test_a_kind_with_the_same_checks_is_still_accepted(self) -> None:
        with temp_dir() as root:
            path = _stored_run(root, "run.json", lambda d: None)
            code, _, err = run_cli(["--rerender", str(path), "--kind", "kindergarten"])
            self.assertEqual(code, 0, err)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["meta"]["kind"], "jardín")


class CssUrlParsingTimeTest(unittest.TestCase):
    """The CSS url() pattern runs in linear time on a hostile <style> or style attribute."""

    def test_style_element_of_open_url_fragments(self) -> None:
        from sitecheck.htmlextract import extract_page

        t0 = time.perf_counter()
        extract_page("<html><head><style>" + "url(" * 20_000 + "</style></head><body></body></html>", f"{BASE}/")
        self.assertLess(time.perf_counter() - t0, 1.0)

    def test_style_attribute_of_open_url_fragments(self) -> None:
        from sitecheck.htmlextract import extract_page

        t0 = time.perf_counter()
        extract_page('<html><body><div style="' + "url(" * 20_000 + '"></div></body></html>', f"{BASE}/")
        self.assertLess(time.perf_counter() - t0, 1.0)

    def test_ordinary_css_urls_are_still_read(self) -> None:
        from sitecheck.htmlextract import extract_page

        css = "body{background:url('/img/a.png')} .b{background-image: url( \"/x.png\" )} .c{background:url(/y.png)}"
        page = extract_page(f"<html><head><style>{css}</style></head><body></body></html>", f"{BASE}/")
        urls = [u for kind, _, u in page.subresources if kind == "style"]
        self.assertEqual(urls, [f"{BASE}/img/a.png", f"{BASE}/x.png", f"{BASE}/y.png"])


class OgImageExclusionTest(unittest.TestCase):
    """An excluded domain gets zero requests, also when another site declares its og:image there."""

    OG = "https://www.colegio.test/wp-content/uploads/2024/03/portada.png"

    def _scenario(self, og_url: str):  # type: ignore[no-untyped-def]
        sc = school_scenario()
        route = sc.routes["https://www.colegio.test/"]
        self.assertIn(self.OG.encode(), route.body)
        route.body = route.body.replace(self.OG.encode(), og_url.encode())
        return sc

    def test_og_image_on_an_excluded_host_is_not_requested(self) -> None:
        sc = self._scenario("https://imagenes-excluidas.test/portada.png")
        result = run_e2e(sc, default_apis(), exclude="imagenes-excluidas.test pidio no ser medido\n")
        self.assertEqual(result.code, 0, result.err)
        self.assertIn("https://www.colegio.test/", result.site_urls)
        self.assertEqual([u for u in result.site_urls if "imagenes-excluidas.test" in u], [])

    def test_og_image_redirect_to_an_excluded_host_is_not_followed(self) -> None:
        sc = self._scenario("https://cdn-libre.test/portada.png")
        sc.routes["https://cdn-libre.test/portada.png"] = Route(302, [("Location", "https://imagenes-excluidas.test/portada.png")], b"")
        result = run_e2e(sc, default_apis(), exclude="imagenes-excluidas.test pidio no ser medido\n")
        self.assertEqual(result.code, 0, result.err)
        self.assertIn("https://cdn-libre.test/portada.png", result.site_urls)
        self.assertEqual([u for u in result.site_urls if "imagenes-excluidas.test" in u], [])

    def test_guard_refuses_an_excluded_og_image_host(self) -> None:
        guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test("http://127.0.0.1:9"), test_loopback=True)
        guard.set_exclusion(lambda host: host.endswith("excluido.test"))
        self.assertFalse(guard.admit_og_image("https://img.excluido.test/a.png"))
        self.assertTrue(guard.admit_og_image("https://cdn.test/a.png"))
        self.assertEqual(
            guard.redirect_verdict("https://cdn.test/a.png", "https://img.excluido.test/a.png", Purpose.OG_IMAGE, 1).value,
            "leave",
        )


class RdapRedirectTest(unittest.TestCase):
    """rdap.org's redirect goes to an https name on port 443, and the hop is address-pinned."""

    START = "https://rdap.org/domain/example.org"

    def _guard(self) -> ScopeGuard:
        return ScopeGuard("example.org", "https://www.example.org/", Endpoints())

    def test_ip_literals_localhost_and_other_ports_are_left(self) -> None:
        g = self._guard()
        for to in (
            "https://10.0.0.5:8443/domain/example.org",
            "https://169.254.169.254/latest/x/domain/example.org",
            "https://[::1]/domain/example.org",
            "https://localhost/domain/example.org",
            "https://rdap.example.net:8443/domain/example.org",
        ):
            with self.subTest(to=to):
                self.assertIs(g.redirect_verdict(self.START, to, Purpose.RDAP, 1), RedirectVerdict.LEAVE)

    def test_path_query_and_scheme_are_checked(self) -> None:
        g = self._guard()
        for to in (
            "https://rdap.example.net/domain/other.org",
            "https://rdap.example.net/domain/example.org?x=1",
            "http://rdap.example.net/domain/example.org",
        ):
            with self.subTest(to=to):
                self.assertIs(g.redirect_verdict(self.START, to, Purpose.RDAP, 1), RedirectVerdict.LEAVE)

    def test_an_https_name_on_443_is_followed(self) -> None:
        g = self._guard()
        for to in ("https://rdap.example.net/v1/domain/example.org", "https://rdap.example.net:443/domain/example.org"):
            with self.subTest(to=to):
                self.assertIs(g.redirect_verdict(self.START, to, Purpose.RDAP, 1), RedirectVerdict.FOLLOW)

    def test_the_redirect_hop_is_pinned_to_a_public_address(self) -> None:
        g = self._guard()
        pins: list[tuple[str, bool]] = []

        def fake_exchange(self, method, url, *args, pin, **kwargs):  # type: ignore[no-untyped-def]
            pins.append((url, pin))
            if url == RdapRedirectTest.START:
                return _Exchange(status=302, reason="Found", headers=[("Location", "https://rdap.example.net/domain/example.org")], ms=1.0)
            return _Exchange(status=200, reason="OK", headers=[("Content-Type", "application/rdap+json")], raw=b"{}", body_read=True, ms=1.0)

        client = HttpClient(g, RequestLog(None, Redactor([])), ChallengeDetector(), Redactor([]), ClientConfig(pace_seconds=0, pace_jitter=0), sleeper=SleepRecorder())
        with mock.patch.object(HttpClient, "_exchange", fake_exchange):
            client.api_request("GET", self.START, purpose=Purpose.RDAP, headers={}, timeout=5, follow_redirects=True)
        self.assertEqual(pins[-1], ("https://rdap.example.net/domain/example.org", True))


if __name__ == "__main__":
    unittest.main()
