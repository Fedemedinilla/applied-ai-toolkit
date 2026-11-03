"""Security seen from outside (EXT-07, 13, 17, 16, 01, 02, 09, 23, 25) and the e-mail
authentication records of the domain (EXT-05).
"""

from __future__ import annotations

import datetime as dt
import json
import unittest

import support  # noqa: F401

from sitecheck.checks import mailauth, security
from sitecheck.dbl import DblResult, classify
from sitecheck.doh import DnsAnswer, DnsBundle, DnsStatus, MailDns
from sitecheck.model import State
from sitecheck.observations import FeedFetch, VariantProbe
from sitecheck.rdap import RdapResult
from sitecheck.sitemapfeed import DocKind, FeedDoc
from sitecheck.tlsprobe import TlsResult
from sitecheck.wpapi import WpVersionStatus
from obsfactory import BASE, HOME, html_page, link_survey, make_ctx, make_obs

FORBIDDEN_IN_CLIENT_TEXT = ("certificado", "inseguro", "insecure", "\u2014", "\u2013")


def ev(fn, obs, **ctx_kw):
    return fn(obs, make_ctx(obs, **ctx_kw))


class Ext07Test(unittest.TestCase):
    def test_expired_and_inconclusive(self) -> None:
        f = ev(security.evaluate_ext07, make_obs(html_page(), tls=[self.tls(-2, ok=False, verify_code=10, verify_message="certificate has expired", error="verify")]))
        self.assertEqual(f.state, State.FALLA)
        # Verify code 10 reads "venció", never "no es válida".
        self.assertEqual(f.phrase_report.found, "El navegador no acepta la conexión segura del sitio (venció)")
        f = ev(security.evaluate_ext07, make_obs(html_page(), tls=[self.tls(None, ok=False, verify_code=20, inconclusive=True, error="verify")]))
        self.assertEqual(f.state, State.NO_VERIFICADO)
        for days in (5, 10, 40):
            f = ev(security.evaluate_ext07, make_obs(html_page(), tls=[self.tls(days)]))
            pr = f.phrase_report
            text = " ".join([f.reason or "", f.note or "", pr.found, pr.consequence, pr.action, pr.who]).lower()
            for bad in FORBIDDEN_IN_CLIENT_TEXT:
                self.assertNotIn(bad, text)

    def tls(self, days: int | None, **kw) -> TlsResult:
        not_after = (dt.datetime(2026, 10, 9, 12, tzinfo=dt.timezone.utc) + dt.timedelta(days=days)).isoformat() if days is not None else None
        return TlsResult("www.colegio.test", ok=kw.pop("ok", True), alpn="h2", not_after=not_after, days_left=days, **kw)

    def test_thresholds_of_decision_19(self) -> None:
        f = ev(security.evaluate_ext07, make_obs(html_page(), tls=[self.tls(5)]))
        self.assertEqual(f.state, State.FALLA)
        f = ev(security.evaluate_ext07, make_obs(html_page(), tls=[self.tls(10)]))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        f = ev(security.evaluate_ext07, make_obs(html_page(), tls=[self.tls(40)]))
        self.assertEqual(f.state, State.APROBADO)
        self.assertIn("no se midieron", (f.note or "").lower())


class Ext13Test(unittest.TestCase):
    def rdap(self, days: int | None, **kw) -> RdapResult:
        exp = (dt.datetime(2026, 10, 9, 12, tzinfo=dt.timezone.utc) + dt.timedelta(days=days)).isoformat() if days is not None else None
        return RdapResult("colegio-ejemplo.com", "com", expiration=exp, days_left=days, **kw)

    def test_thresholds_of_decision_18(self) -> None:
        f = ev(security.evaluate_ext13, make_obs(html_page(), rdap=self.rdap(20)))
        self.assertEqual(f.state, State.FALLA)
        f = ev(security.evaluate_ext13, make_obs(html_page(), rdap=self.rdap(45)))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(ev(security.evaluate_ext13, make_obs(html_page(), rdap=self.rdap(200))).state, State.APROBADO)
        f = ev(security.evaluate_ext13, make_obs(html_page(), rdap=self.rdap(200, status=["pending delete"])))
        self.assertEqual(f.state, State.FALLA)

    def test_edu_ar_without_rdap(self) -> None:
        r = RdapResult("colegio-ejemplo.edu.ar", "edu.ar", http_status=404, error="http-404")
        f = ev(security.evaluate_ext13, make_obs(html_page(), rdap=r))
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertIn("nic.ar", f.reason)


