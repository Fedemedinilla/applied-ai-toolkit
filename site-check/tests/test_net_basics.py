"""Unit tests of the pure network modules: domains, credentials, challenge, robots,
links, sitemapfeed, imagesize, dbl, tlsprobe, rdap, doh and PSI parsing.
"""

from __future__ import annotations

import datetime as dt
import struct
import importlib.util
import unittest

import support
from support import TEST_KEY

from sitecheck import challenge, credentials, dbl, doh, domains, imagesize, links, psi, rdap, robots, sitemapfeed, tlsprobe
from sitecheck.challenge import Expect
from sitecheck.endpoints import Endpoints
from sitecheck.httpclient import Response
from sitecheck.scope import Purpose, RequestKind
from fakeapis import psi_payload
from sitefixtures import png_bytes

UTC = dt.timezone.utc


def resp(url: str, status: int | None = 200, ctype: str | None = "text/html; charset=UTF-8", body: bytes = b"", **kw) -> Response:
    headers = [("Content-Type", ctype)] if ctype else []
    return Response(url=url, final_url=url, purpose=Purpose.ROBOTS, kind=RequestKind.SITE, status=status, headers=headers, body=body, **kw)


class DomainsTest(unittest.TestCase):
    def test_registrable_domain(self) -> None:
        self.assertEqual(domains.registrable_domain("www.colegio-ejemplo.edu.ar"), "colegio-ejemplo.edu.ar")
        self.assertEqual(domains.registrable_domain("https://www.colegio-ejemplo.edu.ar/inicio/"), "colegio-ejemplo.edu.ar")
        self.assertEqual(domains.registrable_domain("sub.colegio-ejemplo.com"), "colegio-ejemplo.com")
        self.assertEqual(domains.registrable_domain("www.colegio.test"), "colegio.test")
        self.assertEqual(domains.registrable_domain("WWW.Colegio-Ejemplo.COM.AR."), "colegio-ejemplo.com.ar")
        for bad in ("com.ar", "localhost", "127.0.0.1"):
            with self.assertRaises(ValueError, msg=bad):
                domains.registrable_domain(bad)

    def test_normalize_host_and_idna(self) -> None:
        self.assertEqual(domains.normalize_host("WWW.Colegio-Ejemplo.EDU.ar."), "www.colegio-ejemplo.edu.ar")
        self.assertEqual(domains.normalize_host("www.colegio.test:8080"), "www.colegio.test")
        idn = domains.normalize_host("escuelañandú.com.ar")
        self.assertTrue(idn.startswith("xn--"), idn)
        self.assertTrue(idn.endswith(".com.ar"), idn)

    def test_variants_compare_key_and_resolution(self) -> None:
        self.assertEqual(
            domains.site_variants("colegio.test"),
            ("http://colegio.test/", "https://colegio.test/", "http://www.colegio.test/", "https://www.colegio.test/"),
        )
        self.assertEqual(domains.compare_key("HTTPS://WWW.Colegio.test:443/a/#x"), domains.compare_key("https://www.colegio.test/a"))
        self.assertEqual(domains.compare_key("https://colegio.test"), domains.compare_key("https://colegio.test/"))
        self.assertNotEqual(domains.compare_key("http://colegio.test/"), domains.compare_key("https://colegio.test/"))
        self.assertNotEqual(domains.compare_key("https://colegio.test/?a=1"), domains.compare_key("https://colegio.test/"))
        self.assertEqual(domains.resolve_url("https://www.colegio.test/a/", " /b/ "), "https://www.colegio.test/b/")
        self.assertEqual(domains.resolve_url("https://www.colegio.test/a/", "c/#top"), "https://www.colegio.test/a/c/")
        for href in ("mailto:info@colegio.test", "tel:+541145678900", "javascript:void(0)", "#", "", "whatsapp://send?phone=1"):
            self.assertIsNone(domains.resolve_url("https://www.colegio.test/", href), href)

    def test_same_site(self) -> None:
        self.assertTrue(domains.is_same_site("https://www.colegio.test/x", "colegio.test"))
        self.assertTrue(domains.is_same_site("https://cdn.colegio.test/x", "colegio.test"))
        self.assertFalse(domains.is_same_site("https://colegio.test.evil.example/", "colegio.test"))
        self.assertFalse(domains.is_same_site("https://micolegio.test/", "colegio.test"))
        self.assertFalse(domains.is_same_site("mailto:a@colegio.test", "colegio.test"))
        self.assertTrue(domains.is_apex_or_www("https://www.colegio.test/", "colegio.test"))
        self.assertFalse(domains.is_apex_or_www("https://cdn.colegio.test/", "colegio.test"))


