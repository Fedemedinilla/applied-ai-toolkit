"""Self-test of the harness: the fake site and the fake APIs answer and record
before they are used to judge the tool (an instrument is checked before it measures).
"""

from __future__ import annotations

import gzip
import http.client
import json
import socket
import unittest

import support  # noqa: F401  (path setup and network guard)
from fakeapis import FakeApis
from fakesite import SCHEME_HEADER, FakeSite
from sitefixtures import SchoolOptions, default_apis, school_scenario


def _get(port: int, url_host: str, path: str, scheme: str = "https", headers: dict[str, str] | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"Host": url_host, SCHEME_HEADER: scheme, "Accept-Encoding": "gzip"}
    h.update(headers or {})
    conn.request("GET", path, headers=h)
    resp = conn.getresponse()
    body = resp.read()
    out = (resp.status, {k.lower(): v for k, v in resp.getheaders()}, body)
    conn.close()
    return out


class FakeSiteSelfTest(unittest.TestCase):
    def test_serves_routes_by_scheme_and_host_and_records_everything(self) -> None:
        with FakeSite(school_scenario()) as site:
            status, headers, body = _get(site.port, "www.colegio.test", "/")
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("content-encoding"), "gzip")
            html = gzip.decompress(body).decode("utf-8")
            self.assertIn("<title>Colegio Ejemplo |", html)
            self.assertIn('content="WordPress 6.1.1"', html)
            self.assertIn("wa.me/5491123456789", html)

            status, headers, _ = _get(site.port, "colegio.test", "/", scheme="http")
            self.assertEqual(status, 301)
            self.assertEqual(headers["location"], "https://www.colegio.test/")

            status, _, body = _get(site.port, "www.colegio.test", "/robots.txt")
            self.assertEqual(status, 200)
            self.assertIn(b"Sitemap: https://www.colegio.test/sitemap_index.xml", body)

            status, _, _ = _get(site.port, "www.colegio.test", "/no-existe/")
            self.assertEqual(status, 404)

            self.assertEqual(
                site.requested_urls(),
                [
                    "https://www.colegio.test/",
                    "http://colegio.test/",
                    "https://www.colegio.test/robots.txt",
                    "https://www.colegio.test/no-existe/",
                ],
            )
            # The instrument detects an out-of-scope request.
            self.assertEqual(site.outside_allowed(), ["https://www.colegio.test/no-existe/"])

    def test_forbidden_urls_are_detected(self) -> None:
        with FakeSite(school_scenario()) as site:
            _get(site.port, "www.colegio.test", "/readme.html")
            self.assertEqual(site.forbidden_hits(), ["https://www.colegio.test/readme.html"])

    def test_challenge_mode_answers_the_same_small_page_to_everything(self) -> None:
        with FakeSite(school_scenario(SchoolOptions(challenge=True))) as site:
            a = _get(site.port, "www.colegio.test", "/")
            b = _get(site.port, "www.colegio.test", "/robots.txt")
            self.assertEqual(a[0], 200)
            self.assertEqual(a[2], b[2])
            self.assertIn(b"One moment, please", a[2])
            self.assertLess(len(a[2]), 20 * 1024)
            self.assertGreater(len(a[2]), 10 * 1024)

    def test_pages_are_large_enough_for_the_evidence_gate(self) -> None:
        with FakeSite(school_scenario()) as site:
            for path in ("/institucional/", "/inscripciones/", "/destino/"):
                status, _, body = _get(site.port, "www.colegio.test", path)
                self.assertEqual(status, 200, path)
                self.assertGreaterEqual(len(body), 1024, path)

    def test_og_image_is_a_1200x630_png(self) -> None:
        with FakeSite(school_scenario()) as site:
            status, headers, body = _get(site.port, "www.colegio.test", "/wp-content/uploads/2024/03/portada.png")
            self.assertEqual(status, 200)
            self.assertEqual(headers["content-type"], "image/png")
            self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(int.from_bytes(body[16:20], "big"), 1200)
            self.assertEqual(int.from_bytes(body[20:24], "big"), 630)


class FakeApisSelfTest(unittest.TestCase):
    def _call(self, apis: FakeApis, method: str, path: str, headers: dict[str, str] | None = None):
        port = int(apis.base.rsplit(":", 1)[1])
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request(method, path, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, json.loads(data.decode("utf-8"))

    def test_psi_doh_rdap_dbl_tls_and_recording(self) -> None:
        with FakeApis(default_apis()) as apis:
            st, psi = self._call(apis, "GET", "/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fwww.colegio.test%2F&strategy=MOBILE", {"X-goog-api-key": "k"})
            self.assertEqual(st, 200)
            self.assertEqual(psi["lighthouseResult"]["audits"]["largest-contentful-paint"]["numericValue"], 4830.0)
            self.assertEqual(psi["loadingExperience"]["metrics"]["CUMULATIVE_LAYOUT_SHIFT_SCORE"]["percentile"], 5)

            st, txt = self._call(apis, "GET", "/resolve?name=colegio.test&type=TXT")
            self.assertEqual(txt["Status"], 0)
            self.assertIn("v=spf1 include:_spf.google.com ~all", [a["data"] for a in txt["Answer"]])
            st, txt_cf = self._call(apis, "GET", "/dns-query?name=colegio.test&type=TXT")
            self.assertIn('"v=spf1 include:_spf.google.com ~all"', [a["data"] for a in txt_cf["Answer"]])
            st, dmarc = self._call(apis, "GET", "/resolve?name=_dmarc.colegio.test&type=TXT")
            self.assertEqual(dmarc["Status"], 3)

            st, rdap = self._call(apis, "GET", "/rdap/domain/colegio.test")
            self.assertEqual(st, 200)
            self.assertIn("expiration", [e["eventAction"] for e in rdap["events"]])

            st, dbl = self._call(apis, "GET", "/dbl?name=colegio.test.dbl.spamhaus.org.")
            self.assertEqual(dbl, {"nxdomain": True})
            st, tls = self._call(apis, "GET", "/tls?host=www.colegio.test&port=443")
            self.assertEqual(tls["alpn"], "h2")

            self.assertEqual(apis.calls("/pagespeedonline/v5/runPagespeed")[0].headers["x-goog-api-key"], "k")
            self.assertEqual(len(apis.requests), 7)

    def test_psi_quota_mode(self) -> None:
        with FakeApis(default_apis(psi_status=429)) as apis:
            st, body = self._call(apis, "GET", "/pagespeedonline/v5/runPagespeed?url=x&strategy=MOBILE")
            self.assertEqual(st, 429)
            self.assertIn("Quota exceeded", body["error"]["message"])


class NetworkGuardSelfTest(unittest.TestCase):
    def test_non_loopback_connections_and_lookups_are_refused(self) -> None:
        with self.assertRaises(OSError):
            socket.getaddrinfo("example.com", 443)
        with self.assertRaises(OSError):
            socket.gethostbyname_ex("colegio.test.dbl.spamhaus.org.")
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with self.assertRaises(OSError):
                s.connect(("93.184.215.14", 443))
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main()
