"""Regression tests of the checks: EXT-24 false positives, the title-name test,
field data versus lab data, threshold figures, WhatsApp detection, kinds,
old WordPress versions, mail-record texts, site-text injection and the
report as a whole. Expected phrases and numbers are written by hand per case.
"""

from __future__ import annotations

import datetime as dt
import re
import unittest

import support  # noqa: F401
from obsfactory import BASE, field, html_page, make_ctx, make_obs, psi_series
from test_checks_security import CONTROL, DKIM_OK, GOOGLE_MX, mail_dns

from sitecheck import fmt
from sitecheck.checks import common, contact, content, mailauth, security, seo, speed, tables
from sitecheck.doh import DnsBundle
from sitecheck.model import State
from sitecheck.observations import SitemapFetch
from sitecheck.psi import AuditResult, FieldMetrics, PsiRun, PsiSeries
from sitecheck.rdap import RdapResult
from sitecheck.sitemapfeed import DocKind, SitemapDoc
from sitecheck.wpapi import WpVersionStatus
from fakeapis import psi_payload
from fixhelp import run_e2e
from sitefixtures import SchoolOptions, default_apis, school_scenario

DESCRIPTION = (
    '<meta name="description" content="Colegio Ejemplo acompaña a cada familia desde el nivel inicial hasta la '
    'secundaria, con jornada completa, inglés y talleres en Buenos Aires.">'
)


def ev(fn, obs, **ctx_kw):
    return fn(obs, make_ctx(obs, **ctx_kw))


# ---------------------------------------------------------------------------
# the hack gate needs real spam, not Argentine prose
# ---------------------------------------------------------------------------


class Ext24FalsePositivesTest(unittest.TestCase):
    def ext24(self, body: str, **obs_kw):
        return ev(content.evaluate_ext24, make_obs(html_page(body=body), **obs_kw))

    def test_legitimate_pages_never_fire_the_gate(self) -> None:
        cases = {
            "casino prose": "<p>Visitamos el Casino de Mar del Plata con cuarto año.</p>",
            "casino address": "<p>Estamos a dos cuadras del Casino Central.</p>",
            "prevention talk": '<ul><li><a href="/novedades/charla-apuestas-online/">Charla para familias: cómo prevenir las apuestas online en adolescentes</a></li></ul>',
            "gtranslate": '<div class="gtranslate_wrapper"><a href="#" data-gt-lang="ru" class="glink nturl"><span>Русский</span></a></div>',
            "language path": f'<ul><li><a href="{BASE}/ru/">Русский</a></li><li><a href="{BASE}/uk/">Українська</a></li></ul>',
            "japanese class": '<p lang="ja">日本語の授業と文化の交流を大切にしています。私たちの学校は日本語教育を行っています。</p>',
        }
        for name, body in cases.items():
            f = self.ext24(body)
            self.assertNotEqual(f.state, State.FALLA, name)
            self.assertFalse(f.hack_signal, name)

    def test_real_spam_still_fires(self) -> None:
        self.assertEqual(self.ext24("<p>Compre viagra y cialis sin receta.</p>").state, State.FALLA)
        outbound = '<div><a href="https://casino-ya.example/">casino online</a> <a href="https://poker-gratis.example/">poker gratis</a></div>'
        f = self.ext24(outbound)
        self.assertEqual(f.state, State.FALLA)
        self.assertTrue(f.hack_signal)
        locs = [f"{BASE}/激安通販-1/", f"{BASE}/ブランド財布/", f"{BASE}/格安時計店/", f"{BASE}/institucional/"]
        sm = SitemapFetch(url=f"{BASE}/sitemap.xml", declared=True, valid=True, doc=SitemapDoc(DocKind.URLSET, locs))
        self.assertEqual(self.ext24("<p>Hola</p>", sitemaps=[sm]).state, State.FALLA)


# ---------------------------------------------------------------------------
# the name in the title, by meaningful words
# ---------------------------------------------------------------------------


