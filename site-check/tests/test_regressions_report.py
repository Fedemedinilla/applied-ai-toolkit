"""Regression tests of the report: the grey fold counts its bullets, manual checks
live only in the annex, VIS-09 says its denominator once, EXT-01 counts agree
with the state, speed wording carries the date, the next step's reason is a
FALLA, the same request is never sent twice, throttled 5xx are not the site's
fault, short bodies prove nothing. Numbers are written by hand, never computed
with the code under test.
"""

from __future__ import annotations

import datetime as dt
import re
import socket
import threading
import unittest
from pathlib import Path

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder

from sitecheck import gate, render_report, wpversions
from sitecheck.challenge import ChallengeDetector, Expect, Rule
from sitecheck.checks import common, linkcheck, mailauth, security, seo, speed, tables
from sitecheck.checks.header import GoogleSummary
from sitecheck.checks.tables import MailAuthTable, VelocityTable
from sitecheck.credentials import Redactor
from sitecheck.doh import DnsBundle
from sitecheck.endpoints import Endpoints
from sitecheck.httpclient import ClientConfig, HttpClient, LoopbackRoute
from sitecheck.model import Colour, Finding, Module, Priority, ReportPhrase, State
from sitecheck.requestlog import RequestLog
from sitecheck.scope import Purpose, ScopeGuard
from fakeapis import FakeApis
from fakesite import FakeSite, Route, Scenario
from fixhelp import HTML, control_route, run_e2e, small_home
from obsfactory import BASE, RUN_DATE, field, html_page, link_survey, make_ctx, make_obs, psi_series
from sitefixtures import default_apis, school_scenario
from test_checks_security import CONTROL, DKIM_OK, GOOGLE_MX, mail_dns
from test_checks_speed import ttfb

APEX = "https://colegio.test"


def ev(fn, obs, **ctx_kw):
    return fn(obs, make_ctx(obs, **ctx_kw))


def finding(cid: str, *, state: State = State.FALLA, colour: Colour = Colour.AZUL, priority: Priority = Priority.MEDIA,
            eligible: bool = True, found: str | None = None) -> Finding:
    return Finding(
        id=cid,
        name_plain=f"Nombre de {cid}",
        module=Module(cid.split("-")[0]),
        priority=priority,
        state=state,
        phrase_report=ReportPhrase(found or f"Se encontró {cid}", "Consecuencia", f"Se hace {cid}", "Quien mantiene el sitio"),
        evidence_ok=True,
        colour=colour,
        colour_derived=colour,
    )


def report_ctx(findings: list[Finding]) -> render_report.ReportContext:
    start = dt.datetime(2026, 10, 9, 14, 5, tzinfo=dt.timezone(dt.timedelta(hours=-3)))
    return render_report.ReportContext(
        institution="Colegio Ejemplo",
        domain="colegio.test",
        run_date=dt.date(2026, 10, 9),
        para="Dirección",
        started_local=start,
        finished_local=start + dt.timedelta(minutes=8),
        findings=findings,
        google_summary=GoogleSummary(reason="la herramienta de velocidad de Google no tiene cuota sin clave"),
        velocity=VelocityTable(intro="Medida en un celular, tres veces, con el valor del medio."),
        mail_auth=MailAuthTable(),
        hack_gate=False,
        n_site_requests=20,
        site_minutes=2,
    )


def _details_block(text: str, shape: str) -> tuple[int, list[str], int]:
    """(count in the summary, bullet lines inside the <details>, index after </details>)."""
    start = text.index(f"<details><summary>{shape} ")
    end = text.index("</details>", start)
    summary = text[start:text.index("</summary>", start)]
    count = int(re.search(r"(\d+)", summary).group(1))
    bullets = [line for line in text[start:end].splitlines() if line.startswith("- ")]
    return count, bullets, end


# ---------------------------------------------------------------------------
# The school run (shared by several findings)
# ---------------------------------------------------------------------------


class SchoolRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.r = run_e2e(school_scenario(), default_apis())
        cls.informe = cls.r.files["informe.md"]
        cls.anexo = cls.r.files["anexo-tecnico.md"]

    def test_manual_checks_only_in_the_annex(self) -> None:
        for manual in ("se revisa a mano", "se hace a mano", "se mira a mano", "se busca a mano", ", a mano", "site:", "transparencyreport", "check.spamhaus.org"):
            self.assertNotIn(manual, self.informe, manual)
        self.assertEqual(self.anexo.count("https://transparencyreport.google.com/safe-browsing/search?url=colegio.test"), 1)
        self.assertEqual(self.anexo.count("site:colegio.test viagra OR casino OR replica"), 1)
        lines = [line for line in self.informe.splitlines() if line.strip()]
        closing = lines.index("Eso solo se revisa con acceso autorizado al sitio.")
        self.assertEqual(lines[closing - 1], "- Archivos y base de datos.")

    def test_grey_count_equals_its_bullets(self) -> None:
        count, bullets, end = _details_block(self.informe, "○")
        self.assertEqual(count, len(bullets), bullets)
        headline = re.search(r"○ (\d+) que no se pudo|○ (\d+) que no se pudieron", self.informe)
        self.assertEqual(count, int(headline.group(1) or headline.group(2)))
        for fixed in ("- Usuarios y cuentas del panel.", "- Copias de seguridad y si restauran."):
            self.assertNotIn(fixed, bullets)
            self.assertGreater(self.informe.index(fixed), end, "the fixed items go outside the counted fold")
        self.assertIn("### Lo que solo se ve con acceso al sitio", self.informe)


    def test_vis09_one_sentence_one_denominator(self) -> None:
        found = self.r.check("VIS-09")["frase_informe_llena"]["que_se_encontro"]
        self.assertEqual(found, "Uno de los 8 enlaces revisados de la página principal lleva a una página que no existe; otro da más de una vuelta antes de llegar")

    def test_no_green_line_with_a_weak_count(self) -> None:
        ext01 = self.r.check("EXT-01")
        self.assertEqual(ext01["estado"], "APROBADO_CON_OBSERVACION")
        self.assertEqual(ext01["color_final"], "amarillo")
        green = self.informe[self.informe.index("## Lo que está bien"):self.informe.index("## Lo que no se pudo ver")]
        self.assertNotIn("de 6 protecciones", green)

    def test_no_zero_seconds_and_no_ese_dia_in_speed(self) -> None:
        self.assertNotIn("0,0 segundos", self.informe)
        velocity = self.informe[self.informe.index("## Velocidad"):self.informe.index("## Correo del dominio")]
        self.assertNotIn("ese día", velocity)
        self.assertIn("menos de una décima de segundo", velocity)


# ---------------------------------------------------------------------------
# the grey fold, unit level
# ---------------------------------------------------------------------------


class GreyFoldTest(unittest.TestCase):
    def test_count_matches_with_and_without_greys(self) -> None:
        grey = finding("EXT-13", state=State.NO_VERIFICADO, colour=Colour.GRIS, priority=Priority.ALTA, found="el registro del dominio no respondió")
        grey.name_plain = "¿El dominio está por vencer?"
        text = render_report.render_report(report_ctx([finding("VIS-04"), grey]))
        count, bullets, _ = _details_block(text, "○")
        self.assertEqual((count, bullets), (1, ["- ¿El dominio está por vencer? El registro del dominio no respondió."]))
        none = render_report.render_report(report_ctx([finding("VIS-04")]))
        self.assertIn("○ 0 cosas que no se pudieron ver en esta medición.", none)
        self.assertIn("- Usuarios y cuentas del panel.", none)

    def test_sitemap_search_goes_to_the_annex(self) -> None:
        from sitecheck.observations import RobotsFetch
        from sitecheck.robots import RobotsState
        from obsfactory import response

        resp = response(f"{BASE}/robots.txt", status=404, headers=[("Content-Type", "text/html")], body="<html>no</html>")
        robots = RobotsFetch(url=f"{BASE}/robots.txt", response=resp, state=RobotsState.NO_RESTRICTIONS_4XX, parsed=None)
        vis02 = ev(seo.evaluate_vis02, make_obs(html_page(), robots=robots))
        self.assertEqual(vis02.state, State.NO_VERIFICADO)
        self.assertEqual(vis02.phrase_report.found, "El sitio no publica el archivo robots.txt, así que el mapa del sitio no se buscó")
        vis02.colour = Colour.GRIS
        ctx = report_ctx([finding("VIS-04"), vis02])
        self.assertNotIn("a mano", render_report.render_report(ctx))
        self.assertEqual(render_report.render_annex(ctx).count("Mapa del sitio:"), 1)

    def test_annex_lists_each_manual_check_once(self) -> None:
        grey = finding("EXT-13", state=State.NO_VERIFICADO, colour=Colour.GRIS, priority=Priority.ALTA, found="el registro del dominio no respondió")
        ctx = report_ctx([finding("VIS-04"), grey])
        self.assertNotIn("lookup.icann.org", render_report.render_report(ctx))
        self.assertEqual(render_report.render_annex(ctx).count("Vencimiento del dominio: https://lookup.icann.org/"), 1)


