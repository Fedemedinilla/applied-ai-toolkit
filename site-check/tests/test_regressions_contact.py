"""Regression tests of contact and speed wording: the EXT-08 field sentence by
scope, mailto: copies (cc and bcc never feed VIS-21), what counts as a contact
page, a failing answer for the site's own mail domain, and the legacy mobile
meta tags that count as a viewport.
"""

from __future__ import annotations

import datetime as dt
import types
import unittest

import support  # noqa: F401

from sitecheck import collect, links
from sitecheck.checks import a11y, contact, speed
from sitecheck.doh import DnsBundle, DnsStatus
from sitecheck.model import State
from sitecheck.observations import MailDomainSurvey
from sitecheck.scope import Purpose
from obsfactory import BASE, HOME, field, html_page, make_obs, page, psi_series
from test_checks_security import CONTROL
from test_checks_contact_paths import SITE_DNS, _FakeArtifacts, _FakeDoh, ans, check, ev, phone_psi

NX, NODATA, OK = DnsStatus.NXDOMAIN, DnsStatus.NODATA, DnsStatus.NOERROR
# ---------------------------------------------------------------------------
# the EXT-08 field sentence
# ---------------------------------------------------------------------------

class Ext08FieldSentenceTest(unittest.TestCase):
    """The EXT-08 field sentence by scope: each case is a FALLA with its report sentence."""

    def ext08(self, lcp: int, scope: str = "pagina"):  # type: ignore[no-untyped-def]
        return ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(field=field(lcp=lcp, inp=150, cls=0.05, scope=scope))))

    def test_page_scope(self) -> None:
        f = self.ext08(7340)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(
            f.phrase_report.found,
            "En celular, lo principal de la página tarda 7,3 segundos en aparecer; Google considera bien hasta 2,5 segundos.",
        )

    def test_origin_scope(self) -> None:
        f = self.ext08(3010, scope="origen")
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(
            f.phrase_report.found,
            "En celular, lo principal de la página tarda 3,0 segundos en aparecer; Google considera bien hasta 2,5 segundos.",
        )
        self.assertEqual(f.measured["scope"], "origen")

    def test_the_method_sentence_is_gone(self) -> None:
        self.assertFalse(hasattr(speed, "MAIL_EXT08_FIELD"))
        self.assertFalse(hasattr(speed, "MAIL_EXT08_LAB"))
        lab = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(labs=(4830.0, 5120.0, 4600.0))))
        self.assertEqual(lab.state, State.FALLA)


# ---------------------------------------------------------------------------
# VIS-21
# ---------------------------------------------------------------------------


def vis21(survey: MailDomainSurvey, *, interna: bool = False, kind: str = "colegio"):  # type: ignore[no-untyped-def]
    obs = make_obs(
        html_page(),
        interna_html=html_page() if interna else None,
        dns=DnsBundle(site=SITE_DNS, control=CONTROL, control_ok=True),
        mail_domains=survey,
    )
    return ev(contact.evaluate_vis21, obs, kind=kind)


OLD = "colegio-viejo.test"


class MailtoCopiesTest(unittest.TestCase):
    """Only the recipients of a mailto: (its address part and ?to=) feed VIS-21, never ?cc= or ?bcc=."""

    def test_the_domains(self) -> None:
        self.assertEqual(links.mailto_domains("mailto:?to=info@a.test&cc=x@b.test&bcc=y@c.test"), ["a.test"])
        self.assertEqual(links.mailto_domains("mailto:info@a.test?CC=x@b.test&BCC=y@c.test"), ["a.test"])
        self.assertEqual(links.mailto_domains("mailto:?cc=x@b.test"), [])
        self.assertEqual(links.mailto_domains("mailto:?bcc=x@b.test&subject=Hola"), [])
        # Controls: an address that is also a recipient counts once; "?To=" is "?to=".
        self.assertEqual(links.mailto_domains("mailto:info@a.test?bcc=info@a.test"), ["a.test"])
        self.assertEqual(links.mailto_domains("mailto:info@a.test?To=secretaria@d.test"), ["a.test", "d.test"])

    def test_a_role_address_in_copy_is_never_kept(self) -> None:
        self.assertEqual(links.mailto_addresses("mailto:info@a.test?cc=admisiones@b.test"), [("a.test", "info")])
        ls = links.discover_links('<a href="mailto:jperez@colegio.test?cc=admisiones@viejo.test">Escribir</a>', HOME)
        self.assertEqual((ls.mail_domains, ls.role_locals), (["colegio.test"], {}))


