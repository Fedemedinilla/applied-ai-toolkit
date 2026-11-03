"""The HTTP client against the local fake site: pacing, budget, redirects, challenge,
scope, request log and key handling.
"""

from __future__ import annotations

import unittest

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder

from sitecheck.challenge import ChallengeDetector, Expect
from sitecheck.credentials import Redactor
from sitecheck.endpoints import Endpoints
from sitecheck.httpclient import ClientConfig, HttpClient, LoopbackRoute
from sitecheck.requestlog import RequestLog
from sitecheck.scope import Purpose, ScopeError, ScopeGuard
from fakeapis import FakeApis
from fakesite import FakeSite, Route
from sitefixtures import SchoolOptions, default_apis, school_scenario

BASE = "https://www.colegio.test"


class _Rig:
    """A client wired to a running FakeSite (and FakeApis for API calls)."""

    def __init__(self, site: FakeSite, apis: FakeApis, **cfg) -> None:
        self.sleeps = SleepRecorder()
        self.redactor = Redactor([TEST_KEY])
        self.guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test(apis.base), test_loopback=True)
        self.guard.set_canonical(f"{BASE}/")
        self.log = RequestLog(None, self.redactor)
        config = ClientConfig(
            pace_seconds=cfg.pop("pace_seconds", 3.0),
            pace_jitter=0.0,
            challenge_wait=cfg.pop("challenge_wait", 60.0),
            challenge_pace=6.0,
            site_budget=cfg.pop("site_budget", 90),
            loopback=LoopbackRoute(port=site.port),
        )
        self.client = HttpClient(self.guard, self.log, ChallengeDetector(), self.redactor, config, sleeper=self.sleeps)