class TitleNameTest(unittest.TestCase):
    def vis04(self, title: str, name: str, kind: str = "colegio"):
        return ev(seo.evaluate_vis04, make_obs(html_page(head=DESCRIPTION, title=title)), institution=name, kind=kind)

    def test_name_present_in_another_form(self) -> None:
        for title, name in (
            ("Colegio Nacional Ejemplo | Educación inicial y primaria", "Colegio Ejemplo"),
            ("Ejemplo School | Educación bilingüe en Buenos Aires desde 1960", "Colegio Ejemplo"),
            ("Instituto Ejemplo Oeste | Educación inicial, primaria y secundaria", "Colegio Ejemplo Oeste"),
            ("Escuela N° 5 Ejemplo Arroyo | Educación primaria en Buenos Aires", "Escuela Nº 5 Ejemplo Arroyo"),
        ):
            f = self.vis04(title, name)
            self.assertNotEqual(f.state, State.FALLA, title)

    def test_partial_name_is_an_observation(self) -> None:
        f = self.vis04("Colegio Arroyo | Educación primaria en Buenos Aires para todas", "Colegio Ejemplo Sur de Arroyo")
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)

    def test_name_really_missing_still_fails(self) -> None:
        f = self.vis04("Educación inicial y primaria en Buenos Aires | Bienvenidos", "Colegio Ejemplo")
        self.assertEqual(f.state, State.FALLA)


# ---------------------------------------------------------------------------
# field data and a single requested run
# ---------------------------------------------------------------------------


class SpeedFieldDataTest(unittest.TestCase):
    def test_crux_field_data_counts_even_when_every_lab_run_failed(self) -> None:
        run = PsiRun(strategy="MOBILE", n=1, ok=False, error="runtime-error:FAILED_DOCUMENT_REQUEST", runtime_error="FAILED_DOCUMENT_REQUEST", artifact="psi-mobile-1.json")
        psi = PsiSeries(status="no-valid-runs", reason="la herramienta de Google no pudo medir la página", key_present=True, mobile=[run])
        crux = FieldMetrics(scope="pagina", source="crux", lcp_ms=5200, inp_ms=150, cls=0.05)
        f = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi, crux_field=crux))
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.measured["lcp_ms"], 5200)
        self.assertEqual(
            f.phrase_report.found,
            "En celular, lo principal de la página tarda 5,2 segundos en aparecer; Google considera bien hasta 2,5 segundos.",
        )

    def test_field_data_inside_a_runtime_error_answer(self) -> None:
        apis = default_apis()
        final = "https://www.colegio.test/"
        apis.psi_mobile = [psi_payload(final, runtime_error="FAILED_DOCUMENT_REQUEST", field_lcp_ms=5200)] * 3
        r = run_e2e(school_scenario(), apis)
        ext08 = r.check("EXT-08")
        self.assertEqual(ext08["estado"], "FALLA")
        self.assertEqual(ext08["mediciones"]["lcp_ms"], 5200)

    def test_one_requested_run_is_enough(self) -> None:
        psi = psi_series(labs=(2000.0,))
        f = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi))
        self.assertNotEqual(f.state, State.NO_VERIFICADO)


# ---------------------------------------------------------------------------
# a FALLA never shows the same figure as its threshold
# ---------------------------------------------------------------------------


class ThresholdFiguresTest(unittest.TestCase):
    def test_seconds(self) -> None:
        # two decimals in the window, never three ("2,501" became "2,51").
        self.assertEqual(common.seconds_vs_threshold(2501, 2500), "2,51")
        self.assertEqual(common.seconds_vs_threshold(2500.4, 2500), "2,51")
        self.assertEqual(common.seconds_vs_threshold(801, 800), "0,81")
        self.assertEqual(common.seconds_vs_threshold(2540, 2500), "2,54")
        self.assertEqual(common.seconds_vs_threshold(4830, 2500), "4,8")
        self.assertEqual(common.seconds_vs_threshold(2500, 2500), "2,5")

    def test_inp(self) -> None:
        f = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(field=field(lcp=2000, inp=201, cls=0.05))))
        self.assertEqual(f.state, State.FALLA)
        self.assertIn("0,21 segundos", f.phrase_report.found)  # one rule for every time
        table = tables.build_velocity_table({"EXT-08": f})
        self.assertIn("0,21", table.rows[1].value)

    def _ext21(self, total: int):
        audits = {"total_byte_weight": AuditResult("total-byte-weight", None, "numeric", float(total), None)}
        return ev(speed.evaluate_ext21, make_obs(html_page(), psi=psi_series(audits=audits)))

    def test_page_weight(self) -> None:
        f = self._ext21(1_700_000)
        self.assertEqual(f.state, State.FALLA)
        self.assertIn("1,62 MB", f.phrase_report.found)
        g = self._ext21(2_000_000)
        self.assertEqual(g.phrase_report.found, "La página principal pesa 1,9 MB; Google aconseja no pasar de 1,6 MB")
        self.assertEqual(g.state, State.FALLA)


# ---------------------------------------------------------------------------
# WhatsApp buttons built by JavaScript or shortened links
# ---------------------------------------------------------------------------