# ---------------------------------------------------------------------------
# VIS-09 wording
# ---------------------------------------------------------------------------


class Vis09WordingTest(unittest.TestCase):
    def found(self, statuses: dict, **kw) -> str:
        return ev(linkcheck.evaluate_vis09, make_obs(html_page(), links=link_survey(statuses, **kw))).phrase_report.found

    def test_partial_survey_says_the_denominator_once(self) -> None:
        found = self.found({f"{BASE}/a/": 200, f"{BASE}/b/": 404, f"{BASE}/c/": None, f"{BASE}/d/": 200})
        self.assertEqual(found, "Un enlace de la página principal lleva a una página que no existe (se revisaron 3 de 4)")

    def test_greens(self) -> None:
        self.assertEqual(self.found({f"{BASE}/a/": 200, f"{BASE}/b/": 200}), "Los 2 enlaces revisados de la página principal llegan a su destino")
        self.assertEqual(self.found({f"{BASE}/a/": 200}), "El único enlace de la página principal llega a su destino")

    def test_two_broken_of_two(self) -> None:
        self.assertEqual(
            self.found({f"{BASE}/a/": 404, f"{BASE}/b/": 410}),
            "Los 2 enlaces revisados de la página principal llevan a páginas que no existen",
        )


# ---------------------------------------------------------------------------
# EXT-01 state and count agree
# ---------------------------------------------------------------------------


class Ext01CountTest(unittest.TestCase):
    def ext01(self, *headers: tuple[str, str]) -> Finding:
        obs = make_obs(html_page(), home_headers=[("Content-Type", "text/html; charset=UTF-8"), *headers])
        return ev(security.evaluate_ext01, obs)

    def test_two_of_six_is_an_observation(self) -> None:
        f = self.ext01(("Strict-Transport-Security", "max-age=31536000"), ("X-Content-Type-Options", "nosniff"))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(
            f.phrase_report.found,
            "El servidor activa 2 de las 6 protecciones que ofrecen los navegadores; la que obliga a usar la conexión segura está activa",
        )
        # the action names what is missing.
        self.assertEqual(
            f.phrase_report.action,
            "Agregar las 4 protecciones que faltan (la que impide mostrar el sitio dentro de otro, la que limita qué "
            "contenido carga la página, la que fija qué se comparte con otros sitios y la que limita los permisos del "
            "navegador) y probar que nada se rompa",
        )

    def test_six_of_six_is_green(self) -> None:
        f = self.ext01(
            ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
            ("X-Content-Type-Options", "nosniff"),
            ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'"),
            ("Referrer-Policy", "strict-origin-when-cross-origin"),
            ("Permissions-Policy", "camera=()"),
        )
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(f.phrase_report.found, "El servidor activa las 6 protecciones que ofrecen los navegadores")


# ---------------------------------------------------------------------------
# speed wording (date instead of "ese día", nothing reads "0,0 segundos")
# ---------------------------------------------------------------------------


