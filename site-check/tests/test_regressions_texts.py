"""Regression tests of report texts: EXT-01 found text and HSTS wording, the intro
on a shared domain, EXT-21 actions, the EXT-05 green, esc.edu.ar as a zone, and
VIS-06 size and duplicates as two problems. No test names a real URL.
"""

from __future__ import annotations

import unittest

import support  # noqa: F401

from sitecheck import render_report
from sitecheck.checks import mailauth, security, speed
from sitecheck.doh import DnsBundle
from sitecheck.model import Colour, Finding, State
from sitecheck.psi import AuditResult
from obsfactory import html_page, make_ctx, make_obs, psi_series
from test_checks_security import CONTROL, DKIM_OK, GOOGLE_MX, mail_dns
from test_checks_speed import field
from test_regressions_report import finding, report_ctx
import test_regressions_wording  # the module, not its TestCase classes: an imported class would run its tests twice
from test_regressions_wording import CSP, HSTS, NOSNIFF, REFERRER, XFO, intro

PERMISSIONS = ("Permissions-Policy", "camera=()")


def ext01(*headers: tuple[str, str]) -> Finding:
    obs = make_obs(html_page(), home_headers=[("Content-Type", "text/html; charset=UTF-8"), *headers])
    return security.evaluate_ext01(obs, make_ctx(obs))


class Ext01FoundTextTest(unittest.TestCase):
    """A FALLA says what is wrong, never only a count (6 de 6 read as fine)."""

    def test_six_of_six_with_short_hsts(self) -> None:
        f = ext01(("Strict-Transport-Security", "max-age=300"), NOSNIFF, REFERRER, XFO, CSP, PERMISSIONS)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(
            f.phrase_report.found,
            "El servidor activa 6 de las 6 protecciones que ofrecen los navegadores; la que obliga a usar la conexión "
            "segura dura menos de seis meses",
        )

    def test_missing_hsts_and_nosniff_are_named(self) -> None:
        f = ext01(XFO)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(
            f.phrase_report.found,
            "El servidor activa 1 de las 6 protecciones que ofrecen los navegadores; falta la que obliga a usar la "
            "conexión segura; falta la que fija el tipo de cada archivo",
        )

    def test_control_observation_keeps_its_text(self) -> None:
        f = ext01(HSTS, NOSNIFF, REFERRER, XFO, CSP)
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertNotIn("falta la que obliga", f.phrase_report.found)


class Ext01HstsWordingTest(unittest.TestCase):
    """Without HSTS the exposure is the first unencrypted hop, not 'opens without the padlock'."""

    def test_missing_hsts(self) -> None:
        f = ext01(NOSNIFF, XFO)
        self.assertEqual(
            f.phrase_report.consequence,
            "Si alguien escribe la dirección sin https, la primera conexión viaja sin candado; es más fácil inyectarle "
            "contenido al sitio; el sitio no indica qué parte de sus direcciones ven los sitios que enlaza",
        )

    def test_short_hsts(self) -> None:
        f = ext01(("Strict-Transport-Security", "max-age=300"), NOSNIFF, REFERRER, XFO, CSP, PERMISSIONS)
        self.assertEqual(f.phrase_report.consequence, "El navegador recuerda por poco tiempo que tiene que usar la conexión segura")

    def test_old_sentence_is_gone(self) -> None:
        for headers in ((NOSNIFF, XFO), (("Strict-Transport-Security", "max-age=300"), NOSNIFF), (XFO,)):
            f = ext01(*headers)
            self.assertNotIn("puede abrir el sitio sin candado", f.phrase_report.consequence.lower())