class HttpClientTest(unittest.TestCase):
    def test_manual_redirects_and_recording(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            r = rig.client.fetch("http://colegio.test/", purpose=Purpose.VARIANT, expect=Expect.HTML)
            self.assertEqual(r.status, 200)
            self.assertEqual(r.final_url, f"{BASE}/")
            self.assertEqual([h.status for h in r.redirects], [301])
            self.assertEqual(site.requested_urls(), ["http://colegio.test/", f"{BASE}/"])
            self.assertEqual(len(rig.log.records()), 2)
            self.assertEqual([x.hop for x in rig.log.records()], [0, 1])

    def test_gzip_is_decoded(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            r = _Rig(site, apis).client.fetch(f"{BASE}/", purpose=Purpose.HOME, expect=Expect.HTML)
            self.assertEqual(r.content_encoding, "gzip")
            self.assertLess(r.raw_length, r.decoded_length)
            self.assertIn(b"<title>Colegio Ejemplo |", r.body)
            self.assertIsNotNone(r.ttfb_ms)
            self.assertTrue(r.usable)

    def test_pacing_between_site_requests(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.client.fetch(f"{BASE}/", purpose=Purpose.HOME, expect=Expect.HTML)
            rig.client.fetch(f"{BASE}/robots.txt", purpose=Purpose.ROBOTS, expect=Expect.TEXT)
            self.assertIn(3.0, rig.sleeps.calls)
            self.assertTrue(all(s >= 3.0 for s in rig.sleeps.calls if s > 0))

    def test_budget(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis, site_budget=2)
            rig.guard.admit_linked([f"{BASE}/institucional/"], purpose=Purpose.INTERNA, source="test")
            rig.client.fetch(f"{BASE}/", purpose=Purpose.HOME, expect=Expect.HTML)
            rig.client.fetch(f"{BASE}/robots.txt", purpose=Purpose.ROBOTS, expect=Expect.TEXT)
            r = rig.client.fetch(f"{BASE}/institucional/", purpose=Purpose.INTERNA, expect=Expect.HTML)
            self.assertEqual(r.skipped, "budget")
            self.assertEqual(len(site.requests), 2)
            self.assertEqual(rig.client.site_requests, 2)

    def test_challenge_wait_retry_once_then_cut(self) -> None:
        with FakeSite(school_scenario(SchoolOptions(challenge=True))) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            r = rig.client.fetch(f"{BASE}/", purpose=Purpose.HOME, expect=Expect.HTML)
            self.assertIsNotNone(r.challenge)
            self.assertIn(60.0, rig.sleeps.calls)
            self.assertEqual(len(site.requests), 2, "first try plus exactly one retry")
            self.assertTrue(rig.client.blocked)
            r2 = rig.client.fetch(f"{BASE}/robots.txt", purpose=Purpose.ROBOTS, expect=Expect.TEXT)
            self.assertEqual(r2.skipped, "blocked")
            self.assertEqual(len(site.requests), 2, "nothing else is sent after the cut")
            self.assertGreaterEqual(len(rig.client.challenge_events), 1)

    def test_scope_error_sends_nothing(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            with self.assertRaises(ScopeError):
                rig.client.fetch(f"{BASE}/readme.html", purpose=Purpose.LINK_CHECK)
            self.assertEqual(site.requests, [])

    def test_off_site_redirect_is_not_followed(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/salir/"] = Route(302, [("Location", "https://otro.example/")])
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/salir/"], purpose=Purpose.LINK_CHECK, source="test")
            r = rig.client.fetch(f"{BASE}/salir/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue(r.left_site)
            self.assertEqual(r.status, 302)
            self.assertEqual(site.requested_urls(), [f"{BASE}/salir/"])

    def test_loopback_mode_never_connects_outside(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_og_image("https://cdn.example.com/portada.png")
            with self.assertRaises(ScopeError):
                rig.client.fetch("https://cdn.example.com/portada.png", purpose=Purpose.OG_IMAGE, expect=Expect.IMAGE)

    def test_api_request_key_only_in_header(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            e = rig.guard.endpoints
            with self.assertRaises(ValueError):
                rig.client.api_request("GET", e.psi + "?url=x&key=" + TEST_KEY, purpose=Purpose.PSI)
            r = rig.client.api_request(
                "GET", e.psi + "?url=https%3A%2F%2Fwww.colegio.test%2F&strategy=MOBILE", purpose=Purpose.PSI, headers={"X-goog-api-key": TEST_KEY}
            )
            self.assertEqual(r.status, 200)
            call = apis.calls("/pagespeedonline/v5/runPagespeed")[-1]
            self.assertEqual(call.headers["x-goog-api-key"], TEST_KEY)
            self.assertNotIn(TEST_KEY, call.raw_path)
            for rec in rig.log.records():
                self.assertNotIn(TEST_KEY, rec.url)
                self.assertNotIn(TEST_KEY, rec.error or "")
            self.assertEqual(rig.sleeps.calls, [], "APIs are never paced")
            self.assertEqual(site.requests, [])


class HttpClientEdgeTest(unittest.TestCase):
    def test_rule_b_two_distinct_urls_same_small_body(self) -> None:
        sc = school_scenario()
        small = Route(200, [("Content-Type", "text/html")], b"<html><body>Espere por favor</body></html>")
        sc.routes[f"{BASE}/a/"] = small
        sc.routes[f"{BASE}/b/"] = small
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/", f"{BASE}/b/"], purpose=Purpose.INTERNA, source="test")
            first = rig.client.fetch(f"{BASE}/a/", purpose=Purpose.INTERNA, expect=Expect.HTML)
            self.assertIsNone(first.challenge)
            second = rig.client.fetch(f"{BASE}/b/", purpose=Purpose.INTERNA, expect=Expect.HTML)
            self.assertEqual(first.challenge, "b:duplicate-body", "the first URL is flagged retroactively")
            self.assertEqual(second.challenge, "b:duplicate-body")
            self.assertTrue(rig.client.blocked, "the retry of /b/ returns the same body again")
            self.assertEqual(site.requested_urls(), [f"{BASE}/a/", f"{BASE}/b/", f"{BASE}/b/"])
            # /a/ flagged when /b/ arrives; /b/ waits and retries; the retry repeats the
            # body (nothing new to flag retroactively) and the host is cut.
            self.assertEqual(
                [(e.action, e.url) for e in rig.client.challenge_events],
                [("flagged-retroactively", f"{BASE}/a/"), ("retry-after-wait", f"{BASE}/b/"), ("host-cut", f"{BASE}/b/")],
            )
            self.assertIn(60.0, rig.sleeps.calls)

    def test_redirect_hop_to_a_denied_path_is_refused_and_logged(self) -> None:
        # The SITE issued the hop: it is refused and logged, never requested, and
        # never fatal.
        sc = school_scenario()
        sc.routes[f"{BASE}/entrar/"] = Route(302, [("Location", "/wp-login.php")])
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/entrar/"], purpose=Purpose.LINK_CHECK, source="test")
            r = rig.client.fetch(f"{BASE}/entrar/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue(r.denied_redirect)
            self.assertEqual(r.status, 302)
            self.assertEqual(r.refused_next_url, f"{BASE}/wp-login.php")
            self.assertEqual(site.requested_urls(), [f"{BASE}/entrar/"])
            self.assertEqual([r.outcome for r in rig.log.records()], ["ok", "refused-scope"])

    def test_hops_are_capped_and_each_hop_counts_in_the_budget(self) -> None:
        sc = school_scenario()
        for i in range(8):
            sc.routes[f"{BASE}/r{i}/"] = Route(301, [("Location", f"{BASE}/r{i + 1}/")])
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/r0/"], purpose=Purpose.LINK_CHECK, source="test")
            r = rig.client.fetch(f"{BASE}/r0/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue(r.hops_exceeded)
            self.assertEqual(len(site.requests), 6, "the first request plus 5 followed hops")
            self.assertEqual(rig.client.site_requests, 6)
            self.assertEqual(len(r.redirects), 5)
            self.assertEqual(r.status, 301)

    def test_request_log_file_has_one_line_per_attempt(self) -> None:
        import json

        from support import temp_dir

        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as d:
            rig = _Rig(site, apis)
            rig.log = RequestLog(d / "requests.log", rig.redactor)
            rig.client = HttpClient(rig.guard, rig.log, ChallengeDetector(), rig.redactor, ClientConfig(pace_seconds=0, pace_jitter=0, loopback=LoopbackRoute(port=site.port)))
            rig.client.fetch("http://colegio.test/", purpose=Purpose.VARIANT, expect=Expect.HTML)
            lines = [json.loads(x) for x in (d / "requests.log").read_text(encoding="utf-8").splitlines()]
            self.assertEqual([(x["url"], x["status"], x["hop"]) for x in lines], [("http://colegio.test/", 301, 0), (f"{BASE}/", 200, 1)])
            self.assertEqual(sorted(lines[0]), sorted(["seq", "ts_utc", "kind", "purpose", "method", "url", "host", "status", "bytes_raw", "ms", "ttfb_ms", "sha256_prefix", "hop", "challenge", "outcome", "error"]))


if __name__ == "__main__":
    unittest.main()