class Ext17Test(unittest.TestCase):
    def variant(self, start: str, statuses: list[int], hops: int, *, reached: bool = True) -> VariantProbe:
        return VariantProbe(start_url=start, statuses=statuses, final_url=HOME if reached else start, final_status=statuses[-1] if statuses else None, hops=hops, reached_canonical=reached)

    def test_states(self) -> None:
        good = [
            self.variant("http://colegio.test/", [301], 1),
            self.variant("https://colegio.test/", [301], 1),
            self.variant("http://www.colegio.test/", [301], 1),
            self.variant(HOME, [200], 0),
        ]
        self.assertEqual(ev(security.evaluate_ext17, make_obs(html_page(), variants=good)).state, State.APROBADO)
        temporary = list(good)
        temporary[0] = self.variant("http://colegio.test/", [302], 1)
        self.assertEqual(ev(security.evaluate_ext17, make_obs(html_page(), variants=temporary)).state, State.APROBADO_CON_OBSERVACION)
        http_open = list(good)
        http_open[2] = self.variant("http://www.colegio.test/", [200], 0, reached=False)
        self.assertEqual(ev(security.evaluate_ext17, make_obs(html_page(), variants=http_open)).state, State.FALLA)


class HeadersTest(unittest.TestCase):
    def home_with(self, *headers: tuple[str, str]):
        return make_obs(html_page(), home_headers=[("Content-Type", "text/html; charset=UTF-8"), *headers])

    def test_ext01(self) -> None:
        obs = self.home_with(("Strict-Transport-Security", "max-age=31536000"), ("X-Content-Type-Options", "nosniff"))
        f = ev(security.evaluate_ext01, obs)
        # the tool's two with 2 of 6 is an observation, never a green next to "2 de 6".
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(f.measured["n_protections"], 2)
        all_six = self.home_with(
            ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
            ("X-Content-Type-Options", "nosniff"),
            ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'"),
            ("Referrer-Policy", "strict-origin-when-cross-origin"),
            ("Permissions-Policy", "camera=()"),
        )
        self.assertEqual(ev(security.evaluate_ext01, all_six).measured["n_protections"], 6)
        self.assertEqual(ev(security.evaluate_ext01, all_six).state, State.APROBADO)
        short = self.home_with(("Strict-Transport-Security", "max-age=300"), ("X-Content-Type-Options", "nosniff"))
        self.assertEqual(ev(security.evaluate_ext01, short).state, State.FALLA)
        report_only = self.home_with(("Content-Security-Policy-Report-Only", "default-src 'self'"))
        self.assertEqual(ev(security.evaluate_ext01, report_only).measured["n_protections"], 0)

    def test_ext09(self) -> None:
        self.assertEqual(ev(security.evaluate_ext09, self.home_with(("Server", "Apache/2.4.41 (Ubuntu)"))).state, State.FALLA)
        self.assertEqual(ev(security.evaluate_ext09, self.home_with(("X-Powered-By", "PHP/7.4.33"))).state, State.FALLA)
        self.assertEqual(ev(security.evaluate_ext09, self.home_with(("Server", "Apache"))).state, State.APROBADO)
        self.assertEqual(ev(security.evaluate_ext09, self.home_with(("Server", "LiteSpeed"))).state, State.APROBADO)

    def test_ext16_mixed_content(self) -> None:
        obs = make_obs(html_page(body='<img src="http://www.colegio.test/a.jpg" alt="a">'))
        self.assertEqual(ev(security.evaluate_ext16, obs).state, State.FALLA)
        obs = make_obs(html_page(head='<link rel="profile" href="http://gmpg.org/xfn/11">', body='<a href="http://ministerio.example/">Ministerio</a>'))
        self.assertEqual(ev(security.evaluate_ext16, obs).state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(ev(security.evaluate_ext16, make_obs(html_page())).state, State.APROBADO)


class Ext02Test(unittest.TestCase):
    GEN = '<meta name="generator" content="WordPress 6.1.1">'
    CORE = '<script src="https://www.colegio.test/wp-includes/js/wp-emoji-release.min.js?ver=6.1.1"></script>'

    def test_old_visible_version_stays_in_the_report(self) -> None:
        obs = make_obs(html_page(self.GEN + self.CORE), wp_status=WpVersionStatus("6.1.1", "insecure", "7.1.3", True))
        f = ev(security.evaluate_ext02, obs)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(
            f.phrase_report.found,
            "El sitio funciona con WordPress 6.1.1, de la rama de noviembre de 2022, y la versión se ve desde afuera",
        )
        self.assertEqual(f.phrase_report.consequence, "Alguien puede buscar fallas conocidas de esa versión y entrar")

    def test_unknown_place_in_a_branch_of_last_year(self) -> None:
        gen = '<meta name="generator" content="WordPress 7.0.1">'
        obs = make_obs(html_page(gen), wp_status=WpVersionStatus("7.0.1", "outdated", "7.1.3", True))
        f = ev(security.evaluate_ext02, obs, run_date=dt.date(2027, 6, 1))
        # Without the highest-of-branch fact the report claims no known flaw, only a conditional one.
        self.assertEqual(
            f.phrase_report.found,
            "El sitio funciona con WordPress 7.0.1, de la rama de mayo de 2026, y la versión se ve desde afuera",
        )
        self.assertEqual(
            f.phrase_report.consequence, "Si le faltan actualizaciones, alguien puede buscar fallas conocidas de esa versión"
        )

    def test_current_version_stays_in_the_report(self) -> None:
        gen = '<meta name="generator" content="WordPress 7.1.3">'
        obs = make_obs(html_page(gen), wp_status=WpVersionStatus("7.1.3", "latest", "7.1.3", True))
        f = ev(security.evaluate_ext02, obs)
        self.assertEqual(f.state, State.FALLA)

    def test_hidden_version_feed_version_and_no_cms(self) -> None:
        plugin_only = '<script src="https://www.colegio.test/wp-content/plugins/contact-form-7/index.js?ver=5.7.2"></script>'
        self.assertEqual(ev(security.evaluate_ext02, make_obs(html_page(plugin_only))).state, State.APROBADO)
        feed = FeedFetch(url=f"{BASE}/feed/", doc=FeedDoc(kind=DocKind.RSS, generator="https://wordpress.org/?v=6.1.1"))
        obs = make_obs(html_page(plugin_only), feed=feed, wp_status=WpVersionStatus("6.1.1", "insecure", "7.1.3", True))
        self.assertEqual(ev(security.evaluate_ext02, obs).state, State.FALLA)
        self.assertEqual(ev(security.evaluate_ext02, make_obs(html_page("<p>sitio estático</p>"))).state, State.NO_APLICA)


class Ext23Test(unittest.TestCase):
    def with_dbl(self, result: DblResult):
        return ev(security.evaluate_ext23, make_obs(html_page(), dbl=result))

    def test_not_listed_is_still_grey_without_google(self) -> None:
        f = self.with_dbl(classify(None, nxdomain=True))
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertIn("google", f.reason.lower())

    def test_spam_listing_is_a_failure(self) -> None:
        f = self.with_dbl(classify(["127.0.1.2"]))
        self.assertEqual(f.state, State.FALLA)
        self.assertFalse(f.hack_signal)

    def test_abuse_codes_fire_the_hack_gate(self) -> None:
        f = self.with_dbl(classify(["127.0.1.4"]))
        self.assertEqual(f.state, State.FALLA)
        self.assertTrue(f.hack_signal)

    def test_refused_lookup_is_never_a_verdict(self) -> None:
        f = self.with_dbl(classify(["127.255.255.254"]))
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertIn("spamhaus", f.reason.lower())


class Ext25Test(unittest.TestCase):
    def test_privacy_policy(self) -> None:
        link = f'<a href="{BASE}/politica-de-privacidad/">Política de privacidad</a>'
        obs = make_obs(html_page(body=link), links=link_survey({f"{BASE}/politica-de-privacidad/": 200}))
        self.assertEqual(ev(security.evaluate_ext25, obs).state, State.APROBADO)
        elsewhere = make_obs(html_page(body='<a href="http://agencia-anterior.example/privacidad">Protección de datos personales</a>'))
        self.assertEqual(ev(security.evaluate_ext25, elsewhere).state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(ev(security.evaluate_ext25, make_obs(html_page())).state, State.FALLA)


def mail_dns(domain: str, *, txt: list[str], dmarc: list[str] | None, mx: list[str], dkim: dict[str, list[str] | None] | None = None) -> MailDns:
    def ans(name: str, rtype: str, recs: list[str] | None) -> DnsAnswer:
        if recs is None:
            return DnsAnswer(name, rtype, DnsStatus.NXDOMAIN, resolver="dns.google")
        return DnsAnswer(name, rtype, DnsStatus.NOERROR if recs else DnsStatus.NODATA, recs, resolver="dns.google")

    return MailDns(
        domain=domain,
        txt=ans(domain, "TXT", txt),
        dmarc=ans(f"_dmarc.{domain}", "TXT", dmarc),
        mx=ans(domain, "MX", mx),
        provider="google" if any("google" in m for m in mx) else ("otro" if mx else None),
        dkim={sel: ans(f"{sel}._domainkey.{domain}", "TXT", recs) for sel, recs in (dkim or {}).items()},
    )


CONTROL = mail_dns("control.test", txt=["v=spf1 include:_spf.control.test ~all"], dmarc=["v=DMARC1; p=none"], mx=["10 mx1.control.test."])
GOOGLE_MX = ["1 aspmx.l.google.com."]
DKIM_OK = {"google": ["v=DKIM1; k=rsa; p=MIIB"]}


class Ext05Test(unittest.TestCase):
    def evaluate(self, site: MailDns, control_ok: bool = True):
        return ev(mailauth.evaluate_ext05, make_obs(html_page(), dns=DnsBundle(site=site, control=CONTROL, control_ok=control_ok)))

    def test_complete(self) -> None:
        site = mail_dns("colegio.test", txt=["v=spf1 include:_spf.google.com ~all"], dmarc=["v=DMARC1; p=none; rua=mailto:dmarc@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)
        f = self.evaluate(site)
        self.assertEqual(f.state, State.APROBADO)
        self.assertNotIn("dmarc@colegio.test", json.dumps(f.measured), "no site e-mail in datos.json")

    def test_failures(self) -> None:
        no_dmarc = mail_dns("colegio.test", txt=["v=spf1 include:_spf.google.com ~all"], dmarc=None, mx=GOOGLE_MX, dkim=DKIM_OK)
        f = self.evaluate(no_dmarc)
        self.assertEqual((f.state, f.measured["caso_mail"]), (State.FALLA, 8))
        two_spf = mail_dns("colegio.test", txt=["v=spf1 a ~all", "v=spf1 mx -all"], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)
        self.assertEqual(self.evaluate(two_spf).state, State.FALLA)
        plus_all = mail_dns("colegio.test", txt=["v=spf1 +all"], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)
        self.assertEqual(self.evaluate(plus_all).state, State.FALLA)
        # A DMARC without rua= changes no delivery: an observation for the report, not a FALLA.
        no_rua = mail_dns("colegio.test", txt=["v=spf1 ~all"], dmarc=["v=DMARC1; p=none"], mx=GOOGLE_MX, dkim=DKIM_OK)
        self.assertEqual(self.evaluate(no_rua).state, State.APROBADO_CON_OBSERVACION)

    def test_observations_not_applicable_and_control(self) -> None:
        no_dkim = mail_dns("colegio.test", txt=["v=spf1 include:_spf.google.com ~all"], dmarc=["v=DMARC1; p=quarantine; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim={"google": None})
        self.assertEqual(self.evaluate(no_dkim).state, State.APROBADO_CON_OBSERVACION)
        neutral = mail_dns("colegio.test", txt=["v=spf1 ?all"], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)
        self.assertEqual(self.evaluate(neutral).state, State.APROBADO_CON_OBSERVACION)
        no_mx = mail_dns("colegio.test", txt=[], dmarc=None, mx=[])
        self.assertEqual(self.evaluate(no_mx).state, State.NO_APLICA)
        ok = mail_dns("colegio.test", txt=["v=spf1 ~all"], dmarc=None, mx=GOOGLE_MX)
        self.assertEqual(self.evaluate(ok, control_ok=False).state, State.NO_VERIFICADO)


if __name__ == "__main__":
    unittest.main()