class CredentialsTest(unittest.TestCase):

    def test_the_key_comes_only_from_the_environment(self) -> None:
        k = credentials.load_api_key(test_mode=False, environ={"PAGESPEED_API_KEY": "  env-key-0000000001\n"})
        self.assertEqual((k.value, k.source), ("env-key-0000000001", "env"))
        k = credentials.load_api_key(test_mode=False, environ={})
        self.assertEqual((k.present, k.source, k.as_datos()), (False, "none", "ausente"))
        k = credentials.load_api_key(test_mode=False, environ={"PAGESPEED_API_KEY": "short"})
        self.assertEqual((k.present, k.problem), (False, "env key too short"))

    def test_test_mode_never_uses_the_real_key(self) -> None:
        env = {"PAGESPEED_API_KEY": "real-env-key-0000000001"}
        k = credentials.load_api_key(test_mode=True, environ=env)
        self.assertEqual((k.value, k.source), (credentials.FAKE_TEST_KEY, "test"))
        k = credentials.load_api_key(test_mode=True, environ=dict(env, SITE_CHECK_TEST_API_KEY=TEST_KEY))
        self.assertEqual(k.value, TEST_KEY)
        k = credentials.load_api_key(test_mode=True, environ=dict(env, SITE_CHECK_TEST_API_KEY=""))
        self.assertFalse(k.present)

    def test_repr_never_shows_the_key(self) -> None:
        k = credentials.ApiKey(TEST_KEY, "env")
        self.assertNotIn(TEST_KEY, repr(k))
        self.assertNotIn(TEST_KEY, str(k))
        self.assertNotIn(TEST_KEY, f"{k}")


    def test_redactor(self) -> None:
        r = credentials.Redactor([TEST_KEY, None])
        self.assertEqual(r.scrub(f"url?x=1 header {TEST_KEY} fin"), "url?x=1 header [REDACTED] fin")
        self.assertEqual(r.scrub_bytes(TEST_KEY.encode()), b"[REDACTED]")
        self.assertTrue(r.contains_secret(f"..{TEST_KEY}.."))
        self.assertFalse(r.contains_secret("nada"))
        self.assertEqual(r.scrub_json({"a": [TEST_KEY], TEST_KEY: 1}), {"a": ["[REDACTED]"], "[REDACTED]": 1})
        with self.assertRaises(ValueError):
            credentials.Redactor(["short"])


class ChallengeTest(unittest.TestCase):
    def test_body_marker(self) -> None:
        self.assertEqual(challenge.body_has_marker(b"<html><title>One moment, please...</title></html>"), "One moment, please")
        self.assertEqual(challenge.body_has_marker(b"<p>JUST A MOMENT</p>"), "Just a moment")
        self.assertIsNone(challenge.body_has_marker(b"<html>Colegio Ejemplo</html>"))

    def test_rules_a_c_d(self) -> None:
        det = challenge.ChallengeDetector()
        html = [("Content-Type", "text/html")]
        v = det.inspect("https://www.colegio.test/", 200, html, b"<h1>One moment, please...</h1>", Expect.HTML)
        self.assertTrue(v.challenged)
        self.assertEqual(v.rule, challenge.Rule.BODY_MARKER)
        v = det.inspect("https://www.colegio.test/robots.txt", 200, html, b"<html><body>ok</body></html>", Expect.TEXT)
        self.assertTrue(v.challenged)
        self.assertEqual(v.rule, challenge.Rule.WRONG_TYPE)
        v = det.inspect("https://www.colegio.test/", 503, html, b"Checking your browser before accessing", Expect.HTML)
        self.assertTrue(v.challenged)
        v = det.inspect("https://www.colegio.test/", 403, [("cf-mitigated", "challenge")], b"", Expect.HTML)
        self.assertTrue(v.challenged)
        v = det.inspect("https://www.colegio.test/", 200, html, b"<html><head></head><body>Colegio</body></html>", Expect.HTML)
        self.assertFalse(v.challenged)

    def test_rule_b_duplicate_small_bodies(self) -> None:
        det = challenge.ChallengeDetector()
        body = b"x" * 12_000
        self.assertEqual(det.register_body("https://www.colegio.test/a/", 200, body), [])
        self.assertEqual(det.register_body("https://www.colegio.test/a/", 200, body), [], "same URL twice is not distinct")
        flagged = det.register_body("https://www.colegio.test/b/", 200, body)
        self.assertEqual(sorted(flagged), ["https://www.colegio.test/a/", "https://www.colegio.test/b/"])
        big = b"y" * 25_000
        det.register_body("https://www.colegio.test/c/", 200, big)
        self.assertEqual(det.register_body("https://www.colegio.test/d/", 200, big), [], "bodies over 20 KB do not count")