class WhatsappDetectionTest(unittest.TestCase):
    def vis15(self, body: str):
        return ev(contact.evaluate_vis15, make_obs(html_page(body=body)))

    def test_getbutton_snippet_is_never_a_failure(self) -> None:
        snippet = (
            '<script>(function () { var options = { whatsapp: "+5491123456789", call_to_action: "Escribinos" };'
            ' var proto = document.location.protocol, host = "getbutton.io", url = proto + "//static." + host;'
            ' var s = document.createElement("script"); s.src = url + "/widget-send-button/js/init.js"; })();</script>'
        )
        f = self.vis15(snippet)
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        g = self.vis15('<script src="https://static.elfsight.com/platform/platform.js" async></script><div class="elfsight-app-123"></div>')
        self.assertEqual(g.state, State.APROBADO_CON_OBSERVACION)

    def test_wa_link_is_a_whatsapp_button(self) -> None:
        f = self.vis15('<a class="boton-flotante" href="https://wa.link/abc123">WhatsApp</a>')
        self.assertNotEqual(f.state, State.FALLA)


# ---------------------------------------------------------------------------
# the kind of institution
# ---------------------------------------------------------------------------


class KindTest(unittest.TestCase):
    def test_closed_set_of_kinds(self) -> None:
        # parse_args only: a run_cli with a real (non .test) URL would start a production run.
        import contextlib
        import io

        from sitecheck.cli import parse_args

        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            parse_args(["https://www.colegio-ejemplo.edu.ar/", "--kind", "ferreteria"])
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(parse_args(["https://www.colegio-ejemplo.edu.ar/", "--kind", "Empresa"]).kind, "empresa")
        self.assertEqual(parse_args(["https://www.colegio-ejemplo.edu.ar/", "--kind", "jardin"]).kind, "jardín")

    def test_e2e_company_report_has_no_school_words(self) -> None:
        options = SchoolOptions(name="Ferretería Ejemplo", title="Ferretería Ejemplo | Herramientas y materiales en Buenos Aires")
        r = run_e2e(school_scenario(options), default_apis(), nombre="Ferretería Ejemplo", extra=("--kind", "empresa"))
        for name in ("informe.md", "anexo-tecnico.md"):
            text = r.files.get(name, "")
            for bad in ("del empresa", "el empresa", "El empresa", "familias", "Familias", "inscripciones"):
                self.assertNotIn(bad, text, f"{name}: {bad}")
            self.assertIsNone(re.search(r"\bcolegio\b(?!\.test)", text, re.IGNORECASE), name)
        self.assertEqual(r.check("VIS-17")["estado"], "NO_APLICA")

    def test_vis17_only_for_schools(self) -> None:
        f = ev(content.evaluate_vis17, make_obs(html_page()), kind="empresa")
        self.assertEqual(f.state, State.NO_APLICA)


# ---------------------------------------------------------------------------
# WordPress 4.x
# ---------------------------------------------------------------------------


class OldWordpressTest(unittest.TestCase):
    def test_version_from_wp_includes(self) -> None:
        body = f'<script src="{BASE}/wp-includes/js/wp-emoji-release.min.js?ver=4.9.26"></script>'
        f = ev(security.evaluate_ext02, make_obs(html_page(body=body)))
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.measured["version"], "4.9.26")
        self.assertEqual(f.measured["age_years"], 8)
        g = ev(security.evaluate_ext02, make_obs(html_page(body=body), wp_status=WpVersionStatus("4.9.26", "outdated", "7.1.3", True)))
        # report names the 2017 branch of the 4.x version.
        self.assertEqual(
            g.phrase_report.found,
            "El sitio funciona con WordPress 4.9.26, de la rama de noviembre de 2017, y la versión se ve desde afuera",
        )

    def test_version_from_generator(self) -> None:
        f = ev(security.evaluate_ext02, make_obs(html_page(head='<meta name="generator" content="WordPress 4.9.26">'), wp_status=WpVersionStatus("4.9.26", "insecure", "7.1.3", True)))
        self.assertEqual((f.state, f.measured["version"], f.measured["version_source"]), (State.FALLA, "4.9.26", "generator"))
        self.assertEqual(f.phrase_report.consequence, "Alguien puede buscar fallas conocidas de esa versión y entrar")


# ---------------------------------------------------------------------------
# mail authentication and domain expiry texts
# ---------------------------------------------------------------------------


