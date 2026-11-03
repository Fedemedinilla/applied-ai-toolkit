"""The whole collection flow against the fake site and fake APIs: only what the
passive scope allows is requested, and PageSpeed runs before the first request
to the site.
"""

from __future__ import annotations

import unittest

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder, patched_env, temp_dir

from sitecheck.collect import collect
from sitecheck.config import RunConfig
from sitecheck.services import build_services
from fakeapis import FakeApis
from fakesite import FakeSite
from sitefixtures import SchoolOptions, default_apis, school_scenario

BASE = "https://www.colegio.test"
PSI = "/pagespeedonline/v5/runPagespeed"


def run_collect(site: FakeSite, apis: FakeApis, evidence_dir, **cfg):
    config = RunConfig(url=f"{BASE}/", test_loopback=site.loopback, test_services=apis.base, **cfg)
    with patched_env(SITE_CHECK_TEST_API_KEY=TEST_KEY):
        services = build_services(config, evidence_dir, sleeper=SleepRecorder())
        return collect(config, services), services


class CollectTest(unittest.TestCase):
    def test_only_the_passive_scope_is_requested(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            obs, _ = run_collect(site, apis, ev)
            self.assertEqual(site.forbidden_hits(), [])
            self.assertEqual(site.outside_allowed(), [])
            self.assertFalse(obs.blocked)
            self.assertLessEqual(obs.site_requests, 90)

    def test_pagespeed_and_apis_run_before_the_first_site_request(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            run_collect(site, apis, ev)
            psi_calls = apis.calls(PSI)
            self.assertEqual(len(psi_calls), 4, "3 mobile + 1 desktop")
            self.assertLess(max(c.t for c in psi_calls), site.first_time())
            self.assertLess(apis.last_time("/resolve"), site.first_time())
            self.assertLess(apis.last_time("/rdap/"), site.first_time())
            self.assertLess(apis.last_time("/dbl"), site.first_time())
            for c in psi_calls:
                self.assertEqual(c.headers.get("x-goog-api-key"), TEST_KEY)
                self.assertNotIn(TEST_KEY, c.raw_path)

    def test_home_three_loads_interleaved_with_control_and_never_a_fourth(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            obs, _ = run_collect(site, apis, ev)
            self.assertEqual(site.count(f"{BASE}/"), 3, "load 1 + loads 2 and 3; variants stop at H")
            self.assertEqual(site.count("https://control.test/"), 3)
            urls = site.requested_urls()
            seq = [u for u in urls if u in (f"{BASE}/", "https://control.test/")][:6]
            self.assertEqual(seq, [f"{BASE}/", "https://control.test/"] * 3)
            self.assertEqual(obs.canonical_url, f"{BASE}/")
            self.assertEqual(len(obs.ttfb.site), 3)
            self.assertEqual(len(obs.ttfb.control), 3)
            self.assertEqual(len(obs.variants), 4)
            self.assertEqual(len(obs.home_reloads), 2)

    def test_sitemap_index_first_child_only_and_feed(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            obs, _ = run_collect(site, apis, ev)
            self.assertEqual(site.count(f"{BASE}/page-sitemap.xml"), 1)
            self.assertEqual(site.count(f"{BASE}/post-sitemap.xml"), 0)
            self.assertEqual(site.count(f"{BASE}/sitemap.xml"), 0, "robots.txt declares one: no guessing")
            self.assertEqual(site.count(f"{BASE}/comments/feed/"), 0)
            self.assertIsNotNone(obs.feed)
            self.assertEqual(obs.feed.url, f"{BASE}/feed/")

    def test_standard_sitemap_paths_when_robots_declares_none(self) -> None:
        sc = school_scenario(SchoolOptions(robots_declares_sitemap=False))
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            run_collect(site, apis, ev)
            self.assertEqual(site.count(f"{BASE}/sitemap.xml"), 1)
            self.assertEqual(site.count(f"{BASE}/sitemap_index.xml"), 1)
            self.assertEqual(site.count(f"{BASE}/wp-sitemap.xml"), 0, "stop at the first valid one")
            self.assertEqual(site.outside_allowed(), [])

    def test_links_are_checked_once_and_results_recorded(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            obs, _ = run_collect(site, apis, ev)
            self.assertEqual(site.count(f"{BASE}/contacto/"), 1, "interna reused by VIS-09")
            self.assertEqual(site.count(f"{BASE}/institucional/"), 1, "checked once by VIS-09")
            by_url = {p.url: p for p in obs.links.probes}
            self.assertEqual(by_url[f"{BASE}/novedades/acto-25-de-mayo/"].final_status, 404)
            chain = by_url[f"{BASE}/viejo-enlace/"]
            self.assertEqual((chain.final_status, chain.hops), (200, 2))
            self.assertEqual(by_url["http://www.colegio.test/historia/"].hops, 1)
            # the home links a contact page, so it is the interna.
            self.assertEqual(obs.interna.url, f"{BASE}/contacto/")
            self.assertEqual(obs.interna_source, "auto")

    def test_interna_not_linked_is_not_requested(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            obs, _ = run_collect(site, apis, ev, interna=f"{BASE}/no-enlazada/")
            self.assertEqual(site.count(f"{BASE}/no-enlazada/"), 0)
            self.assertEqual(site.outside_allowed(), [])

    def test_challenge_from_the_first_request(self) -> None:
        with FakeSite(school_scenario(SchoolOptions(challenge=True))) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            obs, _ = run_collect(site, apis, ev)
            self.assertTrue(obs.home_unreachable)
            self.assertTrue(obs.blocked)
            self.assertEqual(len(site.requests), 2, "first request plus one retry, then nothing")

    def test_evidence_and_request_log_are_written_without_the_key(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev:
            obs, services = run_collect(site, apis, ev)
            names = {p.name for p in ev.iterdir()}
            for expected in ("requests.log", "home.html", "headers-home.txt", "robots.txt", "psi-mobile-1.json", "psi-desktop.json", "dns.json", "rdap.json", "tls.json", "variantes.json", "ttfb.json", "enlaces.json"):
                self.assertIn(expected, names)
            for p in ev.iterdir():
                data = p.read_bytes()
                self.assertNotIn(TEST_KEY.encode(), data, p.name)
            self.assertNotIn(b"Juana Titular", (ev / "rdap.json").read_bytes())
            n_lines = len((ev / "requests.log").read_text(encoding="utf-8").splitlines())
            self.assertEqual(n_lines, len(services.log.records()))
            self.assertGreaterEqual(n_lines, len(site.requests) + len(apis.requests))


if __name__ == "__main__":
    unittest.main()