class SpeedWordingTest(unittest.TestCase):
    def test_sub_tenth_times(self) -> None:
        obs = make_obs(html_page(), ttfb=ttfb([40, 35, 45], [30, 20, 25]))
        f = speed.evaluate_ext20(obs, make_ctx(obs))
        self.assertEqual(f.phrase_report.found, "El servidor empieza a responder en menos de una décima de segundo")
        table = tables.build_velocity_table({"EXT-20": f}, run_date=RUN_DATE)
        self.assertEqual(table.rows[3].value, "menos de una décima de segundo")
        self.assertEqual(
            table.rows[3].meaning,
            "Bien hasta 0,8 segundos; un sitio de control medido en el mismo momento dio menos de una décima de segundo",
        )
        obs = make_obs(html_page(), ttfb=ttfb([300, 320, 310], [250, 260, 240]))
        self.assertEqual(speed.evaluate_ext20(obs, make_ctx(obs)).phrase_report.found, "El servidor empieza a responder en 0,3 segundos")

    def test_dates_instead_of_ese_dia(self) -> None:
        f = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(status="sin-clave-cuota", reason=common.REASON_PSI_NO_KEY_QUOTA)))
        self.assertEqual(
            f.phrase_report.found,
            "no se pudo medir el 9/10/2026: la herramienta de velocidad de Google no dio resultados; se repite aparte",  #
        )
        self.assertEqual(tables.build_velocity_table({"EXT-08": f}, run_date=RUN_DATE).intro, "La medición de velocidad de Google no se pudo completar el 9/10/2026.")
        g = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(field=field(lcp=2000, inp=150, cls=0.05))))
        self.assertEqual(
            tables.build_velocity_table({"EXT-08": g}, run_date=RUN_DATE).intro,
            "Las tres primeras filas son de quienes visitaron la página principal desde un celular en los últimos 28 días, "
            "según Google; las otras dos se midieron el 9/10/2026.",
        )
        grey = finding("EXT-08", state=State.NO_VERIFICADO, colour=Colour.GRIS, priority=Priority.ALTA)
        text = render_report.render_report(report_ctx([finding("VIS-04"), grey]))
        self.assertIn("La medición de velocidad de Google no se pudo completar el 9/10/2026 y se repite aparte.", text)
        self.assertNotIn("ese día", text)
        self.assertNotIn("ese día", common.REASON_PSI_QUOTA)


# ---------------------------------------------------------------------------
# VIS-07 in plain words, an action per case
# ---------------------------------------------------------------------------


class Vis07WordingTest(unittest.TestCase):
    def vis07(self, head: str = "") -> Finding:
        return ev(seo.evaluate_vis07, make_obs(html_page(head)))

    def test_missing(self) -> None:
        f = self.vis07()
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.phrase_report.found, "La página principal no incluye los datos del colegio (nombre, dirección y contacto) en el formato que lee Google")
        self.assertEqual(f.phrase_report.action, "Agregar a la página principal los datos del colegio en el formato que lee Google")

    def test_inexact(self) -> None:
        f = self.vis07('<script type="application/ld+json">{"@type": "School", "name": </script>')
        self.assertEqual(f.phrase_report.found, "Los datos del colegio escritos en el formato que lee Google tienen errores")
        self.assertEqual(f.phrase_report.action, "Corregir esos datos y comprobarlos con la prueba de resultados enriquecidos de Google")

    def test_no_jargon_and_no_plugin(self) -> None:
        from sitecheck import registry

        self.assertNotIn("marcad", registry.get("VIS-07").name_plain)
        for head in ("", '<script type="application/ld+json">{"@type": "School", "name": </script>'):
            f = self.vis07(head)
            text = " ".join([f.phrase_report.found, f.phrase_report.consequence, f.phrase_report.action]).lower()
            self.assertNotIn("marca", text)
            self.assertNotIn("plugin", text)


# ---------------------------------------------------------------------------
# conditional consequence, next step from failures only
# ---------------------------------------------------------------------------


