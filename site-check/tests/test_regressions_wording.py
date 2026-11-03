"""Regression tests of the report wording: intro lists, missing protections,
platform wording, the order of the first actions, DMARC delivery wording, the
self-check without a control site, keyless PageSpeed reasons, weights in KB and
EXT-17 after a cut. Every CLI run goes to the local fake site and fake APIs; no
test names a real URL.
"""

from __future__ import annotations

import dataclasses
import unittest

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder, patched_env, temp_dir

from sitecheck import render_report
from sitecheck.checks import a11y, common, mailauth, security, seo, speed
from sitecheck.collect import collect
from sitecheck.config import RunConfig
from sitecheck.doh import DnsBundle
from sitecheck.model import Colour, Finding, Priority, State
from sitecheck.observations import VariantProbe
from sitecheck.psi import AuditResult
from sitecheck.services import build_services
from fakeapis import FakeApis
from fakesite import FakeSite, Route, Scenario
from fixhelp import HTML, control_route, run_e2e, small_home
from obsfactory import BASE, html_page, make_ctx, make_obs, psi_series
from sitefixtures import SchoolOptions, challenge_route, default_apis, school_scenario
from test_checks_security import CONTROL, GOOGLE_MX, mail_dns
from test_regressions_report import finding, report_ctx

WP_ASSET = '<link rel="stylesheet" href="https://www.colegio.test/wp-content/themes/escuela/style.css">'
WP_WORDS = ("plugin", "tema hijo", "biblioteca de medios", "constructor", "ajustes generales", "ajustes de lectura", "en el tema")


def ev(fn, obs, **ctx_kw):
    return fn(obs, make_ctx(obs, **ctx_kw))


def intro(text: str) -> str:
    start = text.index("## Qué se miró y qué no\n\n") + len("## Qué se miró y qué no\n\n")
    return text[start:text.index("\n\n## En cinco líneas")]


def audit(audit_id: str, score: float | None, mode: str = "binary", failing: int | None = None) -> AuditResult:
    return AuditResult(id=audit_id, score=score, score_display_mode=mode, numeric_value=None, failing_items=failing)


def form_audits(label: AuditResult, target: AuditResult | None = None) -> dict[str, AuditResult]:
    return {"label": label, "target_size": target or audit("target-size", 1)}


FORM_BODY = '<form action="/contacto/"><label for="n">Nombre</label><input id="n" name="nombre" type="text"><button>Enviar</button></form>'


# ---------------------------------------------------------------------------
# the intro names only the blocklist that answered
# ---------------------------------------------------------------------------


def ext23(verdict: str | None, state: State = State.NO_VERIFICADO) -> Finding:
    colour = Colour.GRIS if state == State.NO_VERIFICADO else Colour.ROJO
    f = finding("EXT-23", state=state, colour=colour, priority=Priority.CRITICA, eligible=False)
    f.measured = {"verdict": verdict}
    return f


