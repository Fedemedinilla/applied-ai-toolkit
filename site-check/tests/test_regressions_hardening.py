"""Regression tests of the hardening pass: wrapper homes (meta refresh, JS redirect,
frames, SPA shells), the hack-gate false positives, the exclusion list that
never fails open, privacy of broken-link addresses, TLS pinning and chains,
throttling, IDN domains and charset crashes.

Expected phrases are written by hand per case, and every case has a control that
shows the normal case is unchanged. Only ``*.test`` domains.
"""

from __future__ import annotations

import json
import unittest
from urllib.parse import quote

import support  # noqa: F401
from fakeapis import FakeApis, psi_payload
from fakesite import FakeSite, Route
from fixhelp import HTML, run_e2e
from obsfactory import BASE, HOME, html_page, make_ctx, make_obs, response
from sitefixtures import SchoolOptions, default_apis, school_scenario
from support import TEST_KEY, patched_env, run_cli, temp_dir
from test_checks_core import finding

from sitecheck import exclusions, gate, pipeline, registry
from sitecheck.checks import content
from sitecheck.model import Priority, State
from sitecheck.observations import SitemapFetch
from sitecheck.sitemapfeed import DocKind, SitemapDoc


def _sitemap(locs: list[str]) -> SitemapFetch:
    return SitemapFetch(url=f"{BASE}/page-sitemap.xml", declared=True, valid=True, doc=SitemapDoc(DocKind.URLSET, locs))


def clean_apis(domain: str = "colegio.test"):
    """Fast speed and a DMARC record: only the site findings are left to fail."""
    a = default_apis(domain)
    final_url = f"https://www.{domain}/"
    fast = dict(lab_lcp_ms=1800.0, field_lcp_ms=1800, field_inp_ms=120, field_cls_pct=2, total_bytes=900_000,
                image_bytes=300_000, scores=(0.92, 0.95, 0.96, 0.95))
    a.psi_mobile = [psi_payload(final_url, **fast) for _ in range(3)]
    a.psi_desktop = psi_payload(final_url, strategy="DESKTOP", **fast)
    a.zone[(f"_dmarc.{domain}", "TXT")] = ["v=DMARC1; p=quarantine; rua=mailto:dmarc@" + domain]
    return a


# ---------------------------------------------------------------------------
# hack gate false positives (EXT-24)
# ---------------------------------------------------------------------------


class HackGateFalsePositivesTest(unittest.TestCase):
    """A normal school must never trip the hack gate (exit 30 and the "check the site in depth" lead)."""

    def ext24(self, body: str, head: str = "", **obs_kw):
        obs = make_obs(html_page(head=head, body=body), **obs_kw)
        return content.evaluate_ext24(obs, make_ctx(obs))

    def assert_no_gate(self, f) -> None:
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertFalse(f.hack_signal)

    def test_news_card_linking_twice_to_a_government_page_about_gambling_prevention(self) -> None:
        card = (
            '<article class="news-card"><a href="https://www.gobierno.test/salud/prevencion-apuestas-online">'
            '<img src="/wp-content/uploads/charla.jpg" alt=""></a>'
            '<h3><a href="https://www.gobierno.test/salud/prevencion-apuestas-online">'
            "Guía para familias: prevención de apuestas online</a></h3></article>"
        )
        f = self.ext24(card)
        self.assert_no_gate(f)
        self.assertEqual(f.measured["outbound_spam_links"], 0)
        self.assertEqual(f.measured["terms"], [])

    def test_event_at_the_casino_central_with_a_map_link(self) -> None:
        note = (
            "<p>Acto de colación 2026 en el Casino Central.</p>"
            '<a href="https://www.diario.test/colacion-en-el-casino-central">Nota en el diario</a> '
            '<a href="https://maps.google.test/?q=Casino+Central+Mar+del+Plata">Cómo llegar</a>'
        )
        f = self.ext24(note)
        self.assert_no_gate(f)
        self.assertEqual(f.measured["outbound_spam_links"], 0)

    def test_a_student_named_loan_in_an_external_news_link(self) -> None:
        card = (
            '<article><a href="https://www.diario.test/educacion/loan-alumno-de-quinto-gano-la-olimpiada">'
            '<img src="/wp-content/uploads/olimpiada.jpg" alt=""></a>'
            '<h3><a href="https://www.diario.test/educacion/loan-alumno-de-quinto-gano-la-olimpiada">'
            "Loan, de quinto grado, ganó la Olimpíada de Matemática</a></h3></article>"
        )
        f = self.ext24(card)
        self.assert_no_gate(f)
        self.assertEqual(f.measured["terms"], [])
        self.assertNotIn("loan", content.WEAK_TERMS)

    def test_russian_section_with_cyrillic_slugs_in_the_sitemap(self) -> None:
        locs = [f"{BASE}/ru/{quote('о-школе')}/", f"{BASE}/ru/{quote('новости')}/", f"{BASE}/ru/{quote('контакты')}/", f"{BASE}/institucional/"]
        f = self.ext24("<p>Bienvenidos</p>", sitemaps=[_sitemap(locs)])
        self.assert_no_gate(f)
        self.assertEqual(f.measured["sitemap_foreign_urls"], 0)

    def test_japanese_section_with_japanese_slugs_in_the_sitemap(self) -> None:
        locs = [f"{BASE}/ja/{quote('学校案内')}/", f"{BASE}/ja/{quote('入学案内')}/", f"{BASE}/ja/{quote('日本語教育')}/", f"{BASE}/contacto/"]
        f = self.ext24("<p>Bienvenidos</p>", sitemaps=[_sitemap(locs)])
        self.assert_no_gate(f)
        self.assertEqual(f.measured["sitemap_foreign_urls"], 0)

    def test_language_declared_in_hreflang_is_a_translation(self) -> None:
        head = f'<link rel="alternate" hreflang="es-AR" href="{BASE}/"><link rel="alternate" hreflang="ru" href="{BASE}/russkij/">'
        locs = [f"{BASE}/{quote('школа')}/", f"{BASE}/{quote('новости')}/", f"{BASE}/{quote('контакты')}/"]
        f = self.ext24("<p>Bienvenidos</p>", head=head, sitemaps=[_sitemap(locs)])
        self.assert_no_gate(f)
        self.assertEqual(f.measured["sitemap_foreign_urls"], 0)

    def test_control_cyrillic_slugs_without_a_language_path_or_hreflang_still_fire(self) -> None:
        locs = [f"{BASE}/{quote('школа')}/", f"{BASE}/{quote('новости')}/", f"{BASE}/{quote('контакты')}/"]
        f = self.ext24("<p>Bienvenidos</p>", sitemaps=[_sitemap(locs)])
        self.assertEqual(f.state, State.FALLA)
        self.assertTrue(f.hack_signal)
        self.assertEqual(f.measured["sitemap_foreign_urls"], 3)

    def test_control_hreflang_of_another_language_does_not_cover_japanese_spam(self) -> None:
        head = f'<link rel="alternate" hreflang="ru" href="{BASE}/ru/">'
        locs = [f"{BASE}/{quote('激安通販')}-1/", f"{BASE}/{quote('ブランド財布')}/", f"{BASE}/{quote('格安時計店')}/"]
        f = self.ext24("<p>Hola</p>", head=head, sitemaps=[_sitemap(locs)])
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.measured["sitemap_foreign_urls"], 3)

    def test_control_injected_links_to_distinct_spam_hosts_still_fire(self) -> None:
        spam = (
            '<div style="display:none"><a href="https://casino-bonus.test/">bono</a> '
            '<a href="https://poker-room.test/mesa">jugar</a> '
            '<a href="https://www.cheap-pharmacy.test/">comprar</a></div>'
        )
        f = self.ext24(spam)
        self.assertEqual(f.state, State.FALLA)
        self.assertTrue(f.hack_signal)
        self.assertEqual(f.measured["outbound_spam_links"], 3)
        self.assertEqual(f.measured["terms"], ["casino", "poker", "pharmacy"])

    def test_control_glued_words_in_the_host_count(self) -> None:
        spam = '<a href="https://casinobonus.test/">x</a> <a href="https://bestpokerroom.test/">y</a>'
        f = self.ext24(spam)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.measured["outbound_spam_links"], 2)

    def test_many_anchors_to_one_spam_host_count_once(self) -> None:
        spam = '<a href="https://casino-bonus.test/a">a</a> <a href="https://casino-bonus.test/b">b</a> <a href="https://casino-bonus.test/c">c</a>'
        f = self.ext24(spam)
        self.assertEqual(f.measured["outbound_spam_links"], 1)
        self.assert_no_gate(f)

    def test_control_strong_terms_still_fire_anywhere(self) -> None:
        f = self.ext24('<a href="https://www.diario.test/viagra-barato">nota</a>')
        self.assertEqual(f.state, State.FALLA)
        locs = [f"{BASE}/ru/cheap-viagra/"]
        g = self.ext24("<p>Hola</p>", sitemaps=[_sitemap(locs)])
        self.assertEqual(g.state, State.FALLA, "a language path never hides a strong term")