class RobotsTest(unittest.TestCase):
    def test_longest_match_and_allow_wins_ties(self) -> None:
        r = robots.parse_robots("User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /x\nAllow: /x\n")
        self.assertTrue(robots.is_allowed(r, "/a/b/c", "*"))
        self.assertFalse(robots.is_allowed(r, "/a/c", "*"))
        self.assertTrue(robots.is_allowed(r, "/x", "*"))
        self.assertTrue(robots.is_allowed(r, "/", "*"))

    def test_wildcards(self) -> None:
        r = robots.parse_robots("User-agent: *\nDisallow: /*.php$\nDisallow: /privado*/\n")
        self.assertFalse(robots.is_allowed(r, "/index.php", "*"))
        self.assertTrue(robots.is_allowed(r, "/index.php?x=1", "*"))
        self.assertFalse(robots.is_allowed(r, "/privado-2024/doc", "*"))
        self.assertTrue(robots.is_allowed(r, "/publico/", "*"))

    def test_googlebot_group_and_fallback(self) -> None:
        r = robots.parse_robots("User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n")
        self.assertTrue(robots.is_allowed(r, "/", "googlebot"))
        self.assertFalse(robots.is_allowed(r, "/", "*"))
        r2 = robots.parse_robots("User-agent: *\nDisallow: /\n")
        self.assertFalse(robots.is_allowed(r2, "/inicio/", "googlebot"))
        r3 = robots.parse_robots("User-agent: *\nDisallow:\n")
        self.assertTrue(robots.is_allowed(r3, "/", "googlebot"))

    def test_sitemaps_are_global(self) -> None:
        r = robots.parse_robots("Sitemap: https://www.colegio.test/a.xml\nUser-agent: *\nDisallow: /wp-admin/\nSitemap: https://www.colegio.test/b.xml\n")
        self.assertEqual(r.sitemaps, ["https://www.colegio.test/a.xml", "https://www.colegio.test/b.xml"])

    def test_classify_response(self) -> None:
        u = "https://www.colegio.test/robots.txt"
        self.assertEqual(robots.classify_response(resp(u, 200, "text/plain", b"User-agent: *\n")), robots.RobotsState.OK)
        self.assertEqual(robots.classify_response(resp(u, 404, "text/html", b"<html>404</html>")), robots.RobotsState.NO_RESTRICTIONS_4XX)
        self.assertEqual(robots.classify_response(resp(u, 503, "text/html", b"")), robots.RobotsState.UNREACHABLE_5XX)
        self.assertEqual(robots.classify_response(resp(u, 200, "text/html", b"<html>One moment</html>")), robots.RobotsState.CHALLENGED)
        self.assertEqual(robots.classify_response(None), robots.RobotsState.ERROR)


HOME_SAMPLE = """<html><head>
<base href="https://www.colegio.test/">
<meta content="https://www.colegio.test/img/og.png" property="og:image">
<link rel="canonical" href="https://www.colegio.test/">
<link rel="alternate" type="application/rss+xml" title="Feed" href="/feed/">
<link rel="alternate" type="application/rss+xml" title="Feed de los comentarios" href="/comments/feed/">
<link rel="alternate" hreflang="en" href="https://www.colegio.test/en/">
<link rel="stylesheet" href="/wp-content/themes/t/style.css?ver=1">
<script src="/wp-includes/js/a.js?ver=6.1.1"></script>
</head><body>
<a href="institucional/">Institucional</a>
<a href=" /contacto/ ">Contacto</a>
<a href="/contacto/#mapa">Contacto otra vez</a>
<a href="/wp-content/uploads/2024/a.pdf">PDF</a>
<a href="/author/admin/">Autor</a>
<a href="/?author=1">Autor 1</a>
<a href="/?s=x">Buscar</a>
<a href="/wp-admin/">Admin</a>
<a href="mailto:info@colegio.test">Correo</a>
<a href="https://otro.example/">Fuera</a>
<a href="https://colegio.test/historia/">Historia</a>
<template><a href="/plantilla/">no</a></template>
</body></html>"""