class IntroListsTest(unittest.TestCase):
    NONE = (
        "Se revisó lo que cualquier persona puede ver desde afuera: cómo responde el sitio, cómo carga en un celular "
        "y cómo está configurado el dominio y el correo. No se entró al panel ni al hosting, así que lo que pasa "
        "adentro (usuarios, copias de seguridad, componentes instalados) no está en este informe."
    )
    SPAMHAUS = (
        "Se revisó lo que cualquier persona puede ver desde afuera: cómo responde el sitio, cómo carga en un celular, "
        "cómo está configurado el dominio y el correo, y si el dominio figura en la lista de bloqueo de Spamhaus. No "
        "se entró al panel ni al hosting, así que lo que pasa adentro (usuarios, copias de seguridad, componentes "
        "instalados) no está en este informe."
    )

    def test_no_list_answered_drops_the_clause(self) -> None:
        for verdict in ("error", "refused", None):
            text = render_report.render_report(report_ctx([finding("VIS-04"), ext23(verdict)]))
            self.assertEqual(intro(text), self.NONE, verdict)
        no_ext23 = render_report.render_report(report_ctx([finding("VIS-04")]))
        self.assertEqual(intro(no_ext23), self.NONE)

    def test_spamhaus_answered(self) -> None:
        for f in (ext23("not-listed"), ext23("listed", state=State.FALLA)):
            text = render_report.render_report(report_ctx([finding("VIS-04"), f]))
            self.assertEqual(intro(text), self.SPAMHAUS)

    def test_e2e_spamhaus_grey_as_under_warp(self) -> None:
        warp = run_e2e(school_scenario(), default_apis(dbl_codes=["127.255.255.254"]))
        self.assertNotIn("listas de sitios peligrosos", warp.files["informe.md"])
        self.assertEqual(intro(warp.files["informe.md"]), self.NONE)
        calm = run_e2e(school_scenario(), default_apis())
        self.assertIn("y si el dominio figura en la lista de bloqueo de Spamhaus.", intro(calm.files["informe.md"]))


# ---------------------------------------------------------------------------
# the EXT-01 consequence and action follow what is missing
# ---------------------------------------------------------------------------


HSTS = ("Strict-Transport-Security", "max-age=31536000")
NOSNIFF = ("X-Content-Type-Options", "nosniff")
REFERRER = ("Referrer-Policy", "strict-origin-when-cross-origin")
XFO = ("X-Frame-Options", "SAMEORIGIN")
CSP = ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'")


class Ext01MissingTest(unittest.TestCase):
    def ext01(self, *headers: tuple[str, str]) -> Finding:
        obs = make_obs(html_page(), home_headers=[("Content-Type", "text/html; charset=UTF-8"), *headers])
        return ev(security.evaluate_ext01, obs)

    def test_five_of_six_only_permissions_policy_missing(self) -> None:
        f = self.ext01(HSTS, NOSNIFF, REFERRER, XFO, CSP)
        self.assertEqual((f.state, f.measured["n_protections"]), (State.APROBADO_CON_OBSERVACION, 5))
        self.assertEqual(
            f.phrase_report.consequence,
            "El sitio no limita qué funciones del navegador, como la cámara o la ubicación, pueden usar sus páginas",
        )
        self.assertEqual(
            f.phrase_report.action,
            "Agregar la protección que falta (la que limita los permisos del navegador) y probar que nada se rompa",
        )
        for claim in ("incrustar", "inyectar"):
            self.assertNotIn(claim, f.phrase_report.consequence)

    def test_four_of_six_with_frame_protection(self) -> None:
        f = self.ext01(HSTS, NOSNIFF, XFO, REFERRER)
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(
            f.phrase_report.consequence,
            "Es más fácil inyectarle contenido al sitio; el sitio no limita qué funciones del navegador, como la "
            "cámara o la ubicación, pueden usar sus páginas",
        )
        self.assertNotIn("incrustar", f.phrase_report.consequence)
        self.assertEqual(
            f.phrase_report.action,
            "Agregar las 2 protecciones que faltan (la que limita qué contenido carga la página y la que limita los "
            "permisos del navegador) y probar que nada se rompa",
        )

    def test_failure_without_hsts_names_the_padlock(self) -> None:
        f = self.ext01(NOSNIFF, XFO)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(
            f.phrase_report.consequence,
            # The HSTS clause is tested in test_regressions_texts.
            "Si alguien escribe la dirección sin https, la primera conexión viaja sin candado; es más fácil "
            "inyectarle contenido al sitio; el sitio no indica qué parte de sus direcciones ven los sitios que enlaza",
        )
        self.assertEqual(
            f.phrase_report.action,
            "Agregar las 4 protecciones que faltan (la de conexión segura obligatoria, la que limita qué contenido "
            "carga la página, la que fija qué se comparte con otros sitios y la que limita los permisos del navegador) "
            "y probar que nada se rompa",
        )

    def test_short_hsts_is_extended_not_added(self) -> None:
        f = self.ext01(("Strict-Transport-Security", "max-age=300"), NOSNIFF, REFERRER, XFO, CSP, ("Permissions-Policy", "camera=()"))
        self.assertEqual(f.state, State.FALLA)
        # The short-HSTS clause is tested in test_regressions_texts.
        self.assertEqual(f.phrase_report.consequence, "El navegador recuerda por poco tiempo que tiene que usar la conexión segura")
        self.assertEqual(
            f.phrase_report.action,
            "Alargar a seis meses o más la de conexión segura obligatoria y probar que nada se rompa",
        )

    def test_none_missing_framing_and_injection_together(self) -> None:
        f = self.ext01(HSTS, NOSNIFF, REFERRER, ("Permissions-Policy", "camera=()"))
        self.assertEqual(
            f.phrase_report.consequence, "Es más fácil incrustar el sitio en otro o inyectarle contenido"
        )