def collect_mail(home_body: str, interna_body: str | None = None, interna_url: str | None = None):  # type: ignore[no-untyped-def]
    """collect.check_mail_domains on hand-made pages (the site's own MX comes from SITE_DNS)."""
    obs = make_obs(html_page(body=home_body), dns=DnsBundle(site=SITE_DNS, control=CONTROL, control_ok=True))
    obs.home.links = links.discover_links(obs.home.response.body.decode("utf-8"), HOME)
    if interna_body is not None and interna_url is not None:
        obs.interna = page("interna", interna_url, html_page(body=interna_body), purpose=Purpose.INTERNA)
        obs.interna.links = links.discover_links(obs.interna.response.body.decode("utf-8"), interna_url)
    services = types.SimpleNamespace(doh=_FakeDoh({}), artifacts=_FakeArtifacts())
    collect.check_mail_domains(services, obs)
    return obs, services


class MailtoCopiesCollectorTest(unittest.TestCase):
    def test_a_copy_to_a_dead_domain_is_never_asked(self) -> None:
        obs, services = collect_mail('<a href="mailto:info@colegio.test?cc=secretaria@colegio-viejo.test">Escribir</a>')
        self.assertEqual([c.domain for c in obs.mail_domains.checked], ["colegio.test"])
        self.assertEqual(services.doh.asked, [], "the site's own MX is reused and the copy is never asked")
        f = ev(contact.evaluate_vis21, obs)
        self.assertEqual(f.state, State.APROBADO)

    def test_control_the_same_dead_domain_as_the_recipient(self) -> None:
        obs, services = collect_mail('<a href="mailto:secretaria@colegio-viejo.test?cc=info@colegio.test">Escribir</a>')
        self.assertEqual([c.domain for c in obs.mail_domains.checked], ["colegio-viejo.test"])
        self.assertEqual(services.doh.asked, [("colegio-viejo.test", "MX")])


class ContactPageNameTest(unittest.TestCase):
    """The VIS-21 sentence says "la página de contacto" only when a text of the link or the last path segment
    starts with "contact" (folded and trimmed)."""

    HTML = (
        '<a href="/contacto/">Contacto</a><a href="/escribanos/">  Contáctenos </a><a href="/es/contacto.html">Escribanos</a>'
        '<a href="/b/" aria-label="Contacto"><img src="/i.png" alt=""></a><a href="/contact-us/">Write to us</a>'
        '<a href="/cont%C3%A1ctenos/">Escribir</a><a href="/campamento/">Campamento: contacto con la naturaleza</a>'
        '<a href="/formulario/">Formulario de contacto</a><a href="/escribinos/">Escribinos</a>'
        '<a href="/admisiones/">Admisiones y contacto</a>'
    )

    def test_contact_pages(self) -> None:
        ls = links.discover_links(self.HTML, HOME)
        for path in ("/contacto/", "/escribanos/", "/es/contacto.html", "/b/", "/contact-us/", "/cont%C3%A1ctenos/"):
            self.assertTrue(links.names_contact_page(f"{BASE}{path}", ls), path)
            self.assertEqual(links.interna_kind(f"{BASE}{path}", ls), "contacto", path)

    def test_controls_the_word_inside_is_not_enough(self) -> None:
        ls = links.discover_links(self.HTML, HOME)
        for path in ("/campamento/", "/formulario/", "/escribinos/", "/admisiones/"):
            self.assertFalse(links.names_contact_page(f"{BASE}{path}", ls), path)
        self.assertIsNone(links.interna_kind(f"{BASE}/campamento/", ls))
        self.assertIsNone(links.interna_kind(f"{BASE}/formulario/", ls))
        self.assertEqual(links.interna_kind(f"{BASE}/admisiones/", ls), "admisiones")

    def test_a_one_page_site(self) -> None:
        # "Contacto" is a section of the home (/#contacto); the only other page mentions "contacto" in passing.
        home = '<a href="/#contacto">Contacto</a><a href="/campamento/">Campamento: contacto con la naturaleza</a>'
        interna = links.select_interna(links.discover_links(html_page(body=home), HOME), "colegio.test", None)
        self.assertEqual(interna, f"{BASE}/campamento/")
        obs, _ = collect_mail(home, '<a href="mailto:info@viejo.test">Info</a>', interna)
        self.assertEqual((obs.mail_domains.interna_read, obs.mail_domains.interna_kind), (True, None))

    def test_control_a_real_contact_page(self) -> None:
        home = '<a href="/#inicio">Inicio</a><a href="/contacto/">Contacto</a>'
        interna = links.select_interna(links.discover_links(html_page(body=home), HOME), "colegio.test", None)
        self.assertEqual(interna, f"{BASE}/contacto/")
        obs, _ = collect_mail(home, '<a href="mailto:info@viejo.test">Info</a>', interna)
        self.assertEqual(obs.mail_domains.interna_kind, "contacto")


OWN_REASON = "el DNS dio una respuesta sobre el correo del propio dominio del sitio que no se pudo confirmar; se revisa a mano"