class LinksTest(unittest.TestCase):
    def test_discover_links(self) -> None:
        ls = links.discover_links(HOME_SAMPLE, "https://www.colegio.test/")
        self.assertEqual(ls.og_images, ["https://www.colegio.test/img/og.png"])
        self.assertEqual(ls.feeds, ["https://www.colegio.test/feed/"])
        self.assertEqual(ls.hreflang, [("en", "https://www.colegio.test/en/")])
        self.assertEqual(ls.canonicals, ["https://www.colegio.test/"])
        self.assertIn("https://www.colegio.test/wp-includes/js/a.js?ver=6.1.1", ls.scripts)
        self.assertIn("https://www.colegio.test/institucional/", ls.anchors)
        self.assertIn("https://www.colegio.test/contacto/", ls.anchors)
        self.assertEqual(ls.anchors.count("https://www.colegio.test/contacto/"), 1)
        self.assertNotIn("https://www.colegio.test/plantilla/", ls.anchors)

    def test_select_link_checks_and_interna(self) -> None:
        ls = links.discover_links(HOME_SAMPLE, "https://www.colegio.test/")
        sel = links.select_link_checks(ls, "colegio.test", None)
        self.assertEqual(
            sel.selected,
            ["https://www.colegio.test/institucional/", "https://www.colegio.test/contacto/", "https://colegio.test/historia/"],
        )
        skipped = {u for u, _ in sel.skipped}
        for u in (
            "https://www.colegio.test/wp-content/uploads/2024/a.pdf",
            "https://www.colegio.test/author/admin/",
            "https://www.colegio.test/?author=1",
            "https://www.colegio.test/?s=x",
            "https://www.colegio.test/wp-admin/",
        ):
            self.assertIn(u, skipped)
        self.assertNotIn("https://otro.example/", sel.selected)
        capped = links.select_link_checks(ls, "colegio.test", None, cap=2)
        self.assertTrue(capped.capped)
        self.assertEqual(len(capped.selected), 2)
        # the contact page is preferred as the interna over the first link.
        self.assertEqual(links.select_interna(ls, "colegio.test", None), "https://www.colegio.test/contacto/")

    def test_robots_disallowed_links_are_skipped(self) -> None:
        ls = links.discover_links(HOME_SAMPLE, "https://www.colegio.test/")
        rb = robots.parse_robots("User-agent: *\nDisallow: /contacto/\n")
        sel = links.select_link_checks(ls, "colegio.test", rb)
        self.assertNotIn("https://www.colegio.test/contacto/", sel.selected)


class SitemapFeedTest(unittest.TestCase):
    def test_sitemap_and_index(self) -> None:
        doc = sitemapfeed.parse_sitemap(
            '<?xml version="1.0"?><urlset><url><loc>https://www.colegio.test/</loc><lastmod>2024-05-20</lastmod></url>'
            "<url><loc>https://www.colegio.test/a/?x=1&amp;y=2</loc></url>"
            "<url><loc><![CDATA[https://www.colegio.test/b/]]></loc></url></urlset>"
        )
        self.assertEqual(doc.kind, sitemapfeed.DocKind.URLSET)
        self.assertEqual(
            doc.locs,
            ["https://www.colegio.test/", "https://www.colegio.test/a/?x=1&y=2", "https://www.colegio.test/b/"],
        )
        self.assertEqual(doc.lastmods, ["2024-05-20"])
        idx = sitemapfeed.parse_sitemap("<sitemapindex><sitemap><loc>https://www.colegio.test/p.xml</loc></sitemap></sitemapindex>")
        self.assertEqual(idx.kind, sitemapfeed.DocKind.SITEMAPINDEX)
        refused = sitemapfeed.parse_sitemap('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><urlset></urlset>')
        self.assertEqual(refused.kind, sitemapfeed.DocKind.REFUSED)

    def test_feed(self) -> None:
        rss = (
            "<rss><channel><title>C</title><description>Otro sitio realizado con WordPress</description>"
            "<generator>https://wordpress.org/?v=6.1.1</generator>"
            "<item><title>A</title><pubDate>Mon, 20 May 2024 10:00:00 +0000</pubDate></item></channel></rss>"
        )
        f = sitemapfeed.parse_feed(rss)
        self.assertEqual(f.kind, sitemapfeed.DocKind.RSS)
        self.assertEqual(f.channel_description, "Otro sitio realizado con WordPress")
        self.assertEqual(f.items[0].date, dt.datetime(2024, 5, 20, 10, 0, tzinfo=UTC))
        self.assertEqual(sitemapfeed.wordpress_version_from_generator(f.generator), "6.1.1")
        atom = sitemapfeed.parse_feed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><updated>2025-01-02T03:04:05Z</updated></entry></feed>')
        self.assertEqual(atom.kind, sitemapfeed.DocKind.ATOM)
        self.assertEqual(atom.items[0].date, dt.datetime(2025, 1, 2, 3, 4, 5, tzinfo=UTC))
        self.assertIsNone(sitemapfeed.wordpress_version_from_generator("Joomla! - Open Source"))

    def test_looks_like_sitemap(self) -> None:
        u = "https://www.colegio.test/sitemap.xml"
        self.assertTrue(sitemapfeed.looks_like_sitemap(resp(u, 200, "application/xml", b'<?xml version="1.0"?><urlset></urlset>')))
        self.assertFalse(sitemapfeed.looks_like_sitemap(resp(u, 200, "text/html", b"<html>One moment</html>")))
        self.assertFalse(sitemapfeed.looks_like_sitemap(resp(u, 404, "application/xml", b"<urlset/>")))