# ---------------------------------------------------------------------------
# WordPress wording only on WordPress
# ---------------------------------------------------------------------------


class PlatformWordingTest(unittest.TestCase):
    def action(self, fn, head: str = "", body: str = "", **kw) -> str:
        f = ev(fn, make_obs(html_page(head, body, **kw)))
        self.assertIn(f.state, (State.FALLA, State.APROBADO_CON_OBSERVACION), fn.__name__)
        return f.phrase_report.action

    def test_neutral_actions_without_wordpress(self) -> None:
        wix = '<meta name="generator" content="Wix.com Website Builder">'
        self.assertEqual(self.action(seo.evaluate_vis06, wix), "Configurar una imagen y una descripción por defecto en la configuración del sitio")
        self.assertEqual(self.action(seo.evaluate_vis04, wix, title="Inicio"), "Escribir título y descripción en la configuración de cada página clave")
        self.assertEqual(self.action(a11y.evaluate_vis11, wix, '<img src="/foto.jpg">'), "Completar la descripción de cada imagen en el editor del sitio")

    def test_wordpress_keeps_its_words(self) -> None:
        self.assertEqual(self.action(seo.evaluate_vis06, WP_ASSET), "Configurar una imagen y una descripción por defecto en el plugin de SEO")
        self.assertEqual(self.action(seo.evaluate_vis04, WP_ASSET, title="Inicio"), "Escribir título y descripción en el plugin de SEO, página por página clave")
        self.assertEqual(self.action(a11y.evaluate_vis11, WP_ASSET, '<img src="/foto.jpg">'), "Completar la descripción en la biblioteca de medios")

    def test_psi_based_actions(self) -> None:
        contrast = {"color_contrast": audit("color-contrast", 0, failing=2)}
        obs = make_obs(html_page(), psi=psi_series(audits=contrast))
        self.assertEqual(ev(a11y.evaluate_vis10, obs).phrase_report.action, "Ajustar los colores en el diseño del sitio")
        obs = make_obs(html_page(WP_ASSET), psi=psi_series(audits=contrast))
        self.assertEqual(ev(a11y.evaluate_vis10, obs).phrase_report.action, "Ajustar colores en el tema hijo")
        labels = form_audits(audit("label", 0, failing=1))
        obs = make_obs(html_page(body=FORM_BODY), psi=psi_series(audits=labels))
        self.assertEqual(
            ev(a11y.evaluate_vis13, obs).phrase_report.action,
            "Ajustar el formulario en el editor del sitio; si está conectado a un sistema externo, primero revisar qué no tocar",
        )

    def test_e2e_shop_on_another_platform(self) -> None:
        home = small_home(title="Inicio").replace(
            b"</head>", b'<meta name="generator" content="Wix.com Website Builder"></head>'
        ).replace(b"<h1>", b'<img src="https://static.wixstatic.com/media/foto.jpg"><h1>')
        page = small_home().replace(b"<h1>Colegio Ejemplo</h1>", b"<h1>Institucional</h1>")
        redirect = Route(301, [("Location", f"{BASE}/")])
        sc = Scenario(
            name="shop",
            routes={
                "http://colegio.test/": redirect,
                "https://colegio.test/": redirect,
                "http://www.colegio.test/": redirect,
                f"{BASE}/": Route(200, list(HTML), home),
                "https://control.test/": control_route(),
                f"{BASE}/robots.txt": Route(200, [("Content-Type", "text/plain")], b"User-agent: *\nDisallow:\n"),
                f"{BASE}/institucional/": Route(200, list(HTML), page),
                f"{BASE}/contacto/": Route(200, list(HTML), page.replace(b"Institucional", b"Contacto")),
            },
        )
        r = run_e2e(sc, default_apis(), nombre="Ferretería Ejemplo", extra=("--kind", "empresa"))
        self.assertEqual(r.check("EXT-02")["estado"], "NO_APLICA", "control: not WordPress")
        self.assertEqual(r.check("VIS-06")["estado"], "FALLA", "control: the shop has an action to read")
        informe = r.files["informe.md"]
        for word in WP_WORDS:
            self.assertNotIn(word, informe, word)
        school = run_e2e(school_scenario(), default_apis())
        self.assertIn("en el tema hijo", school.files["informe.md"], "control: the WordPress school keeps its words")