class MailAuthTextsTest(unittest.TestCase):
    def evaluate(self, site):
        return ev(mailauth.evaluate_ext05, make_obs(html_page(), dns=DnsBundle(site=site, control=CONTROL, control_ok=True)))

    def test_spf_redirect_is_defined_by_the_provider(self) -> None:
        site = mail_dns("colegio.test", txt=["v=spf1 redirect=_spf.proveedor.test"], dmarc=["v=DMARC1; p=quarantine; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)
        f = self.evaluate(site)
        self.assertEqual(f.state, State.APROBADO)
        table = tables.build_mail_auth_table(f)
        self.assertIn("definida por el proveedor", table.rows[0].value)

    def test_reject_without_rua_is_report_only(self) -> None:
        site = mail_dns("colegio.test", txt=["v=spf1 include:_spf.google.com ~all"], dmarc=["v=DMARC1; p=reject"], mx=GOOGLE_MX, dkim=DKIM_OK)
        f = self.evaluate(site)
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)

    def test_no_spf_with_reject_does_not_say_fakes_arrive(self) -> None:
        site = mail_dns("colegio.test", txt=[], dmarc=["v=DMARC1; p=reject; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)
        f = self.evaluate(site)
        self.assertEqual(f.state, State.FALLA)
        self.assertNotIn("y llegar", f.phrase_report.consequence)
        table = tables.build_mail_auth_table(f)
        self.assertNotIn("Cualquiera puede enviar", table.rows[0].meaning)

    def test_ar_reason_only_when_there_is_no_automatic_lookup(self) -> None:
        for err in ("timeout", "http-429", "http-503"):
            obs = make_obs(html_page(), rdap=RdapResult("colegio-ejemplo.com.ar", "com.ar", server="rdap.nic.ar", error=err), registrable="colegio-ejemplo.com.ar")
            f = ev(security.evaluate_ext13, obs)
            self.assertEqual(f.reason, "el registro del dominio no respondió", err)
        obs = make_obs(html_page(), rdap=RdapResult("colegio-ejemplo.edu.ar", "edu.ar", server="rdap.nic.ar", error="http-404"), registrable="colegio-ejemplo.edu.ar")
        self.assertIn("edu.ar", ev(security.evaluate_ext13, obs).reason)


# ---------------------------------------------------------------------------
# Content texts
# ---------------------------------------------------------------------------


class ContentTextsTest(unittest.TestCase):
    def test_inscribirse_is_an_access(self) -> None:
        f = ev(content.evaluate_vis17, make_obs(html_page(body='<a href="/como-inscribirse/">¿Cómo inscribirse?</a>')))
        self.assertEqual(f.state, State.APROBADO)

    def test_legales_is_an_observation(self) -> None:
        body = '<footer><a href="/legales/">Legales</a> · <a href="/terminos-y-condiciones/">Términos y condiciones</a></footer>'
        f = ev(security.evaluate_ext25, make_obs(html_page(body=body)))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)

    def test_wording_and_the_law(self) -> None:
        search = ev(security.evaluate_ext25, make_obs(html_page(body='<form role="search"><input type="search" name="s"><button>Buscar</button></form>')))
        self.assertEqual(search.state, State.FALLA)
        self.assertEqual(search.phrase_report.found, "La página principal no enlaza una política de privacidad")
        self.assertNotIn("ley", search.phrase_report.consequence)
        form = '<form action="/enviar/"><label>Nombre <input name="nombre"></label><label>Correo <input type="email" name="email"></label></form>'
        contact_form = ev(security.evaluate_ext25, make_obs(html_page(body=form)))
        self.assertIn("la ley pide informarlo", contact_form.phrase_report.consequence)

    def test_historical_cycle_and_js_footer_year(self) -> None:
        body = "<p>Desde el ciclo lectivo 2015 sumamos el nivel secundario.</p><footer>&copy; 2026 Colegio Ejemplo</footer>"
        f = ev(content.evaluate_vis16, make_obs(html_page(body=body)))
        self.assertIsNone(f.measured["anio_ciclo"])
        body2 = "<footer>&copy; 2019 - <script>document.write(new Date().getFullYear())</script> Colegio Ejemplo</footer>"
        g = ev(content.evaluate_vis16, make_obs(html_page(body=body2)))
        self.assertIsNone(g.measured["anio_pie"])

    def test_real_phone_is_not_a_demo_phone(self) -> None:
        f = ev(content.evaluate_vis19, make_obs(html_page(body="<footer><p>Administración: 0555-0123</p></footer>")))
        self.assertNotIn("demo-phone", f.measured["signals"])
        g = ev(content.evaluate_vis19, make_obs(html_page(body="<footer><p>Tel: 555-0123</p></footer>")))
        self.assertIn("demo-phone", g.measured["signals"])


    def test_generic_title_consequence(self) -> None:
        f = ev(seo.evaluate_vis14, make_obs(html_page(title="Inicio \u2013 Colegio Ejemplo")))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertNotIn("otra región", f.phrase_report.consequence)

    def test_greens_claim_only_what_was_measured(self) -> None:
        headers = [("Content-Type", "text/html; charset=UTF-8"), ("Strict-Transport-Security", "max-age=31536000"), ("X-Content-Type-Options", "nosniff")]
        f = ev(security.evaluate_ext01, make_obs(html_page(), home_headers=headers))
        # HSTS and nosniff alone are no longer a green line ("2 de 6").
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        six = headers + [
            ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'"),
            ("Referrer-Policy", "strict-origin-when-cross-origin"),
            ("Permissions-Policy", "camera=()"),
        ]
        f = ev(security.evaluate_ext01, make_obs(html_page(), home_headers=six))
        self.assertEqual(f.state, State.APROBADO)
        self.assertNotIn("No hay riesgo", f.phrase_report.consequence)
        self.assertNotIn("imposible", f.phrase_report.consequence)
        exp = (dt.datetime(2026, 12, 9, 15, 0, tzinfo=dt.timezone.utc)).isoformat()
        obs = make_obs(html_page(), rdap=RdapResult("colegio.test", "test", server="rdap.test", expiration=exp, days_left=61))
        g = ev(security.evaluate_ext13, obs)
        self.assertEqual(g.state, State.APROBADO)
        self.assertNotIn("No hay riesgo", g.phrase_report.consequence)

    def test_field_data_intro(self) -> None:
        f = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(field=field(lcp=3200, inp=150, cls=0.05), labs=(4830.0, 5120.0, 4600.0))))
        table = tables.build_velocity_table({"EXT-08": f})
        self.assertNotIn("tres veces, con el valor del medio", table.intro)
        self.assertIn("28 días", table.intro)