class ImageSizeTest(unittest.TestCase):
    def test_png_gif_jpeg_webp(self) -> None:
        self.assertEqual(imagesize.image_info(png_bytes(1200, 630)), imagesize.ImageInfo("png", 1200, 630))
        gif = b"GIF89a" + struct.pack("<HH", 320, 200) + b"\x00" * 10
        self.assertEqual(imagesize.image_info(gif), imagesize.ImageInfo("gif", 320, 200))
        jpeg = b"\xff\xd8" + b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9 + b"\xff\xc0" + struct.pack(">HBHH", 17, 8, 630, 1200) + b"\x00" * 10
        self.assertEqual(imagesize.image_info(jpeg), imagesize.ImageInfo("jpeg", 1200, 630))
        vp8x = b"RIFF" + struct.pack("<I", 30) + b"WEBP" + b"VP8X" + struct.pack("<I", 10) + b"\x00" * 4 + (1199).to_bytes(3, "little") + (629).to_bytes(3, "little")
        self.assertEqual(imagesize.image_info(vp8x), imagesize.ImageInfo("webp", 1200, 630))
        self.assertIsNone(imagesize.image_info(b"not an image"))
        self.assertIsNone(imagesize.image_info(png_bytes(1200, 630)[:20]))


class DblTest(unittest.TestCase):
    def test_classification(self) -> None:
        r = dbl.classify(None, nxdomain=True)
        self.assertEqual(r.verdict, dbl.DblVerdict.NOT_LISTED)
        r = dbl.classify(["127.0.1.2"])
        self.assertEqual((r.verdict, r.mail_listing, r.hack_signal), (dbl.DblVerdict.LISTED, True, False))
        r = dbl.classify(["127.0.1.4"])
        self.assertEqual((r.verdict, r.hack_signal), (dbl.DblVerdict.LISTED, True))
        self.assertTrue(dbl.classify(["127.0.1.103"]).hack_signal)
        for refused in ("127.255.255.252", "127.255.255.254", "127.255.255.255"):
            r = dbl.classify([refused])
            self.assertEqual(r.verdict, dbl.DblVerdict.REFUSED, refused)
            self.assertFalse(r.hack_signal)
        self.assertEqual(dbl.classify(None, error="timeout").verdict, dbl.DblVerdict.ERROR)
        self.assertEqual(dbl.classify(["10.0.0.1"]).verdict, dbl.DblVerdict.ERROR)


class TlsTest(unittest.TestCase):
    def test_days_left(self) -> None:
        now = dt.datetime(2026, 10, 9, 0, 0, tzinfo=UTC)
        self.assertEqual(tlsprobe.days_left("Jan  1 06:40:15 2027 GMT", now), 84)
        self.assertEqual(tlsprobe.days_left("2026-10-16T00:00:00+00:00", now), 7)
        self.assertEqual(tlsprobe.days_left("2026-10-08T12:00:00+00:00", now), -1)


class RdapTest(unittest.TestCase):
    RAW = {
        "objectClassName": "domain",
        "ldhName": "COLEGIO-Ejemplo.COM",
        "status": ["client transfer prohibited"],
        "events": [
            {"eventAction": "registration", "eventDate": "2010-03-01T00:00:00Z"},
            {"eventAction": "expiration", "eventDate": "2026-12-01T00:00:00Z"},
            {"eventAction": "last update of RDAP database", "eventDate": "2026-10-09T00:00:00Z"},
        ],
        "entities": [{"vcardArray": ["vcard", [["fn", {}, "text", "Juana Titular Ficticia"]]]}],
        "notices": [{"title": "Terms"}],
        "secureDNS": {"delegationSigned": True},
    }

    def test_urls(self) -> None:
        e = Endpoints()
        self.assertEqual(rdap.rdap_url("colegio-ejemplo.com.ar", e), "https://rdap.nic.ar/domain/colegio-ejemplo.com.ar")
        self.assertEqual(rdap.rdap_url("colegio-ejemplo.edu.ar", e), "https://rdap.nic.ar/domain/colegio-ejemplo.edu.ar")
        self.assertEqual(rdap.rdap_url("colegio-ejemplo.com", e), "https://rdap.org/domain/colegio-ejemplo.com")

    def test_scrub_keeps_no_holder_data(self) -> None:
        s = rdap.scrub_rdap(self.RAW)
        self.assertNotIn("entities", s)
        self.assertNotIn("notices", s)
        self.assertNotIn("Juana", repr(s))
        self.assertIn("events", s)

    def test_parse(self) -> None:
        r = rdap.parse_rdap(self.RAW, "colegio-ejemplo.com", dt.datetime(2026, 10, 9, tzinfo=UTC))
        self.assertEqual(r.expiration, "2026-12-01T00:00:00+00:00")
        self.assertEqual(r.days_left, 53)
        self.assertEqual(r.status, ["client transfer prohibited"])
        self.assertTrue(r.delegation_signed)
        no_exp = dict(self.RAW, events=[{"eventAction": "last update of RDAP database", "eventDate": "2026-10-09T00:00:00Z"}])
        r = rdap.parse_rdap(no_exp, "colegio-ejemplo.com", dt.datetime(2026, 10, 9, tzinfo=UTC))
        self.assertIsNone(r.expiration)
        self.assertEqual(r.error, "no-expiration-event")