# ---------------------------------------------------------------------------
# line 5 starts with the finding that gives the next-step reason
# ---------------------------------------------------------------------------


class FiveLinesActionsTest(unittest.TestCase):
    def test_yellow_failure_before_a_yellow_observation(self) -> None:
        findings = [
            finding("EXT-05", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.ALTA, found="La firma no se pudo confirmar"),
            finding("EXT-17", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.ALTA, found="Da 2 vueltas"),
            finding("EXT-25", state=State.FALLA, colour=Colour.AMARILLO, priority=Priority.MEDIA, found="La página principal no enlaza una política de privacidad"),
            finding("VIS-07", colour=Colour.AZUL, found="Faltan datos para Google"),
        ]
        lines = render_report.five_lines(findings)
        self.assertEqual(lines[:3], ["La firma no se pudo confirmar", "Da 2 vueltas", "La página principal no enlaza una política de privacidad"])
        self.assertEqual(lines[-1], "Lo primero: se hace EXT-25; después, se hace EXT-05.")

    def test_red_then_yellow_failures_then_the_rest(self) -> None:
        findings = [
            finding("EXT-05", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.ALTA),
            finding("EXT-19", state=State.FALLA, colour=Colour.AMARILLO, priority=Priority.MEDIA),
            finding("EXT-07", state=State.FALLA, colour=Colour.ROJO, priority=Priority.ALTA),
        ]
        self.assertEqual(render_report.five_lines(findings)[-1], "Lo primero: se hace EXT-07; después, se hace EXT-19.")
        only_observations = [
            finding("EXT-05", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.ALTA),
            finding("EXT-17", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.ALTA),
        ]
        self.assertEqual(render_report.five_lines(only_observations)[-1], "Lo primero: se hace EXT-05; después, se hace EXT-17.")

    def test_hack_gate_first_action_is_the_hack_signal(self) -> None:
        hack = finding("EXT-24", state=State.FALLA, colour=Colour.AMARILLO, priority=Priority.CRITICA, found="Hay páginas ajenas")
        hack.hack_signal = True
        findings = [finding("EXT-07", state=State.FALLA, colour=Colour.ROJO, priority=Priority.ALTA), hack]
        self.assertEqual(render_report.five_lines(findings, hack_gate=True)[-1], "Lo primero: se hace EXT-24; después, se hace EXT-07.")


# ---------------------------------------------------------------------------
# a missing DMARC states delivery as a possibility, never as a fact
# ---------------------------------------------------------------------------


