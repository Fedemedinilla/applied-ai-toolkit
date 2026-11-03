"""The scope guard, case by case. This is the legal boundary of the tool: a request
it refuses is never sent.
"""

from __future__ import annotations

import unittest

import support  # noqa: F401

from sitecheck.endpoints import Endpoints
from sitecheck.scope import Purpose, RedirectVerdict, RequestKind, ScopeError, ScopeGuard, matches_deny_pattern

BASE = "https://www.colegio.test"


def guard(**kw) -> ScopeGuard:
    g = ScopeGuard(
        registrable="colegio.test",
        input_url=f"{BASE}/",
        endpoints=Endpoints.for_test("http://127.0.0.1:9"),
        test_loopback=True,
        **kw,
    )
    g.set_canonical(f"{BASE}/")
    return g


class ScopeGuardTest(unittest.TestCase):
    def test_variants_home_and_robots_are_allowed(self) -> None:
        g = guard()
        for v in ("http://colegio.test/", "https://colegio.test/", "http://www.colegio.test/", f"{BASE}/"):
            self.assertEqual(g.check("GET", v, Purpose.VARIANT), RequestKind.SITE, v)
        self.assertEqual(g.check("GET", f"{BASE}/", Purpose.HOME_RELOAD), RequestKind.SITE)
        self.assertEqual(g.check("GET", f"{BASE}/robots.txt", Purpose.ROBOTS), RequestKind.SITE)

    def test_unlinked_pages_are_refused_until_linked(self) -> None:
        g = guard()
        with self.assertRaises(ScopeError):
            g.check("GET", f"{BASE}/institucional/", Purpose.INTERNA)
        admitted = g.admit_linked(
            [f"{BASE}/institucional/", f"{BASE}/author/admin/", f"{BASE}/?author=1", "https://otro.example/x", f"{BASE}/institucional"],
            purpose=Purpose.INTERNA,
            source="home <a href>",
        )
        self.assertEqual(admitted, [f"{BASE}/institucional/"])
        self.assertEqual(g.check("GET", f"{BASE}/institucional/", Purpose.INTERNA), RequestKind.SITE)

    def test_deny_patterns_win_even_when_linked(self) -> None:
        g = guard()
        linked = [
            f"{BASE}/readme.html",
            f"{BASE}/wp-json/",
            f"{BASE}/wp-json/wp/v2/users",
            f"{BASE}/xmlrpc.php",
            f"{BASE}/xmlrpc.php?rsd",
            f"{BASE}/wp-login.php",
            f"{BASE}/wp-admin/",
            f"{BASE}/.env",
            f"{BASE}/.git/config",
            f"{BASE}/wp-config.php.bak",
            f"{BASE}/backup.zip",
            f"{BASE}/debug.log",
        ]
        self.assertEqual(g.admit_linked(linked, purpose=Purpose.LINK_CHECK, source="home <a href>"), [])
        for u in linked:
            with self.assertRaises(ScopeError, msg=u):
                g.check("GET", u, Purpose.LINK_CHECK)

    def test_favicon_only_when_linked(self) -> None:
        g = guard()
        with self.assertRaises(ScopeError):
            g.check("GET", f"{BASE}/favicon.ico", Purpose.LINK_CHECK)

    def test_standard_sitemaps_only_after_robots_declares_none(self) -> None:
        g = guard()
        for p in ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"):
            with self.assertRaises(ScopeError, msg=p):
                g.check("GET", f"{BASE}{p}", Purpose.SITEMAP_STANDARD)
        g.allow_standard_sitemaps()
        for p in ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"):
            self.assertEqual(g.check("GET", f"{BASE}{p}", Purpose.SITEMAP_STANDARD), RequestKind.SITE)

    def test_declared_sitemaps_child_and_feed(self) -> None:
        g = guard()
        self.assertEqual(
            g.admit_declared_sitemaps([f"{BASE}/sitemap_index.xml", "https://cdn.otro.example/sitemap.xml"]),
            [f"{BASE}/sitemap_index.xml"],
        )
        self.assertEqual(g.check("GET", f"{BASE}/sitemap_index.xml", Purpose.SITEMAP), RequestKind.SITE)
        self.assertTrue(g.admit_sitemap_child(f"{BASE}/page-sitemap.xml"))
        self.assertFalse(g.admit_sitemap_child(f"{BASE}/post-sitemap.xml"), "only the first child")
        with self.assertRaises(ScopeError):
            g.check("GET", f"{BASE}/post-sitemap.xml", Purpose.SITEMAP_CHILD)
        self.assertTrue(g.admit_feed(f"{BASE}/feed/"))
        self.assertEqual(g.check("GET", f"{BASE}/feed/", Purpose.FEED), RequestKind.SITE)
        with self.assertRaises(ScopeError):
            g.check("GET", f"{BASE}/comments/feed/", Purpose.FEED)

    def test_only_get_on_the_site(self) -> None:
        g = guard()
        for method in ("POST", "PUT", "DELETE", "HEAD", "OPTIONS"):
            with self.assertRaises(ScopeError, msg=method):
                g.check(method, f"{BASE}/", Purpose.HOME)

    def test_redirects(self) -> None:
        g = guard()
        self.assertTrue(g.check_redirect("http://colegio.test/", f"{BASE}/", Purpose.VARIANT, 1))
        self.assertFalse(g.check_redirect(f"{BASE}/salir/", "https://otro.example/", Purpose.LINK_CHECK, 1))
        # A denied path the SITE redirects to is refused, never requested, and not a bug.
        self.assertFalse(g.check_redirect(f"{BASE}/x/", f"{BASE}/readme.html", Purpose.LINK_CHECK, 1))
        self.assertEqual(g.redirect_verdict(f"{BASE}/x/", f"{BASE}/readme.html", Purpose.LINK_CHECK, 1), RedirectVerdict.DENIED)
        with self.assertRaises(ScopeError):
            g.check_redirect(f"{BASE}/x/", f"{BASE}/y/", Purpose.LINK_CHECK, 6)

    def test_og_image_any_host_once(self) -> None:
        g = guard()
        self.assertTrue(g.admit_og_image("https://i0.cdn.test/portada.png"))
        self.assertEqual(g.check("GET", "https://i0.cdn.test/portada.png", Purpose.OG_IMAGE), RequestKind.EXTERNAL)
        self.assertTrue(g.check_redirect("https://i0.cdn.test/portada.png", "https://i1.cdn.test/portada.png", Purpose.OG_IMAGE, 1))
        self.assertFalse(g.admit_og_image("https://i0.cdn.test/otra.png"), "one og:image per run")

    def test_apis_control_tls_and_dns(self) -> None:
        g = guard()
        e = g.endpoints
        self.assertEqual(g.check("GET", e.psi + "?url=x&strategy=MOBILE", Purpose.PSI), RequestKind.API)
        self.assertEqual(g.check("GET", e.doh_google + "?name=colegio.test&type=TXT", Purpose.DOH), RequestKind.API)
        self.assertEqual(g.check("GET", e.control_url, Purpose.CONTROL), RequestKind.CONTROL)
        with self.assertRaises(ScopeError):
            g.check("GET", e.control_url + "otra/", Purpose.CONTROL)
        with self.assertRaises(ScopeError):
            g.check("POST", e.observatory + "?host=www.colegio.test", Purpose.OBSERVATORY)  # off by default
        with self.assertRaises(ScopeError):
            g.check("GET", "https://www.google.com/", Purpose.LINK_CHECK)
        self.assertEqual(g.check_tls("www.colegio.test"), RequestKind.TLS)
        self.assertEqual(g.check_tls("colegio.test"), RequestKind.TLS)
        with self.assertRaises(ScopeError):
            g.check_tls("mail.colegio.test")
        self.assertEqual(g.check_dns("colegio.test.dbl.spamhaus.org."), RequestKind.DNS)
        with self.assertRaises(ScopeError):
            g.check_dns("otro.test.dbl.spamhaus.org.")

    def test_observatory_only_when_enabled(self) -> None:
        g = guard(observatory=True)
        e = g.endpoints
        self.assertEqual(g.check("POST", e.observatory + "?host=www.colegio.test", Purpose.OBSERVATORY), RequestKind.API)

    def test_describe_lists_admissions(self) -> None:
        g = guard()
        g.admit_linked([f"{BASE}/institucional/"], purpose=Purpose.INTERNA, source="home <a href>")
        d = g.describe()
        self.assertIn(f"{BASE}/institucional/", repr(d))


class DenyPatternTest(unittest.TestCase):
    def test_patterns(self) -> None:
        for path in ("/?author=1", "/author/admin/", "/readme.html", "/wp-json/wp/v2/users", "/xmlrpc.php", "/.env", "/backup.zip"):
            self.assertIsNotNone(matches_deny_pattern(path), path)
        for path in ("/", "/inscripciones/", "/sitemap.xml.gz", "/wp-content/uploads/2024/03/portada.png", "/feed/"):
            self.assertIsNone(matches_deny_pattern(path), path)


if __name__ == "__main__":
    unittest.main()
