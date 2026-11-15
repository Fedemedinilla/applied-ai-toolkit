"""Regression tests for the audit findings fixed in November 2026.

Each test reproduces one confirmed finding and failed before its fix.
"""

from __future__ import annotations

import unittest

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder

from sitecheck.challenge import ChallengeDetector
from sitecheck.credentials import Redactor
from sitecheck.endpoints import Endpoints
from sitecheck.httpclient import ClientConfig, HttpClient, LoopbackRoute, _declared_length, public_address
from sitecheck.requestlog import RequestLog
from sitecheck.scope import Purpose, ScopeGuard
from fakeapis import FakeApis
from fakesite import FakeSite, Route
from sitefixtures import default_apis, school_scenario

BASE = "https://colegio.test"


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


if __name__ == "__main__":
    unittest.main()