# ---------------------------------------------------------------------------
# a wrapper is not the home
# ---------------------------------------------------------------------------

GA = (
    '<script async src="https://www.analitica.test/gtag/js?id=G-ABCDEF1234"></script>'
    "<script>window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}"
    "gtag('js', new Date());gtag('config', 'G-ABCDEF1234');</script>"
)
META_REFRESH_HOME = (
    '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">'
    '<title>Colegio Ejemplo</title><meta http-equiv="refresh" content="0; url=https://www.colegio.test/inicio/">'
    + GA * 3
    + "</head><body><!-- redireccion a la web nueva del colegio, no borrar este archivo --></body></html>"
)
JS_REDIRECT_HOME = (
    "<!DOCTYPE html><html><head><title>Colegio Ejemplo</title>" + GA * 3 + "</head><body>"
    '<script>window.location.replace("https://nuevo.colegio.test/");</script><p>Redirigiendo...</p></body></html>'
)
FRAMESET_HOME = (
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN"><html><head><meta charset="utf-8">'
    "<title>Colegio Ejemplo - Nivel Inicial, Primario y Secundario</title>"
    '<meta name="description" content="Colegio Ejemplo, educación inicial, primaria y secundaria en Buenos Aires.">'
    '</head><frameset rows="100%,*" border="0"><frame name="main" src="https://sitios.test/view/colegioejemplo/inicio">'
    '<noframes><body><p>Su navegador no soporta marcos. Visite <a href="https://sitios.test/view/colegioejemplo/inicio">'
    "el sitio del colegio</a>.</p></body></noframes></frameset></html>"
)
IFRAME_HOME = (
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Colegio Ejemplo</title>' + GA * 3 + "</head>"
    '<body style="margin:0"><iframe src="https://www.colegio-nuevo.test/" style="width:100%;height:100%;border:0">'
    "</iframe></body></html>"
)
SPA_HOME = (
    '<!doctype html><html lang="es"><head><meta charset="UTF-8"><title>Colegio Ejemplo | Nivel inicial, primario y '
    'secundario</title><meta name="description" content="Colegio Ejemplo en Buenos Aires: nivel inicial, primario y '
    'secundario, jornada completa e inglés intensivo."><meta property="og:title" content="Colegio Ejemplo">'
    '<script type="module" crossorigin src="/assets/index-DkF3a9xQ.js"></script>'
    '<link rel="stylesheet" crossorigin href="/assets/index-B2c7LmQe.css"></head>'
    '<body><div id="root"></div><noscript>Necesita activar JavaScript para ver este sitio.</noscript></body></html>'
)


class WrapperDetectionTest(unittest.TestCase):
    def wrapper(self, body: str):
        return gate.home_wrapper(response(HOME, body=body), "www.colegio.test")

    def test_meta_refresh(self) -> None:
        w = self.wrapper(META_REFRESH_HOME)
        self.assertEqual((w.kind, w.target, w.delay), ("meta-refresh", "https://www.colegio.test/inicio/", 0.0))

    def test_javascript_redirect(self) -> None:
        w = self.wrapper(JS_REDIRECT_HOME)
        self.assertEqual((w.kind, w.target), ("js-redirect", "https://nuevo.colegio.test/"))

    def test_frameset(self) -> None:
        w = self.wrapper(FRAMESET_HOME)
        self.assertEqual((w.kind, w.target), ("frameset", "https://sitios.test/view/colegioejemplo/inicio"))

    def test_single_full_page_iframe(self) -> None:
        w = self.wrapper(IFRAME_HOME)
        self.assertEqual((w.kind, w.target), ("iframe", "https://www.colegio-nuevo.test/"))

    def test_spa_shell(self) -> None:
        w = self.wrapper(SPA_HOME)
        self.assertEqual((w.kind, w.target, w.text_chars), ("spa-shell", None, 0))

    def test_control_a_normal_home_is_not_a_wrapper(self) -> None:
        self.assertIsNone(self.wrapper(html_page(body='<nav><a href="/institucional/">Institucional</a></nav>')))

    def test_control_refresh_without_address_or_slow_is_a_page(self) -> None:
        reload_ = html_page(head='<meta http-equiv="refresh" content="300">', body="<p>Noticias</p>")
        self.assertIsNone(self.wrapper(reload_), "an auto-reload is not a redirect")
        slow = html_page(head='<meta http-equiv="refresh" content="30; url=/inicio/">', body="<p>Noticias</p>")
        self.assertIsNone(self.wrapper(slow), "30 s is above the 10 s limit")
        itself = html_page(head=f'<meta http-equiv="refresh" content="5; url={HOME}">', body="<p>Noticias</p>")
        self.assertIsNone(self.wrapper(itself), "a refresh to the same page is a reload")

    def test_control_a_full_home_with_a_script_redirect_branch_and_a_map(self) -> None:
        body = (
            '<script>if (navigator.language === "en") { location.href = "/en/"; }</script>'
            '<iframe src="https://mapas.test/embed?q=colegio" width="100%" height="450"></iframe>'
        )
        self.assertIsNone(self.wrapper(html_page(body=body)), "plenty of text: a page, not a wrapper")

    def test_control_small_page_with_links_to_the_site_is_not_an_spa_shell(self) -> None:
        small = '<html><head><title>Colegio</title></head><body><a href="/contacto/">Contacto</a></body></html>'
        self.assertIsNone(self.wrapper(small))

    def test_control_unclosed_head_does_not_hide_the_body(self) -> None:
        text = "Texto del colegio para las familias sobre niveles y horarios. " * 5
        page = f"<html><head><title>Colegio</title><body><p>{text}</p></body></html>"
        self.assertIsNone(self.wrapper(page))


