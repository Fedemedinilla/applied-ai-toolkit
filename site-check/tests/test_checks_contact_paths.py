"""Contact paths and signs of an old site, unit and end to end.

* VIS-20: code written for Internet Explorer or Flash in the home; Flash played
  by Ruffle is no marker.
* VIS-12: no viewport meta, and the PageSpeed phone run decides first (a
  viewport it sees is grey).
* VIS-21: a published mail address whose domain cannot receive mail (DoH): the
  full address only for an institutional role address, the verdict per
  domain, free mail services never queried, the site's own domain never
  trusted on a failing answer.
* VIS-18 on the interna (the contact page when the home links one).
* EXT-05: the report wording of each failing case.
* Scenarios end to end on fictional sites under ``.test``.
"""

from __future__ import annotations

import datetime as dt
import email.utils
import json
import types
import unittest

import support  # noqa: F401

from sitecheck import collect, colours, domains, kinds, links, outputs
from sitecheck.checks import a11y, contact, legacy, mailauth
from sitecheck.doh import DnsAnswer, DnsBundle, DnsStatus
from sitecheck.model import Colour, ColourException, State
from sitecheck.observations import MailDomainCheck, MailDomainSurvey
from sitecheck.psi import find_audit
from sitecheck.scope import Purpose
from fakeapis import META_VIEWPORT_AUDITS, FakeApisConfig, psi_payload
from fakesite import Route, Scenario
from fixhelp import run_e2e
from obsfactory import BASE, HOME, html_page, make_ctx, make_obs, page, psi_series
from sitefixtures import SchoolOptions, default_apis, school_scenario
from test_checks_security import CONTROL, DKIM_OK, GOOGLE_MX, mail_dns


def ev(fn, obs, **ctx_kw):  # type: ignore[no-untyped-def]
    return fn(obs, make_ctx(obs, **ctx_kw))