class NextStepTest(unittest.TestCase):
    def test_dkim_consequence_is_conditional(self) -> None:
        site = mail_dns("colegio.test", txt=["v=spf1 include:_spf.google.com ~all"], dmarc=["v=DMARC1; p=quarantine; rua=mailto:x@colegio.test"], mx=GOOGLE_MX, dkim={"google": None})
        f = ev(mailauth.evaluate_ext05, make_obs(html_page(), dns=DnsBundle(site=site, control=CONTROL, control_ok=True)))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(f.phrase_report.consequence, "Si los mensajes salen sin firma, algunos mails reales pueden caer en spam")
        self.assertIsNotNone(DKIM_OK)


    def test_red_failure_first_then_yellow_failure(self) -> None:
        findings = [
            finding("EXT-05", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.CRITICA, found="Una observación"),
            finding("EXT-19", colour=Colour.AMARILLO, priority=Priority.MEDIA, found="El servidor no guarda páginas listas"),
        ]
        self.assertEqual(render_report.next_step(findings, hack_gate=False), (render_report.STEP_FIX, "el servidor no guarda páginas listas"))
        findings.append(finding("EXT-07", colour=Colour.ROJO, priority=Priority.ALTA, found="La conexión segura vence mañana"))
        self.assertEqual(render_report.next_step(findings, hack_gate=False)[1], "la conexión segura vence mañana")

    def test_observations_never_give_the_reason(self) -> None:
        findings = [
            finding("EXT-05", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.ALTA, found="La firma no se pudo confirmar"),
            finding("EXT-17", state=State.APROBADO_CON_OBSERVACION, colour=Colour.AMARILLO, priority=Priority.ALTA, found="Da 2 vueltas"),
            finding("VIS-07", colour=Colour.AZUL, found="Faltan datos para Google"),
        ]
        self.assertEqual(render_report.next_step(findings, hack_gate=False), (render_report.STEP_FIX, "hay 2 puntos para revisar"))

    def test_only_blues_is_neutral(self) -> None:
        blues = [finding("VIS-04", found="Título largo"), finding("VIS-11", state=State.APROBADO_CON_OBSERVACION, found="Falta una descripción")]
        self.assertEqual(
            render_report.next_step(blues, hack_gate=False, kind="instituto"),
            ("Las mejoras opcionales, si el instituto quiere mejorar cómo se ve y se encuentra", "hay 2 mejoras opcionales"),
        )


# ---------------------------------------------------------------------------
# the same request is never sent twice in a run
# ---------------------------------------------------------------------------


def apex_scenario() -> Scenario:
    home = small_home()
    page = home.replace(b"<h1>Colegio Ejemplo</h1>", b"<h1>Institucional</h1>")
    routes = {
        "http://colegio.test/": Route(301, [("Location", f"{APEX}/")]),
        "http://www.colegio.test/": Route(301, [("Location", f"{BASE}/")]),
        f"{BASE}/": Route(301, [("Location", f"{APEX}/")]),
        f"{APEX}/": Route(200, list(HTML), home),
        "https://control.test/": control_route(),
        f"{APEX}/robots.txt": Route(200, [("Content-Type", "text/plain")], b"User-agent: *\nDisallow:\n"),
        f"{APEX}/institucional/": Route(200, list(HTML), page),
        f"{APEX}/contacto/": Route(200, list(HTML), page.replace(b"Institucional", b"Contacto")),
    }
    return Scenario(name="apex", routes=routes)


class SameRequestOnceTest(unittest.TestCase):
    def test_e2e_variant_hop_is_not_requested_again(self) -> None:
        r = run_e2e(apex_scenario(), default_apis(), url=f"{APEX}/")
        self.assertEqual(r.site_urls.count(f"{BASE}/"), 1, r.site_urls)
        logged = [line for line in r.log_lines() if line["url"] == f"{BASE}/"]
        self.assertEqual(len(logged), 1)
        site_lines = [line for line in r.log_lines() if line["kind"] == "site" and line["outcome"] == "ok"]
        site_requests = [u for u in r.site_urls if "control.test" not in u]
        self.assertEqual(len(site_lines), len(site_requests))
        # Hand count: home 1 + 2 reloads, 3 variant requests (http apex, http www, https www),
        # robots.txt, 3 standard sitemap paths, the interna, 1 link check = 12; plus 2 TLS handshakes.
        self.assertEqual(r.datos["meta"]["pedidos_sitio"], 14)

    def test_client_reuses_hops_and_finals(self) -> None:
        with FakeSite(apex_scenario()) as site, FakeApis(default_apis()) as apis:
            guard = ScopeGuard("colegio.test", f"{APEX}/", Endpoints.for_test(apis.base), test_loopback=True)
            guard.set_canonical(f"{APEX}/")
            redactor = Redactor([TEST_KEY])
            config = ClientConfig(pace_seconds=0.0, pace_jitter=0.0, loopback=LoopbackRoute(port=site.port))
            client = HttpClient(guard, RequestLog(None, redactor), ChallengeDetector(), redactor, config, sleeper=SleepRecorder())
            first = client.fetch("http://www.colegio.test/", purpose=Purpose.VARIANT, expect=Expect.HTML)
            self.assertEqual((first.status, len(first.redirects)), (200, 2))
            self.assertEqual(client.site_requests, 3)
            again = client.fetch(f"{BASE}/", purpose=Purpose.VARIANT, expect=Expect.HTML)
            self.assertEqual((again.status, len(again.redirects), again.final_url), (200, 1, f"{APEX}/"))
            self.assertEqual(client.site_requests, 3, "nothing new was sent")
            self.assertEqual(site.count(f"{BASE}/"), 1)
            client.fetch(f"{APEX}/", purpose=Purpose.HOME_RELOAD, expect=Expect.HTML)
            self.assertEqual(site.count(f"{APEX}/"), 2, "a reload is always sent")
            self.assertEqual(client.site_requests, 4)