# ---------------------------------------------------------------------------
# site text never carries links or tags into client text
# ---------------------------------------------------------------------------


class SiteTextInjectionTest(unittest.TestCase):
    def test_sanitize(self) -> None:
        t = fmt.sanitize_site_text("Inicio [Ver la promo](https://phish.example/x) <img src=https://track.example/p.gif>", 200)
        for bad in ("](", "[Ver", "<", ">", "https://", "phish.example/x", "track.example"):
            self.assertNotIn(bad, t)
        self.assertIn("[enlace]", t)
        self.assertTrue(t.startswith("Inicio"))
        self.assertEqual(fmt.sanitize_site_text("A &lt;b&gt; B", 50).count("<"), 0)

    def test_textlint_rejects_markdown_links_and_tags(self) -> None:
        from sitecheck.textlint import lint_text

        rules = {i.rule for i in lint_text("- Título «[promo](https://phish.example/x)» y <img src=x>", name="informe.md")}
        self.assertIn("enlace-o-etiqueta", rules)
        self.assertEqual(lint_text("<details><summary>● 3 cosas bien</summary>\n</details>", name="informe.md"), [])

    def test_textlint_rejects_replacement_characters(self) -> None:
        from sitecheck.textlint import lint_text

        issues = lint_text("- En Google aparece «Colegio Ejemplo Peque\ufffdo».", name="informe.md")
        self.assertEqual([i.rule for i in issues], ["caracter-roto"])


# ---------------------------------------------------------------------------
# the report as a whole
# ---------------------------------------------------------------------------


class ReportConsistencyTest(unittest.TestCase):
    def test_exit3_keeps_what_does_not_depend_on_the_site(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/"].status = 403
        sc.routes[f"{BASE}/"].body = b"<html><body>Forbidden</body></html>"
        sc.routes[f"{BASE}/"].gzip = False
        r = run_e2e(sc, default_apis())
        self.assertEqual(r.code, 3)
        self.assertEqual(r.check("EXT-08")["estado"], "FALLA")
        self.assertEqual(r.check("EXT-05")["estado"], "FALLA")
        self.assertNotIn("La medición de velocidad de Google no se pudo completar", r.files["informe.md"])
        self.assertNotIn("● 0 bien", r.files["informe.md"].replace("**", ""))

    def test_internal_notes_stay_out_of_the_report(self) -> None:
        r = run_e2e(school_scenario(), default_apis(), nombre=None)
        self.assertNotIn("no se indicó el nombre", r.files["informe.md"])
        self.assertIsNotNone(r.check("VIS-04").get("nota_interna"))

    def test_annex_is_a_separate_file(self) -> None:
        r = run_e2e(school_scenario(), default_apis())
        self.assertNotIn("## Anexo técnico", r.files["informe.md"])
        self.assertIn("## Anexo técnico", r.files["anexo-tecnico.md"])


if __name__ == "__main__":
    unittest.main()