class WrapperGateTest(unittest.TestCase):
    def test_html_failure_on_a_wrapper_turns_grey(self) -> None:
        for body in (META_REFRESH_HOME, JS_REDIRECT_HOME, FRAMESET_HOME, IFRAME_HOME, SPA_HOME):
            obs = make_obs(body)
            f = finding("VIS-15", State.FALLA, Priority.BAJA, evidence=["home.html"], )
            gate.apply_gate([f], registry.by_id(), obs, {"home.html": True})
            self.assertEqual(f.state, State.NO_VERIFICADO, body[:60])
            self.assertEqual(
                f.reason, "la página principal no trae el contenido que ve el visitante (lo carga aparte o lleva a otra dirección)"
            )

    def test_control_html_failure_on_a_normal_home_stays(self) -> None:
        obs = make_obs(html_page(body='<nav><a href="/institucional/">Institucional</a></nav>'))
        f = finding("VIS-15", State.FALLA, Priority.BAJA, evidence=["home.html"], )
        gate.apply_gate([f], registry.by_id(), obs, {"home.html": True})
        self.assertEqual(f.state, State.FALLA)


class WrapperReasonTest(unittest.TestCase):
    """The Spanish reason for the operator: what the home is and what to measure instead."""

    def texts(self, kind: str, target: str | None, chars: int = 0):
        return pipeline._wrapper_texts(gate.HomeWrapper(kind, target, 0.0, chars), "colegio.test")

    def test_same_site_with_a_path(self) -> None:
        reason, todo = self.texts("meta-refresh", "https://www.colegio.test/inicio/")
        self.assertEqual(
            reason,
            "la página principal redirige a https://www.colegio.test/inicio/ con una etiqueta meta refresh; la "
            "herramienta mide solo páginas principales sin ruta (como https://www.colegio.test/), así que esa "
            "dirección se revisa en un navegador",
        )
        self.assertEqual(
            todo,
            "Check https://www.colegio.test/inicio/ in a browser. This run describes only the page in between: do not "
            "hand out this report.",
        )

    def test_same_site_root_is_measured(self) -> None:
        reason, todo = self.texts("js-redirect", "https://nuevo.colegio.test/")
        self.assertEqual(reason, "la página principal redirige a https://nuevo.colegio.test/ con un script; hay que volver a medir con esa dirección")
        self.assertEqual(
            todo,
            "Measure again with https://nuevo.colegio.test/, the page the visitor sees. This run describes only the page "
            "in between: do not hand out this report.",
        )

    def test_frame_of_another_domain_with_a_path(self) -> None:
        reason, _ = self.texts("frameset", "https://sitios.test/view/colegioejemplo/inicio")
        self.assertEqual(
            reason,
            "la página principal muestra https://sitios.test/view/colegioejemplo/inicio dentro de un marco (frameset); "
            "es otro dominio, y la herramienta mide solo páginas principales sin ruta (como https://sitios.test/), así "
            "que esa dirección se revisa en un navegador",
        )

    def test_iframe_of_another_domain_root(self) -> None:
        reason, _ = self.texts("iframe", "https://www.colegio-nuevo.test/")
        self.assertEqual(
            reason,
            "la página principal muestra https://www.colegio-nuevo.test/ dentro de un marco (iframe); es otro dominio; "
            "hay que volver a medir con esa dirección",
        )

    def test_spa_shell(self) -> None:
        reason, todo = self.texts("spa-shell", None, 12)
        self.assertEqual(
            reason,
            "la página principal llega casi vacía (12 caracteres de texto y ningún enlace al sitio): el contenido lo "
            "arma un programa en el navegador y esta medición no lo ejecuta; el sitio se revisa en un navegador",
        )
        self.assertEqual(
            todo,
            "Check the site in a browser. This run describes only what arrives before the browser builds the page: do "
            "not hand out this report.",
        )