# ---------------------------------------------------------------------------
# a 5xx that coincides with throttling is never a site fault
# ---------------------------------------------------------------------------


class ThrottledServerErrorsTest(unittest.TestCase):
    def test_e2e_503_without_retry_after(self) -> None:
        sc = school_scenario()
        plain503 = Route(503, [("Content-Type", "text/html")], b"<html><head><title>Service Unavailable</title></head><body>Service Unavailable</body></html>")
        for path in ("/niveles/inicial/", "/inscripciones/", "/contacto/", "/historia/"):
            sc.routes[BASE + path] = plain503
        r = run_e2e(sc, default_apis())
        self.assertTrue(r.datos["meta"]["sitio_cortado"])
        vis09 = r.check("VIS-09")
        self.assertEqual(vis09["mediciones"]["n5xx"], 0)
        self.assertNotEqual(vis09["estado"], "FALLA")
        self.assertNotIn("error del servidor", r.files["informe.md"])

    def test_first_503_is_flagged_when_the_second_confirms(self) -> None:
        sc = school_scenario()
        plain503 = Route(503, [("Content-Type", "text/html")], b"<html><body>Service Unavailable</body></html>")
        sc.routes.update({f"{BASE}/a/": plain503, f"{BASE}/b/": plain503})
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test(apis.base), test_loopback=True)
            guard.set_canonical(f"{BASE}/")
            guard.admit_linked([f"{BASE}/a/", f"{BASE}/b/"], purpose=Purpose.LINK_CHECK, source="t")
            redactor = Redactor([TEST_KEY])
            config = ClientConfig(pace_seconds=0.0, pace_jitter=0.0, loopback=LoopbackRoute(port=site.port))
            client = HttpClient(guard, RequestLog(None, redactor), ChallengeDetector(), redactor, config, sleeper=SleepRecorder())
            first = client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertIsNone(first.challenge)
            client.fetch(f"{BASE}/b/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue(client.blocked)
            self.assertTrue((first.challenge or "").startswith(Rule.THROTTLE.value + ":"))
            flagged = [e for e in client.challenge_events if e.action == "flagged-retroactively"]
            self.assertEqual([e.url for e in flagged], [f"{BASE}/a/"])

    def test_server_errors_in_a_cut_run_are_not_verified(self) -> None:
        obs = make_obs(html_page(), links=link_survey({f"{BASE}/a/": 200, f"{BASE}/b/": 200, f"{BASE}/c/": 502}), blocked=True, block_cause="throttle")
        f = ev(linkcheck.evaluate_vis09, obs)
        self.assertEqual(f.measured["n5xx"], 0)
        self.assertNotEqual(f.state, State.FALLA)
        control = ev(linkcheck.evaluate_vis09, make_obs(html_page(), links=link_survey({f"{BASE}/a/": 200, f"{BASE}/b/": 200, f"{BASE}/c/": 502})))
        self.assertEqual((control.state, control.measured["n5xx"]), (State.FALLA, 1), "control: a 502 in a calm run is a fault")

    def test_variant_503_while_throttled_is_not_a_broken_address(self) -> None:
        from sitecheck.challenge import ChallengeEvent
        from sitecheck.observations import VariantProbe

        def variants() -> list[VariantProbe]:
            ok = [VariantProbe(start_url=u, statuses=[301], final_url=f"{BASE}/", final_status=200, hops=1, reached_canonical=True)
                  for u in ("http://colegio.test/", "http://www.colegio.test/", "https://colegio.test/")]
            busy = VariantProbe(start_url=f"{BASE}/", statuses=[503], final_url="https://colegio.test/x", final_status=503, hops=0, reached_canonical=False)
            return ok + [busy]

        event = ChallengeEvent(seq=9, url=f"{BASE}/a/", rule=Rule.THROTTLE, marker="http-429", action="retry-after-wait")
        throttled = ev(security.evaluate_ext17, make_obs(html_page(), variants=variants(), challenge_events=[event]))
        self.assertEqual((throttled.state, throttled.reason), (State.NO_VERIFICADO, "el sitio pidió bajar el ritmo"))
        calm = ev(security.evaluate_ext17, make_obs(html_page(), variants=variants()))
        self.assertEqual(calm.state, State.FALLA, "control: the same 503 in a calm run is a broken address")

    def test_robots_503_in_a_cut_run_is_not_a_robots_error(self) -> None:
        from sitecheck.observations import RobotsFetch
        from sitecheck.robots import RobotsState
        from obsfactory import response

        def robots() -> RobotsFetch:
            resp = response(f"{BASE}/robots.txt", status=503, headers=[("Content-Type", "text/html")], body="<html>busy</html>")
            return RobotsFetch(url=f"{BASE}/robots.txt", response=resp, state=RobotsState.UNREACHABLE_5XX, parsed=None)

        cut = ev(seo.evaluate_vis01, make_obs(html_page(), robots=robots(), blocked=True, block_cause="throttle"))
        self.assertEqual((cut.state, cut.reason), (State.NO_VERIFICADO, "el sitio pidió bajar el ritmo"))
        calm = ev(seo.evaluate_vis01, make_obs(html_page(), robots=robots()))
        self.assertEqual(calm.state, State.APROBADO_CON_OBSERVACION, "control: a 503 in a calm run is reported")


# ---------------------------------------------------------------------------
# a body shorter than its Content-Length is truncated
# ---------------------------------------------------------------------------


class _ShortBody:
    """A local server that declares Content-Length 5000 and closes after 1512 bytes."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self) -> None:
        try:
            conn, _ = self.sock.accept()
        except OSError:
            return
        with conn:
            try:
                conn.recv(4096)
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5000\r\nConnection: close\r\n\r\n"
                    + b"<html><head>" + b"y" * 1500
                )
            except OSError:
                return

    def __enter__(self) -> "_ShortBody":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.sock.close()


class ShortBodyTest(unittest.TestCase):
    def test_short_body_is_truncated_and_fails_the_gate(self) -> None:
        with _ShortBody() as server:
            guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test("http://127.0.0.1:9"), test_loopback=True)
            cfg = ClientConfig(pace_seconds=0, pace_jitter=0, read_timeout=2.0, loopback=LoopbackRoute(port=server.port))
            client = HttpClient(guard, RequestLog(None, Redactor([])), ChallengeDetector(), Redactor([]), cfg, sleeper=SleepRecorder())
            resp = client.fetch(f"{BASE}/", purpose=Purpose.HOME, expect=Expect.HTML)
        self.assertEqual((resp.status, resp.error, len(resp.body)), (200, None, 1512))
        self.assertTrue(resp.truncated)
        check = gate.html_evidence_ok(resp, "www.colegio.test")
        self.assertFalse(check.ok)
        self.assertTrue(any("truncated" in p for p in check.problems), check.problems)

    def _home_scenario(self, home: bytes, declared: int | None) -> Scenario:
        redirect = Route(301, [("Location", f"{BASE}/")])
        return Scenario(
            name="short-home",
            routes={
                "http://colegio.test/": redirect,
                "https://colegio.test/": redirect,
                "http://www.colegio.test/": redirect,
                f"{BASE}/": Route(200, list(HTML), home, content_length=declared),
                "https://control.test/": control_route(),
                f"{BASE}/robots.txt": Route(200, [("Content-Type", "text/plain")], b"User-agent: *\nDisallow:\n"),
            },
        )

    def test_no_absence_finding_from_half_a_home(self) -> None:
        home = small_home(pad=60)
        complete = run_e2e(self._home_scenario(home, None), default_apis())
        self.assertEqual(complete.check("VIS-15")["estado"], "FALLA", "control: the complete page has no call button")
        short = run_e2e(self._home_scenario(home, len(home) + 4000), default_apis())
        for cid in ("VIS-15", "VIS-16", "VIS-04", "EXT-25"):
            self.assertNotIn(short.check(cid)["estado"], ("FALLA", "APROBADO", "APROBADO_CON_OBSERVACION"), cid)
        self.assertEqual(short.check("VIS-15")["motivo"], "la página principal llegó incompleta")


# ---------------------------------------------------------------------------
# one rule for the figures near a threshold
# ---------------------------------------------------------------------------


class ThresholdPrecisionTest(unittest.TestCase):
    def test_two_decimals_in_the_window(self) -> None:
        cases = {
            2501: "2,51", 2504: "2,51", 2505: "2,51", 2500.4: "2,51", 2514: "2,51", 2515: "2,52",
            2549: "2,55", 2550: "2,6", 2540: "2,54", 4830: "4,8", 2500: "2,5", 2460: "2,5",
        }
        for ms, text in cases.items():
            self.assertEqual(common.seconds_vs_threshold(ms, 2500), text, ms)
        self.assertEqual(common.seconds_vs_threshold(801, 800), "0,81")
        self.assertEqual(common.seconds_vs_threshold(201, 200), "0,21")
        self.assertEqual(common.seconds_vs_threshold(180, 200), "0,2")

    def test_inp_failure_uses_the_same_rule(self) -> None:
        f = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(field=field(lcp=2000, inp=201, cls=0.05))))
        self.assertIn("tarda 0,21 segundos en responder", f.phrase_report.found)
        table = tables.build_velocity_table({"EXT-08": f}, run_date=RUN_DATE)
        self.assertEqual(table.rows[1].value, "0,21 segundos")
        g = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(field=field(lcp=2000, inp=180, cls=0.05))))
        self.assertEqual(tables.build_velocity_table({"EXT-08": g}, run_date=RUN_DATE).rows[1].value, "0,2 segundos")


# ---------------------------------------------------------------------------
# WordPress branch dates verified against wordpress.org
# ---------------------------------------------------------------------------


class WordPressDatesTest(unittest.TestCase):
    def test_no_verify_marks_and_the_source_is_cited(self) -> None:
        source = (Path(wpversions.__file__)).read_text(encoding="utf-8")
        self.assertNotIn("VERIFY", source)
        self.assertIn("wordpress-versions-0-7-to-4-9", source)

    def test_dates_from_the_versions_page(self) -> None:
        # Copied by hand from wordpress.org/documentation/article/wordpress-versions-0-7-to-4-9/.
        expected = {
            "3.0": dt.date(2010, 6, 17), "3.1": dt.date(2011, 2, 23), "3.2": dt.date(2011, 7, 4), "3.3": dt.date(2011, 12, 12),
            "3.4": dt.date(2012, 6, 13), "3.5": dt.date(2012, 12, 11), "3.6": dt.date(2013, 8, 1), "3.7": dt.date(2013, 10, 24),
            "3.8": dt.date(2013, 12, 12), "3.9": dt.date(2014, 4, 16), "4.0": dt.date(2014, 9, 4), "4.1": dt.date(2014, 12, 17),
            "4.2": dt.date(2015, 4, 23), "4.3": dt.date(2015, 8, 18), "4.4": dt.date(2015, 12, 8), "4.5": dt.date(2016, 4, 12),
            "4.6": dt.date(2016, 8, 16), "4.7": dt.date(2016, 12, 6), "4.8": dt.date(2017, 6, 8), "4.9": dt.date(2017, 11, 15),
        }
        for branch, day in expected.items():
            self.assertEqual(wpversions.BRANCH_RELEASES[branch], day, branch)


if __name__ == "__main__":
    unittest.main()