class DohTest(unittest.TestCase):
    def test_txt_normalization(self) -> None:
        self.assertEqual(doh.normalize_txt('"v=spf1 include:_spf.google.com" " ~all"'), "v=spf1 include:_spf.google.com ~all")
        self.assertEqual(doh.normalize_txt("v=spf1 -all"), "v=spf1 -all")
        self.assertEqual(doh.normalize_txt('"a \\"b\\" c"'), 'a "b" c')

    def test_parse_states(self) -> None:
        ok = {"Status": 0, "Answer": [{"name": "x.test.", "type": 5, "data": "y.test."}, {"name": "y.test.", "type": 16, "data": '"v=spf1 -all"'}]}
        a = doh.parse_doh_json(ok, "x.test", "TXT", "cloudflare")
        self.assertEqual((a.status, a.records), (doh.DnsStatus.NOERROR, ["v=spf1 -all"]))
        self.assertEqual(doh.parse_doh_json({"Status": 0}, "x.test", "TXT", "dns.google").status, doh.DnsStatus.NODATA)
        self.assertEqual(doh.parse_doh_json({"Status": 3}, "x.test", "TXT", "dns.google").status, doh.DnsStatus.NXDOMAIN)
        self.assertEqual(doh.parse_doh_json({"Status": 2}, "x.test", "TXT", "dns.google").status, doh.DnsStatus.SERVFAIL)

    def test_mx_provider(self) -> None:
        self.assertEqual(doh.mx_provider(["1 aspmx.l.google.com."]), "google")
        self.assertEqual(doh.mx_provider(["0 colegio-com-ar.mail.protection.outlook.com."]), "microsoft")
        self.assertEqual(doh.mx_provider(["10 mx1.control.test."]), "otro")
        self.assertIsNone(doh.mx_provider([]))


class PsiParsingTest(unittest.TestCase):
    URL = "https://www.colegio.test/"

    def test_build_url_never_has_a_key(self) -> None:
        u = psi.build_url("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", self.URL, psi.STRATEGY_MOBILE)
        self.assertIn("strategy=MOBILE", u)
        for c in psi.CATEGORIES:
            self.assertIn(f"category={c}", u)
        self.assertIn("locale=es", u)
        self.assertNotIn("key=", u)

    def test_field_data_cls_is_divided_by_100(self) -> None:
        run = psi.parse_psi(psi_payload(self.URL, field_cls_pct=5, field_inp_ms=None), strategy="MOBILE", n=1, registrable="colegio.test")
        self.assertTrue(run.ok)
        self.assertEqual(run.field_data.lcp_ms, 4830)
        self.assertIsNone(run.field_data.inp_ms)
        self.assertAlmostEqual(run.field_data.cls, 0.05)
        self.assertEqual(run.field_data.scope, "pagina")
        self.assertEqual(run.lab_lcp_ms, 4830.0)
        self.assertAlmostEqual(run.lab_cls, 0.04)
        self.assertEqual(run.scores, {"performance": 45, "accessibility": 88, "best-practices": 92, "seo": 85})
        self.assertEqual(run.lighthouse_version, "13.5.0")

    def test_origin_scope_and_no_field(self) -> None:
        run = psi.parse_psi(psi_payload(self.URL, origin_only=True), strategy="MOBILE", n=1, registrable="colegio.test")
        self.assertEqual(run.field_data.scope, "origen")
        run = psi.parse_psi(psi_payload(self.URL, field_lcp_ms=None, field_inp_ms=None, field_cls_pct=None), strategy="MOBILE", n=1, registrable="colegio.test")
        self.assertIsNone(run.field_data)

    def test_invalid_runs(self) -> None:
        run = psi.parse_psi(psi_payload(self.URL, runtime_error="NO_FCP"), strategy="MOBILE", n=1, registrable="colegio.test")
        self.assertFalse(run.ok)
        self.assertEqual(run.error, "runtime-error:NO_FCP")
        run = psi.parse_psi(psi_payload("https://parking.example/"), strategy="MOBILE", n=1, registrable="colegio.test")
        self.assertFalse(run.ok)
        self.assertEqual(run.error, "outside-domain")

    def test_audits_are_read_defensively(self) -> None:
        data = psi_payload(self.URL)
        audits = data["lighthouseResult"]["audits"]
        self.assertEqual(psi.find_audit(audits, "third_parties").id, "third-parties-insight")
        legacy = {"third-party-summary": {"id": "third-party-summary", "score": None, "scoreDisplayMode": "informative"}}
        self.assertEqual(psi.find_audit(legacy, "third_parties").id, "third-party-summary")
        self.assertIsNone(psi.find_audit({}, "image_delivery"))
        self.assertEqual(psi.find_audit(audits, "color_contrast").failing_items, 2)
        scores = psi.category_scores({"lighthouseResult": {"categories": {"performance": {"score": 0.455}, "seo": {"score": None}}}})
        self.assertEqual(scores["performance"], 46)
        self.assertIsNone(scores["seo"])
        self.assertIsNone(scores["accessibility"])

    def test_median_run(self) -> None:
        runs = [
            psi.parse_psi(psi_payload(self.URL, lab_lcp_ms=v), strategy="MOBILE", n=i, registrable="colegio.test")
            for i, v in enumerate((5120.0, 4600.0, 4830.0), 1)
        ]
        self.assertEqual(psi.median_run(runs).lab_lcp_ms, 4830.0)
        self.assertEqual(psi.median_run(runs[:2]).lab_lcp_ms, 4600.0, "even count: lower middle")