class OwnDomainTest(unittest.TestCase):
    """The home loaded, so a failing verdict for the site's own domain is no data."""

    def test_the_site_names(self) -> None:
        self.assertEqual(contact.site_domains(make_obs(html_page())), frozenset({"colegio.test", "www.colegio.test"}))

    def test_the_registrable_domain_that_does_not_exist(self) -> None:
        f = vis21(MailDomainSurvey(checked=[check("colegio.test", ans("colegio.test", "MX", NX), role="info", role_page="inicio")]))
        self.assertEqual(
            f.internal_note,
            "La dirección que falla es del propio dominio del sitio (@colegio.test) y la página de inicio cargó. "
            "Consultar el registro MX de colegio.test en una herramienta de DNS antes de decir nada.",
        )
        self.assertEqual(
            f.measured["dominios"],
            [{"dominio": "colegio.test", "paginas": ["inicio"], "veredicto": "sin-dato", "veredicto_dns": "no-existe",
              "direccion": "info@colegio.test"}],
        )
        self.assertNotIn("dominio_mail", f.measured)

    def test_the_site_host_with_a_null_mx(self) -> None:
        f = vis21(MailDomainSurvey(checked=[check("www.colegio.test", ans("www.colegio.test", "MX", OK, ["0 "]))]))
        self.assertEqual((f.state, f.reason), (State.NO_VERIFICADO, OWN_REASON))
        self.assertEqual(
            f.internal_note,
            "La dirección que falla es del propio dominio del sitio (@www.colegio.test) y la página de inicio cargó. "
            "Consultar el registro MX de www.colegio.test en una herramienta de DNS antes de decir nada.",
        )
        self.assertEqual(f.measured["dominios"][0]["veredicto_dns"], "mx-nulo")

    def test_controls(self) -> None:
        # Another failing domain still makes the finding, with its own sentence.
        f = vis21(MailDomainSurvey(checked=[check("colegio.test", ans("colegio.test", "MX", NX)), check(OLD, ans(OLD, "MX", NX))]))
        # A subdomain of the site is not the site's own name.
        f = vis21(MailDomainSurvey(checked=[check("mail.colegio.test", ans("mail.colegio.test", "MX", NX))]))
        # The site's own domain that receives mail stays a plain pass.
        f = vis21(MailDomainSurvey(checked=[check("colegio.test", ans("colegio.test", "MX", OK, ["1 aspmx.l.google.com"]))]))
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(f.measured["dominios"], [{"dominio": "colegio.test", "paginas": ["inicio"], "veredicto": "recibe-mx"}])


# ---------------------------------------------------------------------------
# VIS-12
# ---------------------------------------------------------------------------

LEGACY_REASON = (
    "la página de inicio no tiene la etiqueta actual para celulares pero sí una anterior que algunos teléfonos "
    "respetan; se revisa en un celular"
)


class Vis12Test(unittest.TestCase):
    def vis12(self, head: str = "", psi=None):  # type: ignore[no-untyped-def]
        return ev(a11y.evaluate_vis12, make_obs(html_page(head), psi=psi))

    def test_handheld_friendly_counts_as_a_viewport(self) -> None:
        f = self.vis12('<meta name="HandheldFriendly" content="true">')
        self.assertEqual(
            f.internal_note,
            "La página de inicio no tiene la etiqueta viewport pero tiene la etiqueta HandheldFriendly, que Chrome en "
            "Android puede tomar como adaptada al ancho del teléfono. Abrir la página de inicio en un celular antes de "
            "decir nada.",
        )
        self.assertEqual(f.measured["meta_celular_anterior"], "HandheldFriendly")

    def test_mobile_optimized_counts_too_whatever_the_case(self) -> None:
        f = self.vis12('<meta name="mobileoptimized" content="320">')
        self.assertEqual((f.state, f.reason), (State.NO_VERIFICADO, LEGACY_REASON))
        self.assertEqual(
            f.internal_note,
            "La página de inicio no tiene la etiqueta viewport pero tiene la etiqueta MobileOptimized, que Chrome en "
            "Android puede tomar como adaptada al ancho del teléfono. Abrir la página de inicio en un celular antes de "
            "decir nada.",
        )
        # PageSpeed saying "ausente" does not override the tag in the HTML.
        f = self.vis12('<meta name="MobileOptimized" content="width">', psi=phone_psi("absent"))
        self.assertEqual((f.state, f.measured["viewport_celular"]), (State.NO_VERIFICADO, "ausente"))
        self.assertEqual(f.evidence, ["home.html", "psi-mobile-1.json"])

    def test_controls(self) -> None:
        f = self.vis12('<meta name="apple-mobile-web-app-capable" content="yes">')
        self.assertEqual(f.state, State.FALLA)
        self.assertNotIn("meta_celular_anterior", f.measured)
        # With a viewport meta the old tags are never read.
        f = self.vis12('<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="HandheldFriendly" content="true">')
        self.assertEqual((f.state, f.reason), (State.NO_VERIFICADO, "el ajuste a 320 píxeles y el zoom al 200 % requieren una prueba en navegador"))
        self.assertNotIn("meta_celular_anterior", f.measured)


if __name__ == "__main__":
    unittest.main()