class DmarcDeliveryWordingTest(unittest.TestCase):
    def test_no_dmarc_is_conditional(self) -> None:
        site = mail_dns("colegio.test", txt=["v=spf1 include:_spf.google.com ~all"], dmarc=None, mx=GOOGLE_MX, dkim={"google": None})
        f = ev(mailauth.evaluate_ext05, make_obs(html_page(), dns=DnsBundle(site=site, control=CONTROL, control_ok=True)))
        self.assertEqual(f.state, State.FALLA)
        # Case 8 as worded: what the record lets Gmail and Outlook do; no delivery claim at all.
        self.assertEqual(
            f.phrase_report.consequence,
            "Se pueden enviar mails que parezcan del colegio y llegar, y los mails reales pueden caer más seguido en spam",
        )


# ---------------------------------------------------------------------------
# the VIS-13 green phrase fits every kind
# ---------------------------------------------------------------------------


class Vis13GreenTest(unittest.TestCase):
    def test_neutral_green_phrase(self) -> None:
        obs = make_obs(html_page(body=FORM_BODY), psi=psi_series(audits=form_audits(audit("label", 1))))
        for kind in ("empresa", "colegio"):
            f = ev(a11y.evaluate_vis13, obs, kind=kind)
            self.assertEqual(f.state, State.APROBADO)
            self.assertEqual(f.phrase_report.consequence, "Completar un formulario desde el celular no se traba")
            self.assertNotIn("inscripción", f.phrase_report.consequence)


# ---------------------------------------------------------------------------
# the control domain is never its own control
# ---------------------------------------------------------------------------


CTRL = "https://control.test"


def self_scenario() -> Scenario:
    home = small_home()
    page = home.replace(b"<h1>Colegio Ejemplo</h1>", b"<h1>Institucional</h1>")
    redirect = Route(301, [("Location", f"{CTRL}/")])
    return Scenario(
        name="self-check",
        routes={
            "http://control.test/": redirect,
            "http://www.control.test/": redirect,
            "https://www.control.test/": redirect,
            f"{CTRL}/": Route(200, list(HTML), home),
            f"{CTRL}/robots.txt": Route(200, [("Content-Type", "text/plain")], b"User-agent: *\nDisallow:\n"),
            f"{CTRL}/institucional/": Route(200, list(HTML), page),
            f"{CTRL}/contacto/": Route(200, list(HTML), page.replace(b"Institucional", b"Contacto")),
        },
    )