def _der(tag: int, content: bytes) -> bytes:
    """Hand-built DER TLV (short or one-byte long length), for the validity walker test."""
    n = len(content)
    length = bytes([n]) if n < 0x80 else bytes([0x81, n])
    return bytes([tag]) + length + content


class DecodeBodyTest(unittest.TestCase):
    TEXT = ("<html><head><title>Colegio</title></head><body>" + "Inscripciones abiertas. " * 200 + "</body></html>").encode("utf-8")

    def test_gzip_deflate_and_identity(self) -> None:
        import gzip
        import zlib

        from sitecheck.httpclient import decode_body

        self.assertEqual(decode_body(gzip.compress(self.TEXT), "gzip", 10_000_000), (self.TEXT, None, False))
        self.assertEqual(decode_body(zlib.compress(self.TEXT), "deflate", 10_000_000), (self.TEXT, None, False))
        raw_deflate = zlib.compressobj(wbits=-15)
        raw = raw_deflate.compress(self.TEXT) + raw_deflate.flush()
        self.assertEqual(decode_body(raw, "deflate", 10_000_000), (self.TEXT, None, False))
        self.assertEqual(decode_body(self.TEXT, None, 10_000_000), (self.TEXT, None, False))

    @unittest.skipUnless(importlib.util.find_spec("compression") is not None, "zstd needs Python 3.14")
    def test_zstd_and_chains(self) -> None:
        import gzip

        from compression import zstd

        from sitecheck.httpclient import decode_body

        self.assertEqual(decode_body(zstd.compress(self.TEXT), "zstd", 10_000_000), (self.TEXT, None, False))
        both = zstd.compress(gzip.compress(self.TEXT))  # applied gzip first, then zstd
        self.assertEqual(decode_body(both, "gzip, zstd", 10_000_000), (self.TEXT, None, False))

    def test_zstd_is_offered_only_when_it_can_be_decoded(self) -> None:
        from sitecheck import httpclient

        offered = "zstd" in httpclient.ACCEPT_ENCODING
        self.assertEqual(offered, importlib.util.find_spec("compression") is not None)

    def test_unknown_encoding_and_bomb_cap(self) -> None:
        import gzip

        from sitecheck.httpclient import decode_body

        self.assertEqual(decode_body(b"\x0b\x02brotli", "br", 1000), (b"\x0b\x02brotli", "br", False))
        bomb = gzip.compress(b"\x00" * 1_000_000)
        decoded, undecodable, truncated = decode_body(bomb, "gzip", 4096)
        self.assertEqual((len(decoded), undecodable, truncated), (4096, None, True))
        self.assertEqual(decode_body(b"not gzip at all", "gzip", 1000), (b"not gzip at all", "gzip", False))