class Ext05WordingTest(unittest.TestCase):
    def evaluate(self, site):  # type: ignore[no-untyped-def]
        return ev(mailauth.evaluate_ext05, make_obs(html_page(), dns=DnsBundle(site=site, control=CONTROL, control_ok=True)))

    def test_every_failing_case(self) -> None:
        cases = [
            mail_dns("colegio.test", txt=[], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim={"google": None}),
            mail_dns("colegio.test", txt=["v=spf1 a ~all", "v=spf1 mx -all"], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim={"google": None}),
            mail_dns("colegio.test", txt=[], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK),
            mail_dns("colegio.test", txt=["v=spf1 +all"], dmarc=["v=DMARC1; p=none; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK),
            mail_dns("colegio.test", txt=["v=spf1 ~all"], dmarc=["v=DMARC1; p=none", "v=DMARC1; p=reject"], mx=GOOGLE_MX, dkim=DKIM_OK),
            mail_dns("colegio.test", txt=["v=spf1 ~all"], dmarc=["v=DMARC1; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK),
            mail_dns("colegio.test", txt=["v=spf1 ~all"], dmarc=None, mx=GOOGLE_MX, dkim=DKIM_OK),
        ]
        for site in cases:
            f = self.evaluate(site)
            self.assertEqual(f.state, State.FALLA)
            self.assertEqual(
                f.internal_note, None
            )

    def test_control_the_report_is_unchanged(self) -> None:
        f = self.evaluate(mail_dns("colegio.test", txt=["v=spf1 ~all"], dmarc=None, mx=GOOGLE_MX, dkim=DKIM_OK))
        self.assertEqual(
            f.phrase_report.found,
            "El correo del dominio no tiene la regla que les dice a Gmail y a Outlook qué hacer con los mails falsos",
        )
        self.assertEqual(
            f.phrase_report.consequence,
            "Se pueden enviar mails que parezcan del colegio y llegar, y los mails reales pueden caer más seguido en spam",
        )
        self.assertEqual(f.phrase_report.action, "Configurar los registros que faltan en el dominio")


# ---------------------------------------------------------------------------
# VIS-20, a site built for another era
# ---------------------------------------------------------------------------


class Vis20Test(unittest.TestCase):
    def vis20(self, head: str = "", body: str = ""):  # type: ignore[no-untyped-def]
        return ev(legacy.evaluate_vis20, make_obs(html_page(head, body)))


    def test_lt_ie_9_names_ie_8(self) -> None:
        f = self.vis20('<!--[if lt IE 9]><script src="/js/html5shiv.min.js"></script><![endif]-->')
        self.assertEqual(f.measured["marcadores"], ["comentario-condicional", "html5shiv"])
        self.assertEqual((f.measured["ie_version"], f.measured["buscar"]), (8, "IE 9"))
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye partes escritas para Internet Explorer 8 (comentarios "
            "condicionales para Internet Explorer y html5shiv)",
        )
        self.assertEqual(f.phrase_report.consequence, "Suele ser señal de que el tema o la base del sitio se hizo hace años")
        self.assertEqual(f.phrase_report.action, "Actualizar la base del sitio o rehacerla con una actual")
        self.assertEqual(f.evidence, ["home.html"])

    def test_versions_by_condition(self) -> None:
        f = self.vis20("<!--[if lte IE 8]><link rel=\"stylesheet\" href=\"/a.css\"><![endif]-->")
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye partes escritas para Internet Explorer 8 (comentarios "
            "condicionales para Internet Explorer)",
        )
        f = self.vis20("<!--[if IE 9]><link rel=\"stylesheet\" href=\"/b.css\"><![endif]-->")
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye partes escritas para Internet Explorer 9 (comentarios "
            "condicionales para Internet Explorer)",
        )
        self.assertEqual(self.vis20("<!--[if IE 7]><html class=\"ie7\"><![endif]-->").measured["ie_version"], 7)
        # The HTML5 Boilerplate opener: each condition names the newest version it covers ("lt IE 7" is 6),
        # the oldest of those wins, and its last line targets no IE at all.
        h5bp = (
            '<!--[if lt IE 7]><p class="ie6"></p><![endif]--><!--[if IE 7]><p class="ie7"></p><![endif]-->'
            '<!--[if IE 8]><p class="ie8"></p><![endif]--><!--[if gt IE 8]><!--><p class="no-ie"></p><!--<![endif]-->'
        )
        f = self.vis20(body=h5bp)
        self.assertEqual((f.measured["ie_version"], f.measured["buscar"]), (6, "IE 7"))
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye partes escritas para Internet Explorer 6 (comentarios "
            "condicionales para Internet Explorer)",
        )

    def test_a_bare_ie_condition_names_no_version(self) -> None:
        f = self.vis20('<!--[if IE]><meta http-equiv="X-UA-Compatible" content="IE=edge"><![endif]-->')
        self.assertEqual((f.measured["ie_version"], f.measured["buscar"]), (None, "[if IE"))
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye partes escritas para Internet Explorer (comentarios "
            "condicionales para Internet Explorer)",
        )
        # A version below 6 has no release year in the table: also just "Internet Explorer", and Ctrl+F looks for
        # the words that are in the code.
        old = self.vis20("<!--[if lt IE 6]><p></p><![endif]-->")
        self.assertEqual((old.measured["ie_version"], old.measured["buscar"]), (None, "IE 6"))

    def test_helper_files_without_a_conditional_comment(self) -> None:
        f = self.vis20('<script src="/wp-content/themes/t/js/respond.min.js"></script>')
        self.assertEqual(
            f.phrase_report.found, "El código de la página principal incluye partes escritas para Internet Explorer 8 (respond.js)"
        )
        f = self.vis20('<script src="/js/selectivizr-min.js"></script>')
        self.assertEqual(
            f.phrase_report.found, "El código de la página principal incluye partes escritas para Internet Explorer 8 (selectivizr)"
        )
        f = self.vis20('<link rel="stylesheet" href="/wp-content/themes/t/css/ie8.css">')
        self.assertEqual((f.measured["marcadores"], f.measured["buscar"], f.measured["ie_version"]), (["hoja-ie"], "ie8.css", 8))
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye partes escritas para Internet Explorer 8 (una hoja de estilos "
            "para Internet Explorer)",
        )
        self.assertEqual(self.vis20('<link rel="stylesheet" href="/css/ie9.min.css">').measured["ie_version"], 9)
        self.assertEqual(self.vis20('<link rel="stylesheet" href="/css/ie.css">').measured["ie_version"], None)
        # Inside a conditional comment the helper still counts, and the oldest version wins.
        f = self.vis20('<!--[if IE 9]><script src="/js/html5shiv.js"></script><![endif]-->')
        self.assertEqual(f.measured["ie_version"], 8)

    def test_flash(self) -> None:
        f = self.vis20(body='<embed src="/media/banner.swf" width="600" height="200">')
        self.assertEqual((f.measured["flash"], f.measured["buscar"]), (True, ".swf"))
        self.assertEqual(
            f.phrase_report.found, "El código de la página principal incluye contenido para Flash (un archivo .swf)"
        )
        self.assertEqual(
            f.phrase_report.consequence,
            "Ese contenido no se ve en los navegadores actuales, y suele ser señal de que la base del sitio se hizo hace años",
        )
        obj = '<object type="application/x-shockwave-flash"><param name="movie" value="/media/intro.swf"></object>'
        self.assertEqual(self.vis20(body=obj).measured["marcadores"], ["swf"])
        call = '<script>swfobject.embedSWF("/media/menu.swf", "menu", "600", "80", "9.0.0");</script>'
        self.assertEqual(self.vis20(body=call).measured["marcadores"], ["swf"])
        only_library = self.vis20('<script src="/js/swfobject.js"></script>')
        self.assertEqual((only_library.measured["flash_codigo"], only_library.measured["buscar"]), (True, "swfobject"))
        self.assertEqual(
            only_library.phrase_report.found,
            "El código de la página principal incluye una herramienta para mostrar contenido Flash (swfobject)",
        )

    def test_flash_content_goes_before_ie_and_the_report_names_both(self) -> None:
        f = self.vis20('<!--[if lt IE 9]><script src="/js/html5shiv.js"></script><![endif]-->', '<embed src="/m/a.swf">')
        self.assertEqual(f.measured["buscar"], ".swf")
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye contenido para Flash (un archivo .swf) y partes escritas para "
            "Internet Explorer 8 (comentarios condicionales para Internet Explorer y html5shiv)",
        )

    def test_flash_played_by_ruffle_is_no_marker(self) -> None:
        ruffle = '<script src="https://www.colegio.test/js/ruffle/ruffle.js"></script>'
        f = self.vis20(ruffle, '<embed src="/media/banner.swf" width="600" height="200">')
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(
            (f.measured["marcadores"], f.measured["flash"], f.measured["flash_codigo"], f.measured["flash_con_emulador"]),
            ([], False, False, True),
        )
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal no tiene partes para Internet Explorer; su contenido Flash se muestra "
            "con Ruffle, un emulador que funciona en los navegadores actuales",
        )
        self.assertEqual(f.phrase_report.consequence, "El contenido Flash se sigue viendo gracias al emulador")
        # Ruffle with swfobject alone: no marker either.
        f = self.vis20(ruffle + '<script src="/js/swfobject.js"></script>')
        self.assertEqual((f.state, f.measured["flash_con_emulador"]), (State.APROBADO, True))
        # Ruffle does not hide the code for Internet Explorer: only that part fails.
        f = self.vis20(ruffle + '<!--[if lt IE 9]><script src="/js/html5shiv.js"></script><![endif]-->', '<embed src="/m/a.swf">')
        self.assertEqual(
            (f.measured["marcadores"], f.measured["flash"], f.measured["flash_con_emulador"], f.measured["buscar"]),
            (["comentario-condicional", "html5shiv"], False, True, "IE 9"),
        )
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal incluye partes escritas para Internet Explorer 8 (comentarios "
            "condicionales para Internet Explorer y html5shiv)",
        )

    def test_control_ruffle_only_counts_as_a_script(self) -> None:
        swf = '<embed src="/media/banner.swf">'
        # Without Ruffle, the same Flash fails.
        f = self.vis20(body=swf)
        self.assertEqual((f.state, f.measured["flash"], f.measured["flash_con_emulador"]), (State.FALLA, True, False))
        # A stylesheet or a link named ruffle is not the emulator.
        f = self.vis20('<link rel="stylesheet" href="/css/ruffle.css">', swf + '<a href="/ruffle/">Ruffle</a>')
        self.assertEqual((f.state, f.measured["flash"], f.measured["flash_con_emulador"]), (State.FALLA, True, False))
        # Ruffle without any Flash: the plain pass.
        f = self.vis20('<script src="/js/ruffle/ruffle.js"></script>')
        self.assertEqual((f.state, f.measured["flash_con_emulador"]), (State.APROBADO, False))
        self.assertEqual(
            f.phrase_report.found,
            "El código de la página principal no tiene partes para Internet Explorer ni contenido para Flash",
        )

    def test_controls_that_are_no_marker(self) -> None:
        for head, body in (
            ("", ""),
            ('<meta http-equiv="X-UA-Compatible" content="IE=edge">', ""),
            ("<!--[if !IE]><!--><p>otros navegadores</p><!--<![endif]-->", ""),
            ("<!--[if (gt IE 9)|!(IE)]><!--><p>moderno</p><!--<![endif]-->", ""),
            ("<!--[if IEMobile]><p>celular viejo</p><![endif]-->", ""),
            ("<!--[if mso]><p>Outlook</p><![endif]-->", ""),
            ('<!-- <script src="/js/html5shiv.js"></script> -->', ""),
            ('<script src="/js/respond-to-forms.js"></script>', '<a href="/descargas/manual.swf.pdf">Manual</a>'),
        ):
            f = self.vis20(head, body)
            self.assertEqual((f.state, f.measured['marcadores']), (State.APROBADO, []), (head, body))
        self.assertEqual(
            self.vis20().phrase_report.found,
            "El código de la página principal no tiene partes para Internet Explorer ni contenido para Flash",
        )


    def test_measured_keeps_only_marker_names(self) -> None:
        f = self.vis20('<!--[if lt IE 9]><script src="/js/html5shiv-printshiv.js?nombre=maria"></script><![endif]-->')
        self.assertNotIn("maria", json.dumps(f.measured))
        self.assertEqual(set(f.measured), {"marcadores", "ie", "ie_version", "flash", "flash_codigo", "flash_con_emulador", "buscar"})


# ---------------------------------------------------------------------------
# VIS-12 without a viewport meta
# ---------------------------------------------------------------------------

VIS12_PHONE_REASON = (
    "la prueba de Google en celular encontró la etiqueta para celulares que falta en el código leído como "
    "computadora; se revisa en un celular"
)
VIS12_PHONE_NOTE = (
    "PageSpeed en celular encontró la etiqueta viewport y el HTML pedido como computadora no la tiene: el sitio puede "
    "servir otra página a los teléfonos. Abrir la página de inicio en un celular antes de decir nada."
)


def phone_psi(case: str):  # type: ignore[no-untyped-def]
    """Three valid PageSpeed mobile runs whose "meta-viewport" audit is the fakeapis case, parsed like a real one."""
    return psi_series(audits={"meta_viewport": find_audit({"meta-viewport": META_VIEWPORT_AUDITS[case]}, "meta_viewport")})


class Vis12ViewportTest(unittest.TestCase):
    def vis12(self, head: str = "", psi=None):  # type: ignore[no-untyped-def]
        return ev(a11y.evaluate_vis12, make_obs(html_page(head), psi=psi))

    def test_no_viewport_is_a_failure(self) -> None:
        f = self.vis12()
        self.assertEqual(f.phrase_report.found, "La página principal no se adapta al ancho del celular")
        self.assertEqual(f.phrase_report.consequence, "En el celular se ve chica y hay que agrandarla con los dedos")
        self.assertIsNone(f.measured["viewport_celular"])
        self.assertEqual(f.evidence, ["home.html"])

    def test_the_phone_run_confirms_the_missing_viewport(self) -> None:
        # Lighthouse's axe rule does not apply without a viewport meta: notApplicable.
        f = self.vis12(psi=phone_psi("absent"))
        self.assertEqual(f.measured["viewport_celular"], "ausente")
        self.assertEqual(f.evidence, ["home.html", "psi-mobile-1.json"])
        # The other reading of the audit (a presence check that scores 0 with no viewport node) is "ausente" too.
        presence = {"id": "meta-viewport", "score": 0, "scoreDisplayMode": "binary"}
        psi = psi_series(audits={"meta_viewport": find_audit({"meta-viewport": presence}, "meta_viewport")})
        f = self.vis12(psi=psi)
        self.assertEqual((f.state, f.measured["viewport_celular"]), (State.FALLA, "ausente"))

    def test_a_viewport_seen_by_the_phone_run_is_grey(self) -> None:
        # The HTML was read as a desktop browser: a site that serves phones another page has the viewport there.
        for case in ("pass", "zoom"):
            f = self.vis12(psi=phone_psi(case))
            self.assertEqual(f.state, State.NO_VERIFICADO, case)
            self.assertEqual(f.reason, VIS12_PHONE_REASON, case)
            self.assertEqual(f.internal_note, VIS12_PHONE_NOTE, case)
            self.assertEqual(f.measured["viewport_celular"], "presente", case)
            self.assertEqual(f.evidence, ["home.html", "psi-mobile-1.json"], case)


    def test_control_the_zoom_case_stays_in_the_report(self) -> None:
        f = self.vis12('<meta name="viewport" content="width=device-width, user-scalable=no">')
        self.assertEqual(f.phrase_report.found, "La página principal no deja agrandar la letra con el zoom")
        ok = self.vis12('<meta name="viewport" content="width=device-width, initial-scale=1">', psi=phone_psi("absent"))
        self.assertEqual(ok.state, State.NO_VERIFICADO)
        self.assertNotIn("viewport_celular", ok.measured, "the phone run is read only without a viewport in the HTML")


# ---------------------------------------------------------------------------
# VIS-21, a published address whose domain cannot receive mail
# ---------------------------------------------------------------------------


def ans(name: str, rtype: str, status: DnsStatus, records: list[str] | None = None) -> DnsAnswer:
    return DnsAnswer(name, rtype, status, records=list(records or []), resolver="dns.google")


NX, NODATA, OK, ERR = DnsStatus.NXDOMAIN, DnsStatus.NODATA, DnsStatus.NOERROR, DnsStatus.ERROR
SITE_DNS = mail_dns("colegio.test", txt=["v=spf1 ~all"], dmarc=["v=DMARC1; p=reject; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim=DKIM_OK)


def check(domain: str, mx=None, a=None, aaaa=None, pages=("inicio",), role=None, role_page=None) -> MailDomainCheck:  # type: ignore[no-untyped-def]
    return MailDomainCheck(domain=domain, pages=list(pages), mx=mx, a=a, aaaa=aaaa, role_local=role, role_page=role_page)


class MailDomainVerdictTest(unittest.TestCase):
    def test_the_three_failures(self) -> None:
        d = "x.test"
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", NX))), "no-existe")
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", OK, ["0 "]))), "mx-nulo")
        self.assertEqual(
            contact.mail_domain_verdict(check(d, ans(d, "MX", NODATA), ans(d, "A", NODATA), ans(d, "AAAA", NODATA))),
            "sin-mx-ni-a",
        )

    def test_controls_that_receive_or_say_nothing(self) -> None:
        d = "x.test"
        # RFC 5321 5.1: without MX, mail goes to the A or AAAA address. Never a failure.
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", NODATA), ans(d, "A", OK, ["192.0.2.10"]))), "recibe-a")
        self.assertEqual(
            contact.mail_domain_verdict(check(d, ans(d, "MX", NODATA), ans(d, "A", NODATA), ans(d, "AAAA", OK, ["2001:db8::1"]))),
            "recibe-a",
        )
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", OK, ["10 mx.x.test"]))), "recibe-mx")
        # A null MX next to a real one is no null MX (RFC 7505 asks for it alone).
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", OK, ["0 ", "10 mx.x.test"]))), "recibe-mx")
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", ERR))), "sin-dato")
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", DnsStatus.SERVFAIL))), "sin-dato")
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", NODATA), ans(d, "A", NX))), "sin-dato")
        self.assertEqual(contact.mail_domain_verdict(check(d, ans(d, "MX", NODATA), ans(d, "A", NODATA), ans(d, "AAAA", ERR))), "sin-dato")
        self.assertEqual(contact.mail_domain_verdict(check(d)), "sin-dato")


class Vis21Test(unittest.TestCase):
    def vis21(self, survey: MailDomainSurvey | None, *, control_ok: bool = True, interna: bool = False, kind: str = "colegio"):  # type: ignore[no-untyped-def]
        obs = make_obs(
            html_page(),
            interna_html=html_page() if interna else None,
            dns=DnsBundle(site=SITE_DNS, control=CONTROL, control_ok=control_ok),
            mail_domains=survey,
        )
        return ev(contact.evaluate_vis21, obs, kind=kind)

    def test_a_domain_that_does_not_exist(self) -> None:
        old = "colegio-viejo.test"
        survey = MailDomainSurvey(checked=[
            check("colegio.test", ans("colegio.test", "MX", OK, ["1 aspmx.l.google.com"])),
            check(old, ans(old, "MX", NX)),
        ])
        f = self.vis21(survey)
        self.assertEqual(
            f.phrase_report.found, "Una dirección de correo publicada en el sitio termina en @colegio-viejo.test, y ese dominio no existe"
        )
        self.assertEqual(f.phrase_report.consequence, "Lo que escriben a esa dirección no llega, y quien escribe se queda sin respuesta")
        self.assertEqual(f.evidence, ["dominios-correo.json", "home.html"])
        self.assertEqual(
            f.measured["dominios"],
            [
                {"dominio": "colegio.test", "paginas": ["inicio"], "veredicto": "recibe-mx"},
                {"dominio": "colegio-viejo.test", "paginas": ["inicio"], "veredicto": "no-existe"},
            ],
        )
        self.assertEqual(
            (f.measured["veredicto_mail"], f.measured["pagina_mail"], f.measured["direccion_mail"], f.measured["interna_url"]),
            ("no-existe", "inicio", None, None),
        )
        self.assertEqual(f.trace, {"{dominio}": "checks[VIS-21].measured.dominio_mail"})

    def test_a_role_address_is_named_whole(self) -> None:
        old = "ejemplosur-viejo.test"
        survey = MailDomainSurvey(checked=[check(old, ans(old, "MX", NX), role="admisiones", role_page="inicio")], interna_read=True)
        f = self.vis21(survey, kind="instituto")
        self.assertEqual(f.measured["direccion_mail"], "admisiones@ejemplosur-viejo.test")
        self.assertEqual(
            f.measured["dominios"],
            [{"dominio": old, "paginas": ["inicio"], "veredicto": "no-existe", "direccion": "admisiones@ejemplosur-viejo.test"}],
        )
        self.assertEqual(f.trace, {"{dominio}": "checks[VIS-21].measured.dominio_mail"})
        self.assertEqual(contact.institutional_addresses([f]), frozenset({"admisiones@ejemplosur-viejo.test"}))

    def test_a_role_address_on_the_contact_page_with_nowhere_to_receive(self) -> None:
        old = "colegio-viejo.test"
        survey = MailDomainSurvey(
            checked=[check(old, ans(old, "MX", OK, ["0 "]), pages=("interna",), role="secretaría", role_page="interna")],
            interna_read=True,
            interna_kind="contacto",
        )
        f = self.vis21(survey, interna=True)
        self.assertEqual(f.measured["pagina_mail"], "contacto")
        self.assertEqual(f.evidence, ["dominios-correo.json", "home.html", "interna.html"])
        self.assertEqual(f.measured["interna_url"], f"{BASE}/institucional/")


    def test_null_mx_and_nowhere_and_an_idn_domain(self) -> None:
        idn = "xn--espaol-zwa.test"
        f = self.vis21(MailDomainSurvey(checked=[check(idn, ans(idn, "MX", OK, ["0 "]))]))
        self.assertEqual(
            f.phrase_report.found,
            "Una dirección de correo publicada en el sitio termina en @español.test, y ese dominio declara que no "
            "recibe correo",
        )
        nowhere = "sinnada.test"
        survey = MailDomainSurvey(
            checked=[check(nowhere, ans(nowhere, "MX", NODATA), ans(nowhere, "A", NODATA), ans(nowhere, "AAAA", NODATA), pages=("interna",))],
            interna_read=True,
            interna_kind="admisiones",
        )
        f = self.vis21(survey, interna=True, kind="escuela")
        self.assertEqual(f.measured["veredicto_mail"], "sin-mx-ni-a")
        self.assertEqual(f.evidence, ["dominios-correo.json", "home.html", "interna.html"])
        self.assertEqual(f.measured["interna_url"], f"{BASE}/institucional/")

    def test_a_broken_contact_path_is_yellow(self) -> None:
        old = "colegio-viejo.test"
        f = self.vis21(MailDomainSurvey(checked=[check(old, ans(old, "MX", NX))]))
        self.assertEqual(f.colour_exception, ColourException.MAIL_BOUNCES)
        colours.colour_finding(f)
        self.assertEqual((f.colour_derived, f.colour), (Colour.AZUL, Colour.AMARILLO))
        self.assertEqual(f.colour_reason, "un camino de contacto que no anda; lo que escriben a esa dirección rebota")
        # Control: the pass keeps the table colour.
        ok = self.vis21(MailDomainSurvey(checked=[check("colegio.test", ans("colegio.test", "MX", OK, ["1 aspmx.l.google.com"]))]))
        colours.colour_finding(ok)
        self.assertEqual((ok.state, ok.colour, ok.colour_reason), (State.APROBADO, Colour.VERDE, None))

    def test_controls(self) -> None:
        good = "colegio.test"
        a_only = "solo-a.test"
        f = self.vis21(MailDomainSurvey(checked=[
            check(good, ans(good, "MX", OK, ["1 aspmx.l.google.com"]), role="info", role_page="inicio"),
            check(a_only, ans(a_only, "MX", NODATA), ans(a_only, "A", OK, ["192.0.2.10"])),
        ]))
        self.assertEqual(f.phrase_report.found, "Los dominios de las direcciones de correo publicadas tienen dónde recibir mails")
        self.assertEqual(
            f.measured["dominios"],
            [
                {"dominio": "colegio.test", "paginas": ["inicio"], "veredicto": "recibe-mx", "direccion": "info@colegio.test"},
                {"dominio": "solo-a.test", "paginas": ["inicio"], "veredicto": "recibe-a"},
            ],
        )
        self.assertEqual(
            self.vis21(MailDomainSurvey(free_mail=["gmail.com"])).reason,
            "las direcciones de correo publicadas son de un servicio gratuito, que siempre recibe correo",
        )
        unknown = self.vis21(MailDomainSurvey(checked=[check("lento.test", ans("lento.test", "MX", ERR))]))
        self.assertEqual(
            (unknown.state, unknown.reason),
            (State.NO_VERIFICADO, "la consulta del dominio de una dirección de correo no respondió; se repite"),
        )
        no_control = self.vis21(MailDomainSurvey(checked=[check("x.test")], not_queried="no-control"))
        self.assertEqual((no_control.state, no_control.reason), (State.NO_VERIFICADO, "la consulta de control del correo falló; se repite"))
        self.assertEqual(self.vis21(None).state, State.NO_VERIFICADO)
        # A failure wins over an unknown answer of another domain.
        mixed = self.vis21(MailDomainSurvey(checked=[check("lento.test", ans("lento.test", "MX", ERR)), check("nx.test", ans("nx.test", "MX", NX))]))
        self.assertEqual(mixed.state, State.FALLA)


class MailtoDomainsTest(unittest.TestCase):
    def test_domains_only_never_the_address(self) -> None:
        self.assertEqual(
            links.mailto_domains("mailto:info@colegio.test,admin@otro.test?subject=Hola&cc=x@tercero.test"),
            ["colegio.test", "otro.test"],
        )
        self.assertEqual(links.mailto_domains("MAILTO:%69nfo@COLEGIO.test"), ["colegio.test"])
        self.assertEqual(links.mailto_domains("mailto:secretaria@español.test"), ["xn--espaol-zwa.test"])
        self.assertEqual(links.mailto_domains("mailto:Secretaría <secretaria@colegio.test>"), ["colegio.test"])
        # Controls: no "@", a one-label host, a broken host, and another scheme give nothing.
        for href in ("mailto:sin-arroba", "mailto:x@localhost", "mailto:x@cole gio.test", "https://colegio.test/", "tel:+5411"):
            self.assertEqual(links.mailto_domains(href), [], href)

    def test_link_set_keeps_the_domains_in_document_order(self) -> None:
        html = (
            '<a href="mailto:b@segundo.test">B</a><a href="mailto:a@primero.test?subject=x">A</a>'
            '<a href="mailto:c@segundo.test">C</a><area href="mailto:d@tercero.test">'
        )
        ls = links.discover_links(html, f"{BASE}/")
        self.assertEqual(ls.mail_domains, ["segundo.test", "primero.test", "tercero.test"])
        self.assertNotIn("mailto:b@segundo.test", ls.anchors)
        self.assertEqual(ls.role_locals, {})

    def test_the_free_mail_list_is_shared(self) -> None:
        self.assertIn("gmail.com", domains.FREE_MAIL_DOMAINS)

    def test_the_spanish_and_regional_free_mail_services(self) -> None:
        for d in ("hotmail.es", "outlook.es", "live.es", "yahoo.es", "ymail.com", "live.com.ar", "hotmail.com.ar",
                  "yahoo.com.ar", "outlook.com.ar", "hotmail.com.mx", "yahoo.com.br", "hotmail.cl"):
            self.assertIn(d, domains.FREE_MAIL_DOMAINS, d)
        # Controls: a school domain under a regional suffix, and a lookalike, are no free service.
        for d in ("colegio-ejemplo.com.ar", "hotmail.test", "outlook-es.test"):
            self.assertNotIn(d, domains.FREE_MAIL_DOMAINS, d)


# Every role word of the decision, as the institution may write it (case and accents vary).
ROLE_WORDS = (
    "info", "informes", "secretaria", "secretaría", "administracion", "administración", "admision", "admisión",
    "admisiones", "inscripcion", "inscripción", "inscripciones", "contacto", "comunicacion", "comunicación",
    "comunicaciones", "prensa", "direccion", "dirección", "rectoria", "rectoría", "colegio", "escuela", "instituto",
    "institucional", "consultas",
)


class RoleAddressTest(unittest.TestCase):
    """Only an address whose whole local part is an institutional role leaves links.py."""

    def test_the_role_words(self) -> None:
        for word in ROLE_WORDS:
            self.assertEqual(links.role_local(word), word, word)
        self.assertEqual(links.role_local("Secretaría"), "secretaría")
        self.assertEqual(links.role_local("INFO"), "info")
        self.assertEqual(links.role_local("Admisión"), "admisión")

    def test_control_anything_else_is_a_person_or_unknown(self) -> None:
        for local in ("mlopez", "info.juan", "secretaria2", "admisiones2027", "info-colegio", "juan.info", "rector", "", " "):
            self.assertIsNone(links.role_local(local), local)

    def test_mailto_addresses_keep_only_the_role(self) -> None:
        # The cc= address is a copy, not a recipient.
        self.assertEqual(
            links.mailto_addresses("mailto:Admisiones@Colegio.test,mlopez@colegio.test?cc=prensa@otro.test"),
            [("colegio.test", "admisiones"), ("colegio.test", None)],
        )
        self.assertEqual(links.mailto_addresses("mailto:Secretaría <secretaria@colegio.test>"), [("colegio.test", "secretaria")])
        self.assertEqual(links.mailto_addresses("mailto:secretar%C3%ADa@colegio.test"), [("colegio.test", "secretaría")])

    def test_the_link_set_keeps_the_first_role_per_domain_and_never_a_person(self) -> None:
        html = (
            '<a href="mailto:mlopez@viejo.test">Escribir</a><a href="mailto:admisiones@viejo.test">Admisiones</a>'
            '<a href="mailto:info@viejo.test">Info</a><a href="mailto:info@nuevo.test">Correo</a>'
            '<a href="mailto:rgomez@tercero.test">Escribir</a>'
        )
        ls = links.discover_links(html, f"{BASE}/")
        self.assertEqual(ls.mail_domains, ["viejo.test", "nuevo.test", "tercero.test"])
        self.assertEqual(ls.role_locals, {"viejo.test": "admisiones", "nuevo.test": "info"})
        self.assertNotIn("mlopez", repr(ls))
        self.assertNotIn("rgomez", repr(ls))


class _FakeDoh:
    """DoH answers by (name, type); anything not listed does not exist (NXDOMAIN). Records what was asked."""

    def __init__(self, zone: dict[tuple[str, str], tuple[DnsStatus, list[str]]]) -> None:
        self.zone = zone
        self.asked: list[tuple[str, str]] = []

    def query(self, name: str, rtype: str) -> DnsAnswer:
        self.asked.append((name, rtype))
        status, records = self.zone.get((name, rtype), (NX, []))
        return ans(name, rtype, status, records)


class _FakeArtifacts:
    def __init__(self) -> None:
        self.json: dict[str, object] = {}

    def put_json(self, name: str, payload: object) -> None:
        self.json[name] = payload


CONTACT_URL = f"{BASE}/contacto/"


class MailDomainCollectorTest(unittest.TestCase):
    """collect.check_mail_domains on hand-made pages, then evaluate_vis21 on what it gathered."""

    def collect(self, home_body: str, interna_body: str | None, *, interna_url: str = CONTACT_URL, truncated: bool = False):  # type: ignore[no-untyped-def]
        obs = make_obs(html_page(body=home_body), dns=DnsBundle(site=SITE_DNS, control=CONTROL, control_ok=True))
        obs.home.links = links.discover_links(obs.home.response.body.decode("utf-8"), HOME)
        if interna_body is not None:
            obs.interna = page("interna", interna_url, html_page(body=interna_body), purpose=Purpose.INTERNA)
            obs.interna.response.truncated = truncated
            obs.interna.links = links.discover_links(obs.interna.response.body.decode("utf-8"), interna_url)
        doh = _FakeDoh({("colegio.test", "MX"): (OK, ["1 aspmx.l.google.com."])})
        services = types.SimpleNamespace(doh=doh, artifacts=_FakeArtifacts())
        collect.check_mail_domains(services, obs)
        return obs, services

    def test_the_role_address_of_the_contact_page(self) -> None:
        home = '<a href="/contacto/">Contacto</a><a href="mailto:mlopez@viejo.test">Escribir</a>'
        interna = '<a href="mailto:Admisiones@viejo.test">Admisiones</a><a href="mailto:consultas@hotmail.es">Consultas</a>'
        obs, services = self.collect(home, interna)
        survey = obs.mail_domains
        self.assertEqual(
            [(c.domain, c.pages, c.role_local, c.role_page) for c in survey.checked],
            [("viejo.test", ["inicio", "interna"], "admisiones", "interna")],
        )
        self.assertEqual((survey.free_mail, survey.interna_read, survey.interna_kind), (["hotmail.es"], True, "contacto"))
        self.assertEqual(services.doh.asked, [("viejo.test", "MX")], "a free mail service is never asked")
        evidence = json.dumps(services.artifacts.json["dominios-correo.json"], ensure_ascii=False)
        self.assertNotIn("@", evidence)
        self.assertNotIn("mlopez", evidence)
        f = ev(contact.evaluate_vis21, obs)
        self.assertNotIn("mlopez", json.dumps(f.measured, ensure_ascii=False))
        self.assertEqual(f.measured["gratuitos"], 1)

    def test_control_a_truncated_interna_is_not_read(self) -> None:
        home = '<a href="/contacto/">Contacto</a><a href="mailto:mlopez@viejo.test">Escribir</a>'
        interna = '<a href="mailto:admisiones@viejo.test">Admisiones</a>'
        obs, _ = self.collect(home, interna, truncated=True)
        survey = obs.mail_domains
        self.assertEqual([(c.domain, c.pages, c.role_local) for c in survey.checked], [("viejo.test", ["inicio"], None)])
        self.assertEqual((survey.interna_read, survey.interna_kind), (False, None))
        f = ev(contact.evaluate_vis21, obs)
        self.assertNotIn("direccion", f.measured["dominios"][0])

    def test_an_interna_that_is_not_a_contact_page(self) -> None:
        home = '<a href="/institucional/">Institucional</a>'
        interna = '<a href="mailto:info@viejo.test">Info</a>'
        obs, _ = self.collect(home, interna, interna_url=f"{BASE}/institucional/")
        self.assertEqual((obs.mail_domains.interna_read, obs.mail_domains.interna_kind), (True, None))

    def test_no_address_says_which_pages_were_read(self) -> None:
        home = '<a href="/contacto/">Contacto</a>'
        obs, _ = self.collect(home, "<p>Sin correo.</p>")
        f = ev(contact.evaluate_vis21, obs)
        self.assertEqual((f.state, f.reason), (State.NO_APLICA, "la página de inicio y la página interna no publican direcciones de correo"))
        obs, _ = self.collect(home, "<p>Sin correo.</p>", truncated=True)
        f = ev(contact.evaluate_vis21, obs)
        self.assertEqual(
            (f.state, f.reason),
            (State.NO_APLICA, "la página de inicio no publica direcciones de correo (la página interna no se pudo leer entera)"),
        )
        obs, _ = self.collect(home, None)
        f = ev(contact.evaluate_vis21, obs)
        self.assertEqual(
            (f.state, f.reason),
            (State.NO_APLICA, "la página de inicio no publica direcciones de correo (no se leyó otra página del sitio)"),
        )


# ---------------------------------------------------------------------------
# the interna prefers a contact page
# ---------------------------------------------------------------------------


class InternaPreferenceTest(unittest.TestCase):
    def interna(self, body: str, robots=None) -> str | None:  # type: ignore[no-untyped-def]
        ls = links.discover_links(f"<html><body>{body}</body></html>", f"{BASE}/")
        return links.select_interna(ls, "colegio.test", robots)

    def test_contact_first_then_admissions(self) -> None:
        body = (
            '<a href="/institucional/">Institucional</a><a href="/admisiones/">Admisiones</a>'
            '<a href="/escribinos/">Contacto</a>'
        )
        self.assertEqual(self.interna(body), f"{BASE}/escribinos/")
        self.assertEqual(self.interna('<a href="/institucional/">Institucional</a><a href="/proceso/">Inscripción 2027</a>'), f"{BASE}/proceso/")
        self.assertEqual(self.interna('<a href="/x/">Inicio</a><a href="/cont%C3%A1ctenos/">Escribanos</a>'), f"{BASE}/cont%C3%A1ctenos/")
        # aria-label counts as the anchor's text.
        self.assertEqual(self.interna('<a href="/a/">A</a><a href="/b/" aria-label="Contacto"><img src="/i.png" alt=""></a>'), f"{BASE}/b/")

    def test_controls(self) -> None:
        # Without a contact or admissions page: the first eligible link, as before.
        self.assertEqual(self.interna('<a href="/institucional/">Institucional</a><a href="/niveles/">Niveles</a>'), f"{BASE}/institucional/")
        # The home itself (index.php) is never the interna, even with an admissions text.
        self.assertEqual(self.interna('<a href="/index.php">Inscripciones</a><a href="/institucional/">Institucional</a>'), f"{BASE}/institucional/")
        # Off the site, or blocked by robots.txt: the next one.
        self.assertEqual(self.interna('<a href="https://otro.test/contacto/">Contacto</a><a href="/institucional/">I</a>'), f"{BASE}/institucional/")
        from sitecheck.robots import parse_robots

        blocked = parse_robots("User-agent: *\nDisallow: /contacto/\n")
        body = '<a href="/institucional/">I</a><a href="/contacto/">Contacto</a><a href="/admision/">Admisión</a>'
        self.assertEqual(self.interna(body, blocked), f"{BASE}/admision/")

    def test_the_kind_of_the_interna(self) -> None:
        ls = links.discover_links('<a href="/escribinos/">Contacto</a><a href="/admisiones/">Admisiones</a><a href="/x/">X</a>', f"{BASE}/")
        self.assertEqual(links.interna_kind(f"{BASE}/escribinos/", ls), "contacto")
        self.assertEqual(links.interna_kind(f"{BASE}/admisiones/", ls), "admisiones")
        self.assertIsNone(links.interna_kind(f"{BASE}/x/", ls))


WA_MISSING_54 = "https://wa.me/1145678900"


class Vis18InternaTest(unittest.TestCase):
    def test_a_bad_number_on_the_contact_page(self) -> None:
        obs = make_obs(html_page(), interna_html=html_page(body=f'<a href="{WA_MISSING_54}">WhatsApp</a>'))
        f = ev(contact.evaluate_vis18, obs)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.evidence, ["home.html", "interna.html"])
        self.assertEqual((f.measured["paginas_falla"], f.measured["interna_url"]), (["interna"], f"{BASE}/institucional/"))

    def test_control_the_same_number_on_the_home(self) -> None:
        f = ev(contact.evaluate_vis18, make_obs(html_page(body=f'<a href="{WA_MISSING_54}">WhatsApp</a>')))
        self.assertEqual((f.state, f.evidence, f.measured["paginas_falla"]), (State.FALLA, ["home.html"], ["inicio"]))
        # Control: without numbers anywhere VIS-18 does not apply.
        self.assertEqual(ev(contact.evaluate_vis18, make_obs(html_page(), interna_html=html_page())).state, State.NO_APLICA)


# ---------------------------------------------------------------------------
# the colours of a broken contact path and the e-mail control
# ---------------------------------------------------------------------------


class ContactColourTest(unittest.TestCase):
    def test_a_badly_written_whatsapp_number_is_yellow(self) -> None:
        f = ev(contact.evaluate_vis18, make_obs(html_page(body=f'<a href="{WA_MISSING_54}">WhatsApp</a>')))
        self.assertEqual(f.colour_exception, ColourException.WHATSAPP_BROKEN)
        colours.colour_finding(f)
        self.assertEqual((f.colour_derived, f.colour), (Colour.AZUL, Colour.AMARILLO))
        self.assertEqual(f.colour_reason, "un camino de contacto que no anda; al tocar el enlace no se abre el chat")


class InstitutionalAddressControlTest(unittest.TestCase):
    """The e-mail control of the client texts lets through the run's role addresses and nothing else."""

    def test_the_forms_the_control_finds(self) -> None:
        forms = outputs.allowed_email_forms({"Secretaría@colegio-viejo.test", "admisiones@viejo.test"})
        # EMAIL_RE finds an accented local part only from its last ASCII run ("a@colegio-viejo.test").
        self.assertEqual(forms, frozenset({"secretaría@colegio-viejo.test", "a@colegio-viejo.test", "admisiones@viejo.test"}))


    def test_datos_masks_everything_but_the_role_address(self) -> None:
        allowed = outputs.allowed_email_forms({"admisiones@viejo.test"})
        masked, found = outputs.mask_foreign_emails({"a": "admisiones@viejo.test y mlopez@viejo.test"}, allowed)
        self.assertEqual((masked, found), ({"a": "admisiones@viejo.test y [correo]"}, ["mlopez@viejo.test"]))
        masked, found = outputs.mask_foreign_emails({"a": "admisiones@viejo.test"})
        self.assertEqual((masked, found), ({"a": "[correo]"}, ["admisiones@viejo.test"]))


# ---------------------------------------------------------------------------
# D and I: end to end against the fake site
# ---------------------------------------------------------------------------


def _with_page(sc: Scenario, key: str, *changes: tuple[str, str]) -> Scenario:
    """``sc`` with the HTML of the route ``key`` changed by exact replacements (each must match once)."""
    route = sc.routes[key]
    raw = route.body
    html = raw.decode("utf-8")
    for old, new in changes:
        assert html.count(old) == 1, old
        html = html.replace(old, new)
    sc.routes[key] = Route(route.status, list(route.headers), html.encode("utf-8"), gzip=route.gzip)
    return sc


def with_home(options: SchoolOptions, *changes: tuple[str, str]) -> Scenario:
    """school_scenario(options) with its home HTML changed by exact replacements (each must match once)."""
    return _with_page(school_scenario(options), f"https://www.{options.domain}/", *changes)


def fast_apis(domain: str = "colegio.test", *, meta_viewport: str = "pass") -> FakeApisConfig:
    """Fast PageSpeed (field LCP 1,9 s, 1 MB): no LENTO finding. ``meta_viewport``: the phone run's audit (fakeapis)."""
    cfg = default_apis(domain)
    final = f"https://www.{domain}/"
    cfg.psi_mobile = [
        psi_payload(final, lab_lcp_ms=v, field_lcp_ms=1900, total_bytes=1_000_000, image_bytes=400_000, meta_viewport=meta_viewport)
        for v in (1800.0, 1900.0, 1700.0)
    ]
    return cfg


def lab_only_apis(domain: str) -> FakeApisConfig:
    """Slow in the lab (4,8 s) with no real-user data at all."""
    cfg = default_apis(domain)
    final = f"https://www.{domain}/"
    cfg.psi_mobile = [
        psi_payload(final, lab_lcp_ms=v, field_lcp_ms=None, field_inp_ms=None, field_cls_pct=None, total_bytes=1_000_000, image_bytes=400_000)
        for v in (4830.0, 5120.0, 4600.0)
    ]
    return cfg


VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
HEAD_END = "</head>"


def recent_feed() -> str:
    return email.utils.format_datetime(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30))


class MailDomainCollectionTest(unittest.TestCase):
    """The DoH questions VIS-21 asks: once, in the RFC 5321 order, never for a free mail service."""

    @classmethod
    def setUpClass(cls) -> None:
        options = SchoolOptions(broken_link=False)
        # The Gmail and Hotmail links test that a free mail service is never asked, so their
        # domains have to be real ones from domains.FREE_MAIL_DOMAINS. Gmail usernames cannot
        # contain a hyphen, so the Gmail address cannot belong to anyone.
        mailtos = (
            '<a href="mailto:info@colegio.test">Correo de secretaría</a> '
            '<a href="mailto:jperez@colegio-viejo.test">Escribir</a> '
            '<a href="mailto:secretaria@colegio-viejo.test">Secretaría (anterior)</a> '
            '<a href="mailto:admisiones-ficticia@gmail.com">Admisiones</a> '
            '<a href="mailto:consultas@hotmail.es">Consultas</a> '
            '<a href="mailto:prensa@solo-a.test">Prensa</a>'
        )
        sc = with_home(options, ('<a href="mailto:info@colegio.test">Correo de secretaría</a>', mailtos))
        apis = default_apis()
        apis.zone[("solo-a.test", "A")] = ["192.0.2.10"]
        cls.r = run_e2e(sc, apis)

    def queries(self) -> list[tuple[str, str]]:
        out = []
        for raw in self.r.api_queries:
            if raw.startswith(("/resolve", "/dns-query")):
                from urllib.parse import parse_qs, urlsplit

                q = parse_qs(urlsplit(raw).query)
                out.append((q["name"][0], q["type"][0]))
        return out

    def test_what_was_asked(self) -> None:
        q = self.queries()
        self.assertEqual(q.count(("colegio-viejo.test", "MX")), 1)
        self.assertNotIn(("colegio-viejo.test", "A"), q, "an NXDOMAIN needs nothing more")
        self.assertEqual(q.count(("solo-a.test", "MX")), 1)
        self.assertEqual(q.count(("solo-a.test", "A")), 1)
        self.assertNotIn(("solo-a.test", "AAAA"), q, "an A record is enough")
        self.assertEqual(q.count(("colegio.test", "MX")), 1, "the site's own MX is reused, never asked twice")
        self.assertFalse(any("gmail" in name or "hotmail" in name for name, _ in q), "a free mail service is never asked")

    def test_the_finding_and_its_evidence(self) -> None:
        vis21 = self.r.check("VIS-21")
        self.assertEqual(vis21["estado"], "FALLA")
        self.assertEqual(
            vis21["mediciones"]["dominios"],
            [
                {"dominio": "colegio.test", "paginas": ["inicio"], "veredicto": "recibe-mx", "direccion": "info@colegio.test"},
                {"dominio": "colegio-viejo.test", "paginas": ["inicio"], "veredicto": "no-existe", "direccion": "secretaria@colegio-viejo.test"},
                {"dominio": "solo-a.test", "paginas": ["inicio"], "veredicto": "recibe-a", "direccion": "prensa@solo-a.test"},
            ],
        )
        self.assertEqual(vis21["mediciones"]["gratuitos"], 2)
        self.assertEqual(vis21["color_final"], "amarillo")
        evidence = self.r.evidence["dominios-correo.json"].decode("utf-8")
        self.assertNotIn("@", evidence)
        # 14/10/2026.

    def test_a_person_s_address_is_never_kept(self) -> None:
        self.assertNotIn("jperez", json.dumps(self.r.datos, ensure_ascii=False))
        for name, text in self.r.files.items():
            self.assertNotIn("jperez", text, name)
        for name, data in self.r.evidence.items():
            self.assertNotIn(b"jperez", data, name)


    def test_control_without_a_good_control_lookup_nothing_is_asked(self) -> None:
        apis = default_apis()
        del apis.zone[("_dmarc.control.test", "TXT")]
        sc = with_home(SchoolOptions(broken_link=False), ('mailto:info@colegio.test', "mailto:secretaria@colegio-viejo.test"))
        r = run_e2e(sc, apis)
        self.assertFalse(any("colegio-viejo" in raw for raw in r.api_queries))
        self.assertEqual(r.check("VIS-21")["estado"], "NO_VERIFICADO")

    def test_at_most_four_domains(self) -> None:
        many = " ".join(f'<a href="mailto:x@dominio{n}.test">{n}</a>' for n in range(1, 7))
        sc = with_home(SchoolOptions(broken_link=False), ('<a href="mailto:info@colegio.test">Correo de secretaría</a>', many))
        r = run_e2e(sc, default_apis())
        asked = {raw for raw in r.api_queries if "dominio" in raw}
        self.assertEqual({n for n in range(1, 7) if any(f"dominio{n}.test" in raw for raw in asked)}, {1, 2, 3, 4})
        self.assertEqual(r.check("VIS-21")["mediciones"]["fuera_del_tope"], 2)


class FocusScenariosTest(unittest.TestCase):
    """The scenarios of the task, end to end (the renders of the task come from the same scenarios)."""

    def test_2_control_the_phone_run_sees_a_viewport(self) -> None:
        # The same site whose phone run finds a viewport (a page served only to phones): VIS-12 is grey.
        r = run_e2e(scenario_2(), fast_apis("ejemplosur.test", meta_viewport="pass"), url="https://www.ejemplosur.test/",
                    nombre="Instituto Ejemplo Sur", extra=("--kind", "instituto"))
        self.assertEqual(r.code, 0, r.err)
        vis12 = r.check("VIS-12")
        self.assertEqual((vis12["estado"], vis12["nota_interna"]), ("NO_VERIFICADO", VIS12_PHONE_NOTE))

    def test_3_escuela_ie9_and_a_generic_title(self) -> None:
        r = run_e2e(scenario_3(), fast_apis("escuela12.test"), url="https://www.escuela12.test/", nombre="Escuela Nº 12",
                    extra=("--kind", "escuela"))
        self.assertEqual(r.code, 0, r.err)
        self.assertEqual(r.check("VIS-04")["estado"], "FALLA")
        vis20 = r.check("VIS-20")
        self.assertEqual((vis20['estado'], vis20['mediciones']['ie_version']), ('FALLA', 9))
        self.assertEqual((vis20["estado"], vis20["mediciones"]["ie_version"]), ("FALLA", 9))

    def test_4_empresa_lab_slow_and_flash(self) -> None:
        r = run_e2e(scenario_4(), lab_only_apis("acme.test"), url="https://www.acme.test/", nombre="Acme", extra=("--kind", "empresa"))
        self.assertEqual(r.code, 0, r.err)
        ext08 = r.check("EXT-08")
        self.assertEqual((ext08['estado'], ext08['mediciones']['scope']), ('FALLA', 'laboratorio'))
        self.assertEqual((ext08["estado"], ext08["mediciones"]["scope"]), ("FALLA", "laboratorio"))
        vis20 = r.check("VIS-20")
        self.assertEqual((vis20['estado'], vis20['mediciones']['flash']), ('FALLA', True))
        self.assertEqual((vis20["estado"], vis20["mediciones"]["flash"]), ("FALLA", True))


def scenario_2() -> Scenario:
    """Instituto Ejemplo Sur: no viewport, footer © 2019, a person's mailto: on a domain that does not exist; fast, no WordPress."""
    options = SchoolOptions(domain="ejemplosur.test", name="Instituto Ejemplo Sur", title="Instituto Ejemplo Sur | Nivel inicial, primario y secundario",
                            wp_version=None, broken_link=False, footer_year=2019)
    return with_home(options, (VIEWPORT, ""), ("mailto:info@ejemplosur.test", "mailto:mlopez@ejemplosur-viejo.test"))


def scenario_3() -> Scenario:
    """Escuela Nº 12: IE 9 markers, the title "Inicio", no contact problem; fast, no WordPress, current footer."""
    options = SchoolOptions(domain="escuela12.test", name="Escuela Nº 12", title="Inicio", wp_version=None, broken_link=False,
                            footer_year=dt.date.today().year, feed_last_item=recent_feed())
    ie9 = '<!--[if IE 9]>\n<link rel="stylesheet" href="https://www.escuela12.test/wp-content/themes/escuela/css/ie9.css" />\n<![endif]-->\n</head>'
    return with_home(options, (HEAD_END, ie9))


def scenario_4() -> Scenario:
    """Acme (empresa): slow only in the lab, a Flash banner; no WordPress, no broken link."""
    options = SchoolOptions(domain="acme.test", name="Acme", title="Acme | Insumos para la industria", wp_version=None, broken_link=False,
                            footer_year=dt.date.today().year, feed_last_item=recent_feed())
    flash = (
        '<object type="application/x-shockwave-flash" data="https://www.acme.test/wp-content/uploads/banner.swf" width="900" height="300">'
        '<param name="movie" value="https://www.acme.test/wp-content/uploads/banner.swf"></object>\n<main id="main">'
    )
    return with_home(options, ('<main id="main">', flash))


if __name__ == "__main__":
    unittest.main()