class SelfCheckTest(unittest.TestCase):

    def test_e2e_the_site_is_not_its_own_ttfb_control(self) -> None:
        r = run_e2e(self_scenario(), default_apis("control.test"), url=f"{CTRL}/", nombre="Control Ejemplo", kind=None)
        self.assertEqual(r.site_urls.count(f"{CTRL}/"), 3, "home load 1 and the two reloads, no control GET")
        lines = r.log_lines()
        self.assertEqual([line for line in lines if line["kind"] == "control"], [])
        ext20 = r.check("EXT-20")
        self.assertEqual(ext20["mediciones"]["control_samples"], [])
        self.assertEqual(ext20["estado"], "APROBADO")
        self.assertNotIn("sitio de control", r.files["informe.md"])
        site_lines = [line for line in lines if line["kind"] == "site"]
        # In test mode the TLS handshakes go to the fake API (/tls); in production they are "tls" lines.
        tls_lines = [line for line in lines if line["kind"] == "tls" or "/tls?host=" in line["url"]]
        self.assertEqual(len(site_lines), len(r.site_urls), "every GET the site received is a site request")
        self.assertEqual(len(tls_lines), 2)
        # Hand count: home + 2 reloads, 3 variants, robots.txt, 3 standard sitemap paths, interna, 1 link = 12; + 2 TLS.
        self.assertEqual(r.datos["meta"]["pedidos_sitio"], 14)

    def test_ext20_without_a_control(self) -> None:
        from test_checks_speed import ttfb

        fast = ttfb([300, 320, 310], [])
        fast.control_is_site = True
        f = ev(speed.evaluate_ext20, make_obs(html_page(), ttfb=fast))
        self.assertEqual((f.state, f.phrase_report.found), (State.APROBADO, "El servidor empieza a responder en 0,3 segundos"))
        slow = ttfb([1200, 1300, 1250], [])
        slow.control_is_site = True
        g = ev(speed.evaluate_ext20, make_obs(html_page(), ttfb=slow))
        self.assertEqual(
            (g.state, g.reason),
            (State.NO_VERIFICADO, "no hubo un sitio de control con qué comparar, porque el sitio medido es el de control"),
        )
        control = ev(speed.evaluate_ext20, make_obs(html_page(), ttfb=ttfb([1200, 1300, 1250], [])))
        self.assertEqual(control.reason, common.REASON_CONTROL_SLOW, "control: a normal run without control samples")

    def test_doh_answers_of_the_control_domain_are_reused(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as ev_dir:
            config = RunConfig(url=f"{BASE}/", test_loopback=site.loopback, test_services=apis.base)
            with patched_env(SITE_CHECK_TEST_API_KEY=TEST_KEY):
                services = build_services(config, ev_dir, sleeper=SleepRecorder())
                services.endpoints = dataclasses.replace(services.endpoints, control_domain="colegio.test")
                obs = collect(config, services)
            doh = [r for r in apis.requests if r.path in ("/resolve", "/dns-query")]
            txt = [r for r in doh if r.query.get("name") == ["colegio.test"] and r.query.get("type") == ["TXT"]]
            self.assertEqual(len(txt), 1, [r.raw_path for r in doh])
            self.assertIs(obs.dns.control, obs.dns.site)
            self.assertTrue(obs.dns.control_ok is False, "colegio.test has no DMARC: the reused answers fail the control")
            self.assertFalse(any("control.test" in r.raw_path for r in doh))


class HomeUnreachableTest(unittest.TestCase):

    def test_control_speed_alone_is_never_withheld(self) -> None:
        r = run_e2e(school_scenario(SchoolOptions(challenge=True)), default_apis())
        self.assertEqual(r.code, 3)
        self.assertEqual(r.check("EXT-08")["estado"], "FALLA")


# ---------------------------------------------------------------------------
# the keyless 429 reason is plain
# ---------------------------------------------------------------------------


class KeylessReasonTest(unittest.TestCase):
    def test_plain_reason_for_the_reader_and_detail_for_the_operator(self) -> None:
        r = run_e2e(school_scenario(), default_apis(psi_status=429), key="")
        informe = r.files["informe.md"]
        for word in ("cuota", "sin clave"):
            self.assertNotIn(word, informe, word)
        self.assertIn("○ No se pudo medir: la herramienta de velocidad de Google no dio resultados.", informe)
        self.assertEqual(r.datos["meta"]["corridas_psi"]["estado"], "sin-clave-cuota")
        ext08 = r.check("EXT-08")
        self.assertEqual(ext08["motivo"], "la herramienta de velocidad de Google no dio resultados")
        self.assertIn("429", ext08["nota_interna"])
        self.assertIn("sin clave", ext08["nota_interna"])


# ---------------------------------------------------------------------------
# KB figures round half up, like PageSpeed web
# ---------------------------------------------------------------------------


class WeightKbTest(unittest.TestCase):
    def test_half_up_unless_it_reads_the_limit(self) -> None:
        self.assertEqual(common.weight_vs_threshold(1_650_000, 1_638_400), ("1611 KB", "1600 KB", False))
        self.assertEqual(common.weight_vs_threshold(1_638_401, 1_638_400), ("1601 KB", "1600 KB", False))
        self.assertEqual(common.weight_vs_threshold(1_638_912, 1_638_400), ("1601 KB", "1600 KB", False))
        self.assertEqual(common.weight_vs_threshold(1_639_400, 1_638_400), ("1601 KB", "1600 KB", False))


# ---------------------------------------------------------------------------
# the VIS-13 grey reason says what was measured
# ---------------------------------------------------------------------------


class Vis13GreyTest(unittest.TestCase):
    def test_no_form_on_the_home(self) -> None:
        obs = make_obs(html_page(), psi=psi_series(audits=form_audits(audit("label", None, "notApplicable"))))
        f = ev(a11y.evaluate_vis13, obs)
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertEqual(f.reason, "la página principal no tiene formularios para revisar; los de otras páginas se revisan en navegador")
        self.assertNotIn("están en otras páginas", f.phrase_report.found)

    def test_truncated_home(self) -> None:
        obs = make_obs(html_page(), psi=psi_series(audits=form_audits(audit("label", None, "notApplicable"))))
        obs.home.response.truncated = True
        f = ev(a11y.evaluate_vis13, obs)
        self.assertEqual((f.state, f.reason), (State.NO_VERIFICADO, "la página principal llegó incompleta"))

    def test_e2e_school_grey_line(self) -> None:
        r = run_e2e(school_scenario(), default_apis())
        self.assertIn(
            "¿Los formularios se entienden y los botones se pueden tocar? La página principal no tiene formularios para "
            "revisar; los de otras páginas se revisan en navegador.",
            r.files["informe.md"],
        )
        self.assertNotIn("Los formularios están en otras páginas", r.files["informe.md"])


# ---------------------------------------------------------------------------
# a cut after the variants does not grey EXT-17
# ---------------------------------------------------------------------------


def variants(challenged: bool = False) -> list[VariantProbe]:
    out = [
        VariantProbe(start_url=u, statuses=[301, 200], urls=[u, f"{BASE}/"], final_url=f"{BASE}/", final_status=200, hops=1, reached_canonical=True)
        for u in ("http://colegio.test/", "http://www.colegio.test/", "https://colegio.test/")
    ]
    out.append(VariantProbe(start_url=f"{BASE}/", statuses=[200], urls=[f"{BASE}/"], final_url=f"{BASE}/", final_status=200, hops=0, reached_canonical=True))
    out[0].challenged = challenged
    return out


class Ext17AfterCutTest(unittest.TestCase):
    def test_variants_measured_before_the_cut_keep_their_state(self) -> None:
        cut = ev(security.evaluate_ext17, make_obs(html_page(), variants=variants(), blocked=True, block_cause="challenge"))
        self.assertEqual(cut.state, State.APROBADO)
        throttled = ev(security.evaluate_ext17, make_obs(html_page(), variants=variants(), blocked=True, block_cause="throttle"))
        self.assertEqual(throttled.state, State.APROBADO)

    def test_a_challenged_variant_still_greys(self) -> None:
        f = ev(security.evaluate_ext17, make_obs(html_page(), variants=variants(challenged=True), blocked=True))
        self.assertEqual((f.state, f.reason), (State.NO_VERIFICADO, "verificación anti-bot del hosting"))

    def test_skipped_variant_after_the_cut_greys(self) -> None:
        vs = variants()
        vs[1] = VariantProbe(start_url="http://www.colegio.test/", error="skipped:blocked")
        f = ev(security.evaluate_ext17, make_obs(html_page(), variants=vs, blocked=True, block_cause="throttle"))
        self.assertEqual((f.state, f.reason), (State.NO_VERIFICADO, "el sitio pidió bajar el ritmo"))

    def test_e2e_robots_challenged_after_the_variants(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/robots.txt"] = challenge_route()
        r = run_e2e(sc, default_apis())
        self.assertTrue(r.datos["meta"]["sitio_cortado"], "control: the host was cut")
        ext17 = r.check("EXT-17")
        self.assertEqual(ext17["estado"], "APROBADO")
        self.assertEqual(ext17["mediciones"]["variants"], 4)


if __name__ == "__main__":
    unittest.main()