class TextAndRobotsTypeTest(unittest.TestCase):
    def test_charset_from_header_meta_and_default(self) -> None:
        latin = "Educación".encode("cp1252")
        r = resp("https://www.colegio.test/", 200, "text/html; charset=ISO-8859-1", b"<p>" + latin + b"</p>")
        self.assertEqual(r.text(), ("<p>Educación</p>", 0))
        meta = b'<html><head><meta charset="windows-1252"></head><body>' + latin + b"</body></html>"
        self.assertIn("Educación", resp("https://www.colegio.test/", 200, "text/html", meta).text()[0])
        # No charset declared and not valid UTF-8: windows-1252, like a browser in es-AR.
        undeclared = resp("https://www.colegio.test/", 200, "text/html", b"<p>" + latin + b"</p>")
        self.assertEqual(undeclared.text(), ("<p>Educación</p>", 0))
        utf8 = resp("https://www.colegio.test/", 200, "text/html", "<p>Educación</p>".encode("utf-8"))
        self.assertEqual(utf8.text(), ("<p>Educación</p>", 0))

    def test_plain_robots_mislabelled_as_html_is_invalid_not_a_challenge(self) -> None:
        body = b"User-agent: *\nDisallow: /wp-admin/\n"
        r = resp("https://www.colegio.test/robots.txt", 200, "text/html", body)
        self.assertEqual(robots.classify_response(r), robots.RobotsState.INVALID)
        det = challenge.ChallengeDetector()
        self.assertFalse(det.inspect(r.url, 200, r.headers, body, Expect.TEXT).challenged)


class DerValidityTest(unittest.TestCase):
    def test_validity_of_a_hand_built_certificate(self) -> None:
        validity = _der(0x30, _der(0x17, b"260101000000Z") + _der(0x18, b"20270315123045Z"))
        tbs = _der(0x30, _der(0xA0, _der(0x02, b"\x02")) + _der(0x02, b"\x01") + _der(0x30, b"") + _der(0x30, b"") + validity)
        cert = _der(0x30, tbs + _der(0x30, b"") + _der(0x03, b"\x00"))
        self.assertEqual(
            tlsprobe.der_validity(cert),
            (dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC), dt.datetime(2027, 3, 15, 12, 30, 45, tzinfo=UTC)),
        )
        self.assertIsNone(tlsprobe.der_validity(b"\x30\x05garbage"))
        self.assertIsNone(tlsprobe.der_validity(b""))


class DblControlTest(unittest.TestCase):
    """The NXDOMAIN of the target is trusted only when the RFC 5782 test point comes back listed."""

    def _client(self, answers: dict[str, list[str] | None]):
        from sitecheck.credentials import Redactor
        from sitecheck.requestlog import RequestLog
        from sitecheck.scope import ScopeGuard

        asked: list[str] = []

        def resolver(name: str) -> list[str]:
            asked.append(name)
            value = answers.get(name)
            if value is None:
                raise dbl.NxDomain(name)
            return value

        g = ScopeGuard("colegio.test", "https://www.colegio.test/", Endpoints.for_test("http://127.0.0.1:9"), test_loopback=True)
        log = RequestLog(None, Redactor([]))
        return dbl.DblClient(g, log, resolver=resolver), asked, log

    def test_not_listed_with_a_working_control(self) -> None:
        c, asked, log = self._client({"test.dbl.spamhaus.org.": ["127.0.1.2"]})
        r = c.lookup("colegio.test")
        self.assertEqual((r.verdict, r.control_ok, r.query_name), (dbl.DblVerdict.NOT_LISTED, True, "colegio.test.dbl.spamhaus.org."))
        self.assertEqual(asked, ["colegio.test.dbl.spamhaus.org.", "test.dbl.spamhaus.org."])
        self.assertEqual([x.url for x in log.records()], ["dns:colegio.test.dbl.spamhaus.org.", "dns:test.dbl.spamhaus.org."])

    def test_failed_control_is_never_not_listed(self) -> None:
        c, _, _ = self._client({})
        r = c.lookup("colegio.test")
        self.assertEqual((r.verdict, r.error, r.control_ok), (dbl.DblVerdict.ERROR, "control-failed", False))
        c, _, _ = self._client({"test.dbl.spamhaus.org.": ["127.255.255.254"]})
        self.assertEqual(c.lookup("colegio.test").verdict, dbl.DblVerdict.REFUSED)

    def test_a_listing_needs_no_control(self) -> None:
        c, asked, _ = self._client({"colegio.test.dbl.spamhaus.org.": ["127.0.1.2"]})
        r = c.lookup("colegio.test")
        self.assertEqual((r.verdict, r.mail_listing, r.control_ok), (dbl.DblVerdict.LISTED, True, None))
        self.assertEqual(asked, ["colegio.test.dbl.spamhaus.org."])


if __name__ == "__main__":
    unittest.main()