class SharedDomainIntroTest(unittest.TestCase):
    """With the domain and mail checks NO_APLICA the intro does not claim them."""

    SHARED = (
        "Se revisó lo que cualquier persona puede ver desde afuera: cómo responde el sitio y cómo carga en un celular. "
        "No se entró al panel ni al hosting, así que lo que pasa adentro (usuarios, copias de seguridad, componentes "
        "instalados) no está en este informe."
    )

    def test_shared_domain(self) -> None:
        na = [finding(cid, state=State.NO_APLICA, colour=Colour.GRIS, eligible=False) for cid in ("EXT-05", "EXT-13")]
        text = render_report.render_report(report_ctx([finding("VIS-04"), *na]))
        self.assertEqual(intro(text), self.SHARED)

    def test_control_own_domain_keeps_the_clause(self) -> None:
        own = [finding("EXT-05"), finding("EXT-13", state=State.APROBADO, colour=Colour.VERDE, eligible=False)]
        text = render_report.render_report(report_ctx([finding("VIS-04"), *own]))
        self.assertEqual(intro(text), test_regressions_wording.IntroListsTest.NONE)


class Ext21ActionTest(unittest.TestCase):
    """The action never assumes a slider, which is never measured."""

    def test_no_slider(self) -> None:
        audits = {
            "total_byte_weight": AuditResult("total-byte-weight", 0.5, "numeric", 3_000_000.0, None),
            "resource_summary": AuditResult(
                "resource-summary", None, "informative", None, 2,
                {"items": [{"resourceType": "total", "transferSize": 3_000_000}, {"resourceType": "image", "transferSize": 2_000_000}]},
            ),
        }
        obs = make_obs(html_page(), psi=psi_series(field=field(), audits=audits))
        f = speed.evaluate_ext21(obs, make_ctx(obs))
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.phrase_report.action, "Achicar y convertir las imágenes y revisar lo que se carga de afuera")


class Ext05GreenTest(unittest.TestCase):
    """The green line states what the records allow, never that mail arrives."""

    def test_green_consequence(self) -> None:
        site = mail_dns("colegio.test", txt=["v=spf1 include:_spf.google.com ~all"], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)
        obs = make_obs(html_page(), dns=DnsBundle(site=site, control=CONTROL, control_ok=True))
        f = mailauth.evaluate_ext05(obs, make_ctx(obs))
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(
            f.phrase_report.consequence,
            "Es más difícil mandar mails falsos con el nombre del colegio, y los servidores de correo tienen con qué "
            "reconocer los verdaderos",
        )
        self.assertNotIn("llegan", f.phrase_report.consequence)


class SchoolZoneTest(unittest.TestCase):
    """A school under esc.edu.ar owns its name: esc.edu.ar is a zone, not an owner."""

    def test_esc_edu_ar_is_a_zone_not_an_owner(self) -> None:
        from sitecheck import domains

        self.assertEqual(domains.site_domain("www.ejemplo.esc.edu.ar"), "ejemplo.esc.edu.ar")
        self.assertIsNone(domains.shared_parent("www.ejemplo.esc.edu.ar"))

    def test_control_university_subdomain_is_still_shared(self) -> None:
        from sitecheck import domains

        self.assertEqual(domains.shared_parent("www.colegio.universidad-ejemplo.edu.ar"), "universidad-ejemplo.edu.ar")


class Vis06SentenceTest(unittest.TestCase):
    """The size clause must not swallow the next clause."""

    def test_size_and_duplicates_read_as_two_problems(self) -> None:
        from sitecheck.checks import seo
        from obsfactory import BASE, og_fetch
        from test_checks_visibility import OG_FULL

        second = f'<meta property="og:image" content="{BASE}/wp-content/uploads/logo.png">'
        obs = make_obs(html_page(OG_FULL + second), og_image=og_fetch(width=2275, height=918))
        f = seo.evaluate_vis06(obs, make_ctx(obs))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(
            f.phrase_report.found,
            "La vista previa al compartir el sitio usa una imagen de 2275 por 918 píxeles (lo recomendado es 1200 "
            "por 630) y tiene dos versiones que se contradicen",
        )


if __name__ == "__main__":
    unittest.main()