class WrapperRunTest(unittest.TestCase):
    """The whole run on a wrapper home: the reason reaches the console and datos.json."""

    def test_control_normal_home_measures(self) -> None:
        r = run_e2e(school_scenario(), default_apis())
        self.assertEqual(r.code, 0)
        self.assertIsNone(r.datos["meta"]["portada_envoltorio"])

    def test_rerender_keeps_the_wrapper_reason(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/"] = Route(200, list(HTML), META_REFRESH_HOME.encode("utf-8"))
        with temp_dir() as salidas, FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            argv = ["https://www.colegio.test/", "--name", "Colegio Ejemplo", "--out", str(salidas),
                    "--test-loopback", site.loopback, "--test-services", apis.base]
            with patched_env(SITE_CHECK_TEST_API_KEY=TEST_KEY, PAGESPEED_API_KEY=None):
                code, _, _ = run_cli(argv)
            self.assertEqual(code, 0)
            rd = next(p for p in (salidas / "colegio.test").iterdir() if p.is_dir())
            before = json.loads((rd / "datos.json").read_text(encoding="utf-8"))["meta"]["portada_envoltorio"]
            self.assertEqual(before["tipo"], "meta-refresh")
            code2, _, err = run_cli(["--rerender", str(rd / "datos.json"), "--out", str(salidas)])
            self.assertEqual(code2, 0, err)
            after = json.loads((rd / "datos.json").read_text(encoding="utf-8"))["meta"]["portada_envoltorio"]
            self.assertEqual(after, before)


# ---------------------------------------------------------------------------
# The exclusion list never fails open
# ---------------------------------------------------------------------------


class ExclusionReadingTest(unittest.TestCase):
    def load_bytes(self, data: bytes) -> exclusions.ExclusionList:
        with temp_dir() as folder:
            path = folder / "exclude.txt"
            path.write_bytes(data)
            return exclusions.load([path])

    def test_utf16_with_bom_as_powershell_writes_it(self) -> None:
        data = "﻿colegio.test\r\notro.test\r\n".encode("utf-16-le")
        self.assertEqual(data[:2], b"\xff\xfe")
        lst = self.load_bytes(data)
        self.assertEqual(lst.entries, ["colegio.test", "otro.test"])
        self.assertEqual(lst.problems, [])

    def test_utf16_appended_to_a_utf8_file_by_powershell(self) -> None:
        data = "# bajas\ncolegio.test\n".encode("utf-8") + "otro.test\r\n".encode("utf-16-le")
        lst = self.load_bytes(data)
        self.assertEqual(lst.entries, ["colegio.test", "otro.test"])
        self.assertEqual(lst.problems, [])

    def test_utf8_with_bom(self) -> None:
        lst = self.load_bytes("﻿colegio.test\n".encode("utf-8"))
        self.assertEqual(lst.entries, ["colegio.test"])

    def test_text_after_the_domain_and_a_pasted_address(self) -> None:
        text = (
            "colegio.test (pidió la baja 10/10)\n"
            "otro.test # nota\n"
            "Rectoría <direccion@tercero.test>\n"
            "*.cuarto.test\n"
        )
        lst = self.load_bytes(text.encode("utf-8"))
        self.assertEqual(lst.entries, ["colegio.test", "otro.test", "tercero.test", "cuarto.test"])
        self.assertEqual(lst.problems, [])
        self.assertEqual(lst.match("https://www.tercero.test/"), "tercero.test")

    def test_unreadable_lines_are_problems_with_their_number(self) -> None:
        # Line 3 must be a free mail service, so the domain stays gmail.com. Gmail usernames
        # cannot contain a hyphen, so this address cannot belong to anyone.
        text = "colegio.test\nesta línea no es un dominio\nRectoría <rectoria-ficticia@gmail.com>\n\n# nota\n"
        lst = self.load_bytes(text.encode("utf-8"))
        self.assertEqual(lst.entries, ["colegio.test"])
        self.assertEqual([(n, p) for _, n, p in lst.problems], [(2, "not-a-domain"), (3, "free-mail")])

    def test_control_plain_list(self) -> None:
        lst = self.load_bytes(b"# bajas\ncolegio.test\nhttps://www.otro.test/inicio\n")
        self.assertEqual(lst.entries, ["colegio.test", "otro.test"])
        self.assertEqual(lst.problems, [])


class ExclusionRunTest(unittest.TestCase):
    def test_an_unreadable_line_stops_the_run_before_any_request(self) -> None:
        r = run_e2e(school_scenario(), default_apis(), exclude="# bajas\notro.test\nesta línea no es un dominio\n")
        self.assertEqual(r.code, 2)
        self.assertEqual((r.site_urls, r.api_paths, r.folder), ([], [], None))
        self.assertIn("line 3", r.err)
        self.assertIn("No request was made.", r.err)

    def test_a_utf16_list_blocks_the_domain(self) -> None:
        with temp_dir() as salidas, FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            (salidas / "exclude.txt").write_bytes("﻿colegio.test\r\n".encode("utf-16-le"))
            argv = ["https://www.colegio.test/", "--name", "Colegio Ejemplo", "--out", str(salidas),
                    "--test-loopback", site.loopback, "--test-services", apis.base]
            with patched_env(SITE_CHECK_TEST_API_KEY=TEST_KEY, PAGESPEED_API_KEY=None):
                code, _, _ = run_cli(argv)
            self.assertEqual(code, 10)
            self.assertEqual((site.requested_urls(), list(apis.requests)), ([], []))


class Vis09PrivacyTest(unittest.TestCase):
    URLS = [f"{BASE}/institucional/", f"{BASE}/niveles/", f"{BASE}/equipo/prof-maria-gomez/"]

    def vis09(self, statuses: dict[str, int]):
        from sitecheck.checks import linkcheck
        from sitecheck.links import LinkSelection
        from obsfactory import link_survey

        obs = make_obs(html_page(body="".join(f'<a href="{u}">x</a>' for u in statuses)))
        obs.links = link_survey(statuses)
        obs.links.selection = LinkSelection(selected=list(statuses), total_candidates=len(statuses))
        return linkcheck.evaluate_vis09(obs, make_ctx(obs))

    def test_the_report_sentence_has_no_path(self) -> None:
        f = self.vis09({self.URLS[0]: 200, self.URLS[1]: 200, self.URLS[2]: 404})
        self.assertEqual(f.measured["broken_addresses"], ["www.colegio.test/equipo/prof-maria-gomez/"])

    def test_the_annex_lists_the_address(self) -> None:
        from sitecheck import render_report
        from test_regressions_report import report_ctx

        f = self.vis09({self.URLS[0]: 200, self.URLS[1]: 200, self.URLS[2]: 404})
        annex = render_report.render_annex(report_ctx([f]))
        self.assertIn(
            "## Enlaces de la página principal que llevan a páginas que no existen\n\n"
            "- www.colegio.test/equipo/prof-maria-gomez/\n",
            annex,
        )

    def test_control_no_broken_link_no_annex_section(self) -> None:
        from sitecheck import render_report
        from test_regressions_report import report_ctx

        f = self.vis09({self.URLS[0]: 200, self.URLS[1]: 200})
        self.assertEqual(f.state, State.APROBADO)
        self.assertNotIn("que llevan a páginas que no existen", render_report.render_annex(report_ctx([f])))


# ---------------------------------------------------------------------------
# the e-mail masking is linear
# ---------------------------------------------------------------------------


class EmailMaskSpeedTest(unittest.TestCase):
    SVG = "%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E" + "%3Cpath%20d%3D%22M0%200h10v10H0z%22%2F%3E" * 1300

    def test_a_50_kib_percent_encoded_string_masks_in_well_under_a_second(self) -> None:
        import time

        from sitecheck import artifacts

        self.assertGreater(len(self.SVG), 50 * 1024)
        start = time.perf_counter()
        out = artifacts.mask_personal_data(self.SVG)
        elapsed = time.perf_counter() - start
        self.assertLess(elapsed, 0.5)
        self.assertEqual(out, self.SVG, "nothing to mask in it")

    def test_control_the_usual_addresses_are_still_masked(self) -> None:
        from sitecheck import artifacts, outputs

        sample = (
            'Escríbanos a secretaria@colegio.test o a info%40colegio.test, <a href="mailto:dir.general+web@colegio.test">'
            "x</a> admin&#64;colegio.test"
        )
        counts: dict[str, int] = {}
        self.assertEqual(
            artifacts.mask_personal_data(sample, counts),
            'Escríbanos a [correo] o a [correo], <a href="mailto:[correo]">x</a> [correo]',
        )
        self.assertEqual(counts["correo"], 4)
        self.assertEqual(outputs.EMAIL_RE.findall("a secretaria@colegio.test y b.c+d@otro.test."), ["secretaria@colegio.test", "b.c+d@otro.test"])


# ---------------------------------------------------------------------------
# the TLS probe pins public addresses
# ---------------------------------------------------------------------------


class TlsPinningTest(unittest.TestCase):
    HOST = "www.colegio.test"

    def prober(self, answers: list[str]):
        from sitecheck.challenge import ChallengeDetector
        from sitecheck.credentials import Redactor
        from sitecheck.endpoints import Endpoints
        from sitecheck.httpclient import ClientConfig, HttpClient
        from sitecheck.requestlog import RequestLog
        from sitecheck.scope import ScopeGuard
        from sitecheck.tlsprobe import TlsProber

        self.tried: list[tuple[str, int]] = []

        def resolver(host: str, port: int) -> list[str]:
            return list(answers)

        def connector(address, timeout=None):  # type: ignore[no-untyped-def]
            self.tried.append(address)
            raise ConnectionRefusedError("fake: nothing listens")

        guard = ScopeGuard("colegio.test", f"https://{self.HOST}/", Endpoints())
        guard.set_canonical(f"https://{self.HOST}/")
        self.log = RequestLog(None, Redactor([]))
        http = HttpClient(guard, self.log, ChallengeDetector(), Redactor([]), ClientConfig(pace_seconds=0, pace_jitter=0),
                          resolver=resolver)
        return TlsProber(guard, http, self.log, connector=connector)

    def test_only_the_public_address_is_tried(self) -> None:
        result = self.prober(["10.0.0.5", "1.2.3.4"]).probe(self.HOST, 443)
        self.assertEqual(self.tried, [("1.2.3.4", 443)])
        self.assertEqual(result.error, "refused")

    def test_only_loopback_is_never_connected(self) -> None:
        result = self.prober(["127.0.0.1"]).probe(self.HOST, 443)
        self.assertEqual(self.tried, [])
        self.assertEqual(result.error, "blocked-address")

    def test_control_public_addresses_are_tried_in_order(self) -> None:
        self.prober(["1.2.3.4", "5.6.7.8"]).probe(self.HOST, 443)
        self.assertEqual(self.tried, [("1.2.3.4", 443), ("5.6.7.8", 443)])

    def test_the_prober_uses_the_http_clients_resolver_by_default(self) -> None:
        from sitecheck.tlsprobe import TlsProber

        prober = self.prober([])
        self.assertIs(TlsProber(prober._guard, prober._http, self.log)._resolver, prober._http.resolver)


# ---------------------------------------------------------------------------
# no screenshots of the home in the PageSpeed evidence
# ---------------------------------------------------------------------------

PIXEL = "data:image/jpeg;base64," + "QUJD" * 2000


def with_screenshots(payload: dict) -> dict:
    lh = payload["lighthouseResult"]
    lh["audits"]["final-screenshot"] = {"id": "final-screenshot", "details": {"type": "screenshot", "data": PIXEL}}
    lh["audits"]["screenshot-thumbnails"] = {"id": "screenshot-thumbnails", "details": {"items": [{"timing": 300, "data": PIXEL}]}}
    lh["audits"]["full-page-screenshot"] = {"id": "full-page-screenshot", "details": {"screenshot": {"data": PIXEL}}}
    lh["fullPageScreenshot"] = {"screenshot": {"data": PIXEL, "width": 412, "height": 3000}, "nodes": {}}
    lh["audits"]["largest-contentful-paint-element"] = {"id": "largest-contentful-paint-element", "details": {"items": [{"thumbnail": PIXEL, "node": {"snippet": "<img>"}}]}}
    return payload


class PsiScreenshotTest(unittest.TestCase):
    def test_strip_removes_every_picture_and_keeps_the_rest(self) -> None:
        from sitecheck import psi

        data = with_screenshots(psi_payload("https://www.colegio.test/"))
        out = psi.strip_screenshots(data)
        lh = out["lighthouseResult"]
        self.assertNotIn("data:image", json.dumps(out))
        for audit in ("final-screenshot", "screenshot-thumbnails", "full-page-screenshot"):
            self.assertNotIn(audit, lh["audits"])
        self.assertNotIn("fullPageScreenshot", lh)
        self.assertEqual(lh["audits"]["largest-contentful-paint-element"]["details"]["items"][0]["thumbnail"], "[captura quitada]")
        # Control: what the tool reads is unchanged, and the original is not modified.
        self.assertEqual(lh["audits"]["largest-contentful-paint"], data["lighthouseResult"]["audits"]["largest-contentful-paint"])
        self.assertIn("final-screenshot", data["lighthouseResult"]["audits"])

    def test_the_stored_evidence_has_no_screenshot(self) -> None:
        a = clean_apis()
        a.psi_mobile = [with_screenshots(p) for p in a.psi_mobile]
        a.psi_desktop = with_screenshots(a.psi_desktop)
        r = run_e2e(school_scenario(), a)
        for name in ("psi-mobile-1.json", "psi-mobile-2.json", "psi-mobile-3.json", "psi-desktop.json"):
            stored = r.evidence[name].decode("utf-8")
            self.assertNotIn("data:image", stored, name)
            self.assertNotIn('"final-screenshot"', stored, name)
            self.assertIn('"largest-contentful-paint"', stored, name)
            self.assertLess(len(stored), 20_000, name)
        self.assertEqual(r.check("EXT-08")["estado"], "APROBADO", "control: the speed is still read")


# ---------------------------------------------------------------------------
# a rejected PageSpeed key is said
# ---------------------------------------------------------------------------

KEY_NOTE = "PageSpeed rechazó la clave: revisar que la API esté habilitada y la restricción de la clave"


class PsiKeyRejectedTest(unittest.TestCase):
    def run_with(self, status: int, message: str, reason: str):
        a = default_apis()
        a.psi_status = status
        a.psi_error = {"error": {"code": status, "message": message, "status": reason}}
        return run_e2e(school_scenario(), a)

    def test_api_not_enabled_403(self) -> None:
        r = self.run_with(403, "PageSpeed Insights API has not been used in project 123 before or it is disabled.", "PERMISSION_DENIED")
        self.assertIn(f"Note: {KEY_NOTE}", r.out)
        self.assertEqual(r.datos["meta"]["aviso_pagespeed"], KEY_NOTE)
        self.assertEqual(r.datos["meta"]["corridas_psi"]["estado"], "clave-rechazada")
        self.assertEqual(r.check("EXT-08")["estado"], "NO_VERIFICADO")
        self.assertEqual(r.check("EXT-08")["nota_interna"], KEY_NOTE)
        self.assertEqual(len([p for p in r.api_paths if p.endswith("runPagespeed")]), 1, "the series stops at the rejection")

    def test_invalid_key_400(self) -> None:
        r = self.run_with(400, "API key not valid. Please pass a valid API key.", "INVALID_ARGUMENT")
        self.assertEqual(r.datos["meta"]["aviso_pagespeed"], KEY_NOTE)

    def test_control_a_400_about_the_url_is_not_the_key(self) -> None:
        r = self.run_with(400, "Lighthouse returned error: the URL is invalid.", "INVALID_ARGUMENT")
        self.assertIsNone(r.datos["meta"]["aviso_pagespeed"])
        self.assertNotIn("rechazó la clave", r.out)

    def test_control_the_quota_429_is_not_the_key(self) -> None:
        r = run_e2e(school_scenario(), default_apis(psi_status=429))
        self.assertIsNone(r.datos["meta"]["aviso_pagespeed"])
        self.assertEqual(r.datos["meta"]["corridas_psi"]["estado"], "cuota")


class MidRunCutTest(unittest.TestCase):
    CUT = (
        "La medición del sitio se cortó a mitad de camino (la verificación anti-bot del hosting): quedaron en gris "
        "por eso VIS-06, VIS-01, VIS-02 y VIS-09."
    )


    def test_control_an_uncut_run_says_nothing(self) -> None:
        r = run_e2e(school_scenario(), default_apis())
        self.assertFalse(r.datos["meta"]["sitio_cortado"])
        self.assertNotIn("se cortó", r.out)

    def test_the_note_by_hand(self) -> None:
        f1 = finding("VIS-09", State.NO_VERIFICADO, Priority.MEDIA, reason="el sitio pidió bajar el ritmo")
        f2 = finding("VIS-04", State.FALLA, Priority.MEDIA)
        self.assertEqual(
            pipeline._cut_note(True, [f1, f2]),
            "La medición del sitio se cortó a mitad de camino (el sitio pidió bajar el ritmo): quedaron en gris por eso VIS-09.",
        )
        self.assertEqual(
            pipeline._cut_note(True, [f2], throttle=False),
            "La medición del sitio se cortó a mitad de camino (la verificación anti-bot del hosting); ningún chequeo "
            "quedó en gris por eso.",
        )
        self.assertIsNone(pipeline._cut_note(False, [f1, f2]))


# ---------------------------------------------------------------------------
# http:// that redirects to an https:// with an invalid certificate
# ---------------------------------------------------------------------------


class HttpToBadTlsTest(unittest.TestCase):
    def run_expired(self, url: str):
        from unittest import mock

        from sitefixtures import tls_fixture

        from sitecheck.httpclient import HttpClient, _Exchange

        original = HttpClient._exchange

        def fake(self, method, target, *args, **kwargs):  # type: ignore[no-untyped-def]
            if target.startswith(f"{BASE}/"):
                return _Exchange(error="tls:10", ms=1.0)  # the https:// site fails the verification
            return original(self, method, target, *args, **kwargs)

        apis = clean_apis()
        expired = tls_fixture("www.colegio.test", days_from_now=-3)
        expired.update(ok=False, verify_code=10, verify_message="certificate has expired", error="verify")
        apis.tls["www.colegio.test"] = expired
        with mock.patch.object(HttpClient, "_exchange", fake):
            return run_e2e(school_scenario(), apis, url=url)

    def test_http_input_measures_the_certificate_of_the_https_hop(self) -> None:
        r = self.run_expired("http://www.colegio.test/")
        self.assertIn("/tls", r.api_paths)
        self.assertEqual(r.check("EXT-07")["estado"], "FALLA")
        self.assertNotEqual(r.code, 3, "a browser warning is measured, not 'the home did not answer'")

    def test_control_https_input_is_unchanged(self) -> None:
        r = self.run_expired("https://www.colegio.test/")
        self.assertIn("/tls", r.api_paths)
        self.assertEqual(r.check("EXT-07")["estado"], "FALLA")


# ---------------------------------------------------------------------------
# codes 20/21 (chain without its intermediate) are not "the browser rejects"
# ---------------------------------------------------------------------------


def run_tls_failure(code: int, days: int = 200, chain_length: int = 1):
    """The home fails Python's verification with ``code`` until the client accepts the incomplete chain."""
    from unittest import mock

    from fakeapis import tls_fixture

    from sitecheck.httpclient import HttpClient, _Exchange

    original = HttpClient._exchange

    def fake(self, method, target, *args, **kwargs):  # type: ignore[no-untyped-def]
        if target.startswith(f"{BASE}/") and "www.colegio.test" not in self._chainless_hosts:
            return _Exchange(error=f"tls:{code}", ms=1.0)
        return original(self, method, target, *args, **kwargs)

    apis = clean_apis()
    bad = tls_fixture("www.colegio.test", days_from_now=days)
    bad.update(ok=False, verify_code=code, verify_message="fake", error="verify", chain_length=chain_length)
    apis.tls["www.colegio.test"] = bad
    with mock.patch.object(HttpClient, "_exchange", fake):
        return run_e2e(school_scenario(SchoolOptions(wp_version=None)), apis)


class TlsChainTest(unittest.TestCase):
    def test_code_20_runs_the_site_phase(self) -> None:
        r = run_tls_failure(20)
        self.assertNotEqual(r.code, 3)
        ext07 = r.check("EXT-07")
        self.assertEqual(ext07["estado"], "FALLA")
        self.assertNotIn("El navegador no acepta la conexión segura", r.files["informe.md"])
        self.assertIn(
            "A la conexión segura del sitio le falta una parte de la cadena de confianza; muchos navegadores la "
            "completan solos y otros muestran una advertencia",
            r.files["informe.md"],
        )
        # The site phase ran: the home was read and the HTML checks measured it.
        self.assertNotEqual(r.check("VIS-04")["estado"], "NO_VERIFICADO")
        self.assertIn("https://www.colegio.test/robots.txt", r.site_urls)

    def test_code_21_too(self) -> None:
        r = run_tls_failure(21)
        self.assertEqual(r.check("EXT-07")["estado"], "FALLA")
        self.assertNotEqual(r.check("VIS-04")["estado"], "NO_VERIFICADO")

    def test_control_a_wrong_name_still_greys_the_site_phase(self) -> None:
        r = run_tls_failure(62)
        self.assertEqual(r.check("EXT-07")["estado"], "FALLA")
        self.assertIn("El navegador no acepta la conexión segura del sitio (no corresponde al nombre del sitio)", r.files["informe.md"])
        self.assertEqual(
            r.check("VIS-04")["motivo"], "el navegador no acepta la conexión segura de la página principal, así que no se leyó"
        )

    def test_report_sentence_by_hand(self) -> None:
        from sitecheck.checks import security
        from sitecheck.tlsprobe import TlsResult
        from test_regressions_wording import ev

        tls = TlsResult(host="www.colegio.test", ok=False, verify_code=21, error="verify", chain_length=1, days_left=200,
                        not_after="2027-05-01T00:00:00+00:00")
        f = ev(security.evaluate_ext07, make_obs(html_page(), tls=[tls]))
        self.assertEqual(f.phrase_report.found, security.REPORT_EXT07_CHAIN)
        self.assertEqual(
            f.phrase_report.action, "Configurar el servidor para que envíe la cadena completa de la conexión segura"
        )


# ---------------------------------------------------------------------------
# the home answered, and the reason says what it answered
# ---------------------------------------------------------------------------


class HomeAnswerReasonTest(unittest.TestCase):
    def obs_with(self, **resp_kw):
        from obsfactory import page
        from sitecheck.observations import Observations

        obs = Observations(input_url=HOME, registrable="colegio.test", canonical_url=HOME, canonical_host="www.colegio.test")
        obs.home = page("home", HOME, "<html><head><title>Error</title></head><body>Error</body></html>", **resp_kw)
        return obs

    def test_unit_reasons_by_hand(self) -> None:
        from sitecheck.checks import common

        cases = [
            ({"status": 403}, "la página principal respondió con un error 403"),
            ({"status": 500}, "la página principal respondió con un error 500"),
            ({"status": 301}, None),
        ]
        for kw, expected in cases:
            obs = self.obs_with(**kw)
            self.assertEqual(common.home_answer_reason(obs.home.response), expected, kw)
        loop = self.obs_with(status=301)
        loop.home.response.hops_exceeded = True
        self.assertEqual(common.unavailable_reason(loop, "home", loop.home.response), "la página principal entra en un círculo de redirecciones")
        br = self.obs_with(status=200)
        br.home.response.undecodable_encoding = "br"
        self.assertEqual(common.unavailable_reason(br, "home", br.home.response), "la página principal llegó en un formato que no se pudo leer")
        self.assertEqual(pipeline._home_reason(self.obs_with(status=403)), "la página principal respondió con un error 403 y la corrida se detuvo")

    def test_control_a_home_that_did_not_answer(self) -> None:
        from sitecheck.checks import common

        down = self.obs_with(status=None, error="refused")
        self.assertIsNone(common.home_answer_reason(down.home.response))
        self.assertEqual(pipeline._home_reason(down), "la página principal no respondió y la corrida se detuvo")

    def test_e2e_home_403(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/"] = Route(403, [("Content-Type", "text/html")], b"<html><head><title>Forbidden</title></head><body>Forbidden</body></html>")
        r = run_e2e(sc, clean_apis())
        self.assertEqual(r.code, 3)
        self.assertEqual(r.datos["meta"]["motivo_portada"], "la página principal respondió con un error 403 y la corrida se detuvo")

    def test_e2e_home_in_brotli(self) -> None:
        import os

        sc = school_scenario()
        body = bytes([0x1B, 0x9B, 0x2C, 0x00]) + os.urandom(3000)
        sc.routes[f"{BASE}/"] = Route(200, [("Content-Type", "text/html; charset=UTF-8"), ("Content-Encoding", "br")], body)
        r = run_e2e(sc, clean_apis())
        self.assertEqual(r.check("VIS-04")["motivo"], "la página principal llegó en un formato que no se pudo leer")


# ---------------------------------------------------------------------------
# a soft 404 is not an anti-bot check; two ordinary 403s are not "bajar el ritmo"
# ---------------------------------------------------------------------------

NOT_FOUND = (
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Página no encontrada</title></head>'
    '<body><h1>Página no encontrada</h1><p>La página que busca no existe o fue movida.</p>'
    '<p><a href="/">Volver al inicio</a></p>' + "<!-- relleno -->" * 100 + "</body></html>"
).encode("utf-8")


class SoftNotFoundTest(unittest.TestCase):
    def detector(self, genuine: bool):
        from sitecheck.challenge import ChallengeDetector

        d = ChallengeDetector()
        d.set_home([HOME], "0" * 64, genuine)
        return d

    def test_small_html_answers_after_a_genuine_home_are_soft_404(self) -> None:
        from sitecheck.challenge import Expect

        d = self.detector(True)
        for url, expect in ((f"{BASE}/robots.txt", Expect.TEXT), (f"{BASE}/sitemap.xml", Expect.XML), (f"{BASE}/og.png", Expect.IMAGE)):
            v = d.inspect(url, 200, [("Content-Type", "text/html; charset=utf-8")], NOT_FOUND, expect)
            self.assertEqual((v.challenged, v.soft_404), (False, True), url)

    def test_control_a_marker_is_still_a_challenge(self) -> None:
        from sitecheck.challenge import Expect

        v = self.detector(True).inspect(f"{BASE}/robots.txt", 200, [("Content-Type", "text/html")],
                                        b"<html><head><title>One moment, please...</title></head></html>", Expect.TEXT)
        self.assertTrue(v.challenged)

    def test_control_after_a_link_less_home_the_strict_rule_stays(self) -> None:
        from sitecheck.challenge import Expect

        v = self.detector(False).inspect(f"{BASE}/robots.txt", 200, [("Content-Type", "text/html")], NOT_FOUND, Expect.TEXT)
        self.assertTrue(v.challenged)

    def test_e2e_robots_soft_404_does_not_cut_the_site(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/robots.txt"] = Route(200, [("Content-Type", "text/html; charset=utf-8")], NOT_FOUND)
        r = run_e2e(sc, clean_apis())
        self.assertFalse(r.datos["meta"]["sitio_cortado"])
        self.assertEqual(r.datos["meta"]["eventos_desafio"], [])
        self.assertNotIn("anti-bot", r.files["informe.md"])
        self.assertEqual(r.check("VIS-02")["motivo"], "el sitio no publica el archivo robots.txt, y el mapa del sitio se busca a mano")

    def test_e2e_spa_shell_is_said_as_such_not_as_anti_bot(self) -> None:
        from fakesite import Scenario
        from fixhelp import control_route
        from sitefixtures import png_bytes

        d = "colegio.test"
        routes = {
            f"http://{d}/": Route(308, [("Location", f"{BASE}/")]),
            f"https://{d}/": Route(308, [("Location", f"{BASE}/")]),
            f"http://www.{d}/": Route(308, [("Location", f"{BASE}/")]),
            f"{BASE}/": Route(200, list(HTML) + [("Strict-Transport-Security", "max-age=63072000")], SPA_HOME.encode("utf-8")),
            "https://control.test/": control_route(),
            f"{BASE}/robots.txt": Route(200, [("Content-Type", "text/plain; charset=utf-8")], b"User-agent: *\nAllow: /\n"),
            f"{BASE}/og-image.png": Route(200, [("Content-Type", "image/png")], png_bytes(1200, 630)),
        }
        r = run_e2e(Scenario(name="spa", routes=routes, allowed=frozenset(), forbidden=frozenset()), clean_apis())
        self.assertEqual(r.code, 0)
        self.assertEqual(r.datos["meta"]["eventos_desafio"], [])

    def test_control_e2e_real_challenge_on_robots_still_cuts(self) -> None:
        from sitefixtures import challenge_route

        sc = school_scenario()
        sc.routes[f"{BASE}/robots.txt"] = challenge_route()
        r = run_e2e(sc, clean_apis())
        self.assertTrue(r.datos["meta"]["sitio_cortado"])


FORBIDDEN = Route(403, [("Content-Type", "text/html; charset=iso-8859-1")],
                  b"<!DOCTYPE HTML PUBLIC><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>")


class ForbiddenThrottleTest(unittest.TestCase):
    def test_e2e_two_ordinary_403_links_do_not_cut(self) -> None:
        sc = school_scenario()
        sc.routes[f"{BASE}/institucional/"] = FORBIDDEN
        sc.routes[f"{BASE}/niveles/inicial/"] = FORBIDDEN
        r = run_e2e(sc, clean_apis())
        self.assertFalse(r.datos["meta"]["sitio_cortado"])
        self.assertNotEqual(r.check("VIS-09")["motivo"], "el sitio pidió bajar el ritmo")
        self.assertNotIn("bajar el ritmo", r.files["informe.md"])

    def scenario(self, routes: dict[str, Route]):
        sc = school_scenario()
        sc.routes.update(routes)
        return sc

    def test_403_with_retry_after_is_a_signal(self) -> None:
        from test_regressions_net import _Rig

        from sitecheck.scope import Purpose

        busy = Route(403, [("Content-Type", "text/html"), ("Retry-After", "30")], b"<html><body>Forbidden</body></html>")
        with FakeSite(self.scenario({f"{BASE}/a/": busy})) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/"], purpose=Purpose.LINK_CHECK, source="t")
            first = rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue((first.challenge or "").startswith("e:"))
            self.assertIn(30.0, rig.sleeps.calls)

    def test_403_on_a_url_that_answered_200_earlier_is_a_signal(self) -> None:
        from test_regressions_net import _Rig

        from sitecheck.scope import Purpose

        sc = self.scenario({})
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            ok = rig.client.fetch(HOME, purpose=Purpose.HOME)
            self.assertEqual(ok.status, 200)
            sc.routes[HOME] = FORBIDDEN
            reload_ = rig.client.fetch(HOME, purpose=Purpose.HOME_RELOAD)
            self.assertTrue((reload_.challenge or "").startswith("e:"), "the home that answered 200 now refuses the tool")

    def test_control_a_single_plain_403_link_is_a_page(self) -> None:
        from test_regressions_net import _Rig

        from sitecheck.scope import Purpose

        with FakeSite(self.scenario({f"{BASE}/a/": FORBIDDEN})) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/"], purpose=Purpose.LINK_CHECK, source="t")
            one = rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertIsNone(one.challenge)
            self.assertEqual(rig.sleeps.calls, [])


# ---------------------------------------------------------------------------
# IDN domains are written as a reader types them, never in punycode
# ---------------------------------------------------------------------------

PUNY = "colegioespañol.test".encode("idna").decode("ascii")


class IdnSentenceTest(unittest.TestCase):

    def test_control_an_ascii_domain_is_unchanged(self) -> None:
        from sitecheck import domains

        self.assertEqual(domains.decode_idn("colegio.test"), "colegio.test")
        self.assertEqual(domains.decode_idn(PUNY), "colegioespañol.test")
        self.assertEqual(domains.decode_idn("xn--a.test"), "xn--a.test", "a label that does not decode stays raw")


# ---------------------------------------------------------------------------
# odd charset labels never crash the run
# ---------------------------------------------------------------------------


class CharsetCrashTest(unittest.TestCase):
    BODY = "<html><head><title>Colegio</title></head><body>Bienvenidos</body></html>".encode("ascii")

    def test_undefined_and_idna_read_as_utf8(self) -> None:
        for label in ("undefined", "idna"):
            r = response(HOME, headers=[("Content-Type", f"text/html; charset={label}")], body=self.BODY)
            self.assertEqual(r.text(), ("<html><head><title>Colegio</title></head><body>Bienvenidos</body></html>", 0), label)

    def test_control_a_real_charset_is_used(self) -> None:
        body = "<p>año</p>".encode("cp1252")
        r = response(HOME, headers=[("Content-Type", "text/html; charset=windows-1252")], body=body)
        self.assertEqual(r.text(), ("<p>año</p>", 0))


# ---------------------------------------------------------------------------
# IPv4 evidence is not a phone; /author/<user>/ never reaches datos.json or requests.log
# ---------------------------------------------------------------------------


class MaskingTest(unittest.TestCase):
    def test_dotted_ipv4_is_kept(self) -> None:
        from sitecheck import artifacts

        self.assertEqual(artifacts.mask_personal_data('{"answers": ["127.0.1.102"]}'), '{"answers": ["127.0.1.102"]}')
        self.assertEqual(artifacts.mask_personal_data("127.255.255.254"), "127.255.255.254")

    def test_control_phones_are_still_masked(self) -> None:
        from sitecheck import artifacts

        self.assertEqual(artifacts.mask_personal_data("Tel: 11 0000-1234"), "Tel: [numero]")
        self.assertEqual(artifacts.mask_personal_data("Tel: 11.0000.1234"), "Tel: [numero]")

    def test_e2e_dbl_evidence_keeps_the_code(self) -> None:
        r = run_e2e(school_scenario(), default_apis(dbl_codes=["127.0.1.102"]))
        self.assertIn(b"127.0.1.102", r.evidence["dbl.json"])
        self.assertNotIn(b"[numero]", r.evidence["dbl.json"])

    def test_author_path_in_meta_and_requests_log(self) -> None:
        from sitecheck.challenge import ChallengeDetector
        from sitecheck.credentials import Redactor
        from sitecheck.endpoints import Endpoints
        from sitecheck.httpclient import ClientConfig, HttpClient
        from sitecheck.requestlog import RequestLog
        from sitecheck.scope import Purpose, ScopeGuard

        raw = {"rechazadas": [{"url": "https://www.colegio.test/author/mgomez/", "motivo": "redirect to deny-pattern /author/"}]}
        self.assertEqual(
            pipeline._sanitize_raw(raw),
            {"rechazadas": [{"url": "https://www.colegio.test/author/[usuario]/", "motivo": "redirect to deny-pattern /author/"}]},
        )
        guard = ScopeGuard("colegio.test", "https://www.colegio.test/", Endpoints())
        guard.set_canonical("https://www.colegio.test/")
        log = RequestLog(None, Redactor([]))
        http = HttpClient(guard, log, ChallengeDetector(), Redactor([]), ClientConfig(pace_seconds=0, pace_jitter=0))
        http._record_refused("https://www.colegio.test/author/mgomez/", Purpose.LINK_CHECK, "GET", 1, "redirect to a denied path")
        self.assertEqual(log.records()[-1].url, "https://www.colegio.test/author/[usuario]/")

    def test_control_ordinary_urls_are_unchanged(self) -> None:
        raw = {"omitidos": [{"url": "https://www.colegio.test/2024/03/acto/", "motivo": "budget"}]}
        self.assertEqual(pipeline._sanitize_raw(raw), raw)


# ---------------------------------------------------------------------------
# PageSpeed stops when its first answer lands on a listed domain
# ---------------------------------------------------------------------------


class PsiExclusionTest(unittest.TestCase):
    def moved(self):
        sc = school_scenario()
        sc.routes[f"{BASE}/"] = Route(301, [("Location", "https://www.colegionuevo.test/")])
        apis = default_apis()
        # Lighthouse follows the redirect: every answer ends on the other domain.
        apis.psi_mobile = [psi_payload("https://www.colegionuevo.test/") for _ in range(3)]
        apis.psi_desktop = psi_payload("https://www.colegionuevo.test/", strategy="DESKTOP")
        return sc, apis

    def psi_calls(self, r) -> int:
        return len([p for p in r.api_paths if p.endswith("runPagespeed")])

    def test_listed_destination_stops_the_series_after_the_first_answer(self) -> None:
        sc, apis = self.moved()
        r = run_e2e(sc, apis, exclude="colegionuevo.test\n")
        self.assertEqual(r.code, 10)
        self.assertEqual(self.psi_calls(r), 1)

    def test_control_unlisted_destination_runs_the_whole_series(self) -> None:
        sc, apis = self.moved()
        r = run_e2e(sc, apis)
        self.assertEqual(self.psi_calls(r), 4)
        self.assertEqual(r.code, 3)


if __name__ == "__main__":
    unittest.main()
