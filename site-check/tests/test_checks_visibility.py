"""Visibility, accessibility, contact and content checks against hand-made pages.
"""

from __future__ import annotations

import datetime as dt
import json
import unittest

import support  # noqa: F401

from sitecheck.checks import a11y, contact, content, linkcheck, seo
from sitecheck.checks.contact import NumberVerdict, classify_whatsapp_number
from sitecheck.model import ColourException, State
from sitecheck.observations import FeedFetch
from sitecheck.robots import RobotsState, parse_robots
from sitecheck.observations import RobotsFetch
from sitecheck.sitemapfeed import DocKind, FeedDoc, FeedItem
from obsfactory import BASE, html_page, link_survey, make_ctx, make_obs, og_fetch

UTC = dt.timezone.utc

OG_FULL = (
    '<meta content="Colegio Ejemplo" property="og:title">'
    '<meta property="og:description" content="Educación inicial y primaria en Buenos Aires.">'
    f'<meta property="og:image" content="{BASE}/wp-content/uploads/2024/03/portada.png">'
    '<meta property="og:locale" content="es_AR"><meta name="twitter:card" content="summary_large_image">'
)


def run(fn, home_head: str = "", home_body: str = "", *, title: str | None = "Colegio Ejemplo | Educación inicial y primaria",
        lang: str | None = "es-AR", institution: str | None = "Colegio Ejemplo", run_date: dt.date | None = None, **obs_fields):
    obs = make_obs(html_page(home_head, home_body, title=title, lang=lang), **obs_fields)
    ctx = make_ctx(obs, institution=institution, **({"run_date": run_date} if run_date else {}))
    return fn(obs, ctx)


def robots_ok(text: str = "User-agent: *\nDisallow: /wp-admin/\n") -> RobotsFetch:
    return RobotsFetch(url=f"{BASE}/robots.txt", state=RobotsState.OK, parsed=parse_robots(text))


class Vis06Test(unittest.TestCase):
    def test_only_image_missing(self) -> None:
        head = OG_FULL.replace(f'<meta property="og:image" content="{BASE}/wp-content/uploads/2024/03/portada.png">', "")
        f = run(seo.evaluate_vis06, head)
        self.assertEqual((f.state, f.phrase_report.found), (State.FALLA, "La vista previa al compartir el sitio no tiene imagen"))

    def test_complete_preview(self) -> None:
        self.assertEqual(run(seo.evaluate_vis06, OG_FULL, og_image=og_fetch()).state, State.APROBADO)

    def test_missing_image_and_description(self) -> None:
        f = run(seo.evaluate_vis06, '<meta property="og:title" content="Colegio">')
        self.assertEqual(f.state, State.FALLA)


    def test_broken_image(self) -> None:
        f = run(seo.evaluate_vis06, OG_FULL, og_image=og_fetch(status=404, ctype="text/html", width=None, height=None))
        self.assertEqual(f.state, State.FALLA)

    def test_small_image_is_an_observation(self) -> None:
        f = run(seo.evaluate_vis06, OG_FULL, og_image=og_fetch(width=800, height=418))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)


class Vis04Test(unittest.TestCase):
    DESC = '<meta name="description" content="Colegio Ejemplo acompaña a cada familia desde el nivel inicial hasta la secundaria, con jornada completa y talleres.">'

    def test_missing_description(self) -> None:
        f = run(seo.evaluate_vis04, "", title="Colegio Ejemplo | Educación inicial y primaria")
        self.assertEqual(
            f.phrase_report.found,
            "El título de la página principal es «Colegio Ejemplo | Educación inicial y primaria» (46 caracteres), y la "
            "página no tiene descripción",
        )
        self.assertEqual(f.trace, {"{titulo}": "home <title>", "{n}": "checks[VIS-04].measured.title_len"})

    def test_site_dashes_never_reach_report_text(self) -> None:
        f = run(seo.evaluate_vis04, self.DESC, title="Inicio \u2013 Colegio Ejemplo")
        self.assertNotIn("\u2013", f.phrase_report.found)
        self.assertIn("«Inicio - Colegio Ejemplo»", f.phrase_report.found)

    def test_generic_first_segment(self) -> None:
        # the title carries the name after the generic word, so this stays in the report only.
        f = run(seo.evaluate_vis04, self.DESC, title="Inicio - Colegio Ejemplo")
        self.assertEqual(f.state, State.FALLA)

    def test_name_missing(self) -> None:
        f = run(seo.evaluate_vis04, self.DESC, title="Educación de calidad en Palermo | Inicial y Primaria", institution="Colegio Ejemplo Sur")
        self.assertEqual(f.state, State.FALLA)


    def test_lengths_only_is_an_observation_and_no_name_skips_the_test(self) -> None:
        f = run(seo.evaluate_vis04, '<meta name="description" content="Corta.">', title="Colegio Ejemplo")
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        f = run(seo.evaluate_vis04, self.DESC, title="Educación de calidad en Palermo | Inicial y Primaria", institution=None)
        self.assertNotEqual(f.state, State.FALLA)
        self.assertIsNone(f.note, "a note for the operator never reaches the report")
        self.assertIsNotNone(f.internal_note)


class Vis01Test(unittest.TestCase):
    def test_home_noindex_is_sitewide_and_red(self) -> None:
        f = run(seo.evaluate_vis01, '<meta name="robots" content="noindex, nofollow">', robots=robots_ok())
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.colour_exception, ColourException.SITEWIDE_NOINDEX)

    def test_header_noindex(self) -> None:
        obs = make_obs(html_page(), home_headers=[("Content-Type", "text/html"), ("X-Robots-Tag", "noindex")], robots=robots_ok())
        f = seo.evaluate_vis01(obs, make_ctx(obs))
        self.assertEqual((f.state, f.colour_exception), (State.FALLA, ColourException.SITEWIDE_NOINDEX))

    def test_interna_only_block_goes_to_the_report(self) -> None:
        obs = make_obs(html_page(), interna_html=html_page('<meta name="robots" content="noindex">'), robots=robots_ok())
        f = seo.evaluate_vis01(obs, make_ctx(obs))
        self.assertEqual(f.state, State.FALLA)
        self.assertIsNone(f.colour_exception)

    def test_indexable(self) -> None:
        self.assertEqual(run(seo.evaluate_vis01, '<meta name="robots" content="index, follow">', robots=robots_ok()).state, State.APROBADO)

    def test_challenged_robots_without_noindex(self) -> None:
        f = run(seo.evaluate_vis01, "", robots=RobotsFetch(url=f"{BASE}/robots.txt", state=RobotsState.CHALLENGED))
        self.assertEqual(f.state, State.NO_VERIFICADO)


class SeoStructureTest(unittest.TestCase):
    def test_vis05_headings(self) -> None:
        self.assertEqual(run(seo.evaluate_vis05, "", "<h2>a</h2>").state, State.FALLA)
        self.assertEqual(run(seo.evaluate_vis05, "", "<h1>a</h1><h1>b</h1>").state, State.FALLA)
        self.assertEqual(run(seo.evaluate_vis05, "", "<h1>a</h1><h2>b</h2><h4>c</h4>").state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(run(seo.evaluate_vis05, "", "<h1>a</h1><h2>b</h2><h3>c</h3>").state, State.APROBADO)

    def test_vis07_structured_data(self) -> None:
        one = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"EducationalOrganization","@id":"#o","name":"C","address":{"addressLocality":"CABA"}},{"@type":"WebSite"}]}</script>'
        self.assertEqual(run(seo.evaluate_vis07, one).state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(run(seo.evaluate_vis07, '<script type="application/ld+json">{"@type": "School",}</script>').state, State.FALLA)
        two = '<script type="application/ld+json">[{"@type":"School","name":"A"},{"@type":"Organization","name":"B"}]</script>'
        self.assertEqual(run(seo.evaluate_vis07, two).state, State.FALLA)
        self.assertEqual(run(seo.evaluate_vis07, "").state, State.FALLA)

    def test_vis08_single_language(self) -> None:
        self.assertEqual(run(seo.evaluate_vis08, "").state, State.NO_APLICA)

    def test_vis14_language(self) -> None:
        self.assertEqual(run(seo.evaluate_vis14, lang="es-AR").state, State.APROBADO)
        self.assertEqual(run(seo.evaluate_vis14, lang="es-ES").state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(run(seo.evaluate_vis14, lang=None).state, State.FALLA)
        spanish = "<p>La escuela de la ciudad tiene que ver con los chicos en el barrio para la comunidad con las familias.</p>"
        self.assertEqual(run(seo.evaluate_vis14, "", spanish, lang="en").state, State.FALLA)


class AccessibilityTest(unittest.TestCase):
    def test_vis11_alt(self) -> None:
        body = '<img src="a.jpg" alt="Patio"><img src="b.jpg" alt=""><img src="c.jpg" data-alt="trampa"><noscript><img src="c.jpg"></noscript>'
        f = run(a11y.evaluate_vis11, "", body)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual((f.measured["n_img"], f.measured["n_missing_alt"]), (3, 1))
        self.assertEqual(run(a11y.evaluate_vis11, "", "<p>sin imágenes</p>").state, State.NO_APLICA)

    def test_vis12_zoom(self) -> None:
        self.assertEqual(run(a11y.evaluate_vis12, '<meta name="viewport" content="width=device-width, user-scalable=no">').state, State.FALLA)
        self.assertEqual(run(a11y.evaluate_vis12, '<meta name="viewport" content="width=device-width, maximum-scale=1">').state, State.FALLA)
        self.assertEqual(run(a11y.evaluate_vis12, "").state, State.FALLA, "no viewport at all")
        f = run(a11y.evaluate_vis12, '<meta name="viewport" content="width=device-width, initial-scale=1">')
        self.assertEqual(f.state, State.NO_VERIFICADO)


class Vis09Test(unittest.TestCase):
    def test_plural_phrase(self) -> None:
        survey = link_survey({f"{BASE}/a/": 404, f"{BASE}/b/": 410, f"{BASE}/c/": 200})
        f = run(linkcheck.evaluate_vis09, links=survey)
        self.assertEqual(f.phrase_report.found, "2 de los 3 enlaces revisados de la página principal llevan a páginas que no existen")
        self.assertEqual((f.measured["n_verified"], f.measured["n404"]), (3, 2))

    def test_one_broken_link_singular_phrase(self) -> None:
        survey = link_survey({f"{BASE}/a/": 200, f"{BASE}/b/": 404, f"{BASE}/c/": 200})
        f = run(linkcheck.evaluate_vis09, links=survey)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.measured["broken_addresses"], ["www.colegio.test/b/"])
        self.assertEqual((f.measured["n404"], f.measured["n_verified"]), (1, 3))


    def test_chains_and_coverage(self) -> None:
        survey = link_survey({f"{BASE}/a/": 200, f"{BASE}/b/": 200}, hops={f"{BASE}/b/": 2})
        self.assertEqual(run(linkcheck.evaluate_vis09, links=survey).state, State.APROBADO_CON_OBSERVACION)
        survey = link_survey({f"{BASE}/a/": 200, f"{BASE}/b/": None, f"{BASE}/c/": None})
        self.assertEqual(run(linkcheck.evaluate_vis09, links=survey).state, State.NO_VERIFICADO, "under 50 % verified")


class ContactTest(unittest.TestCase):
    def test_whatsapp_number_rule(self) -> None:
        cases = {
            "5491123456789": NumberVerdict.OK,
            "54111523456789": NumberVerdict.FAIL,
            "549111523456789": NumberVerdict.FAIL,
            "1123456789": NumberVerdict.FAIL,
            "541143219876": NumberVerdict.REVIEW,
            "+54 9 11 2345-6789": NumberVerdict.REVIEW,
            "34612345678": NumberVerdict.FOREIGN,
        }
        for raw, verdict in cases.items():
            self.assertEqual(classify_whatsapp_number(raw).verdict, verdict, raw)
        self.assertEqual(classify_whatsapp_number("5491123456789").last4, "6789")

    def test_vis15(self) -> None:
        body = '<a href="https://wa.me/5491123456789">WhatsApp</a><footer><a href="tel:+541145678900">Llamar</a></footer>'
        self.assertEqual(run(contact.evaluate_vis15, "", body).state, State.APROBADO)
        f = run(contact.evaluate_vis15, "", "<p>Sin botones</p>")
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(run(contact.evaluate_vis15, "", '<div class="joinchat"></div>').state, State.APROBADO_CON_OBSERVACION)

    def test_vis18_keeps_only_last_four_digits(self) -> None:
        f = run(contact.evaluate_vis18, "", '<a href="https://wa.me/54111523456789">WhatsApp</a>')
        self.assertEqual(f.state, State.FALLA)
        dumped = json.dumps(f.measured)
        self.assertNotIn("54111523456789", dumped)
        self.assertNotIn("23456789", dumped)
        self.assertIn("6789", dumped)
        self.assertEqual(run(contact.evaluate_vis18, "", "<p>Sin WhatsApp</p>").state, State.NO_APLICA)
        self.assertEqual(run(contact.evaluate_vis18, "", '<a href="https://wa.me/5491123456789">WA</a>').state, State.APROBADO)


def feed(last: dt.datetime) -> FeedFetch:
    return FeedFetch(url=f"{BASE}/feed/", doc=FeedDoc(kind=DocKind.RSS, items=[FeedItem("Acto", last)]))


class ContentTest(unittest.TestCase):
    def test_vis16_two_signals_fail(self) -> None:
        f = run(content.evaluate_vis16, "", '<footer>&copy; 2019 Colegio Ejemplo</footer>', feed=feed(dt.datetime(2024, 5, 20, 10, tzinfo=UTC)))
        self.assertEqual(f.state, State.FALLA)

    def test_vis16_one_signal_is_an_observation(self) -> None:
        f = run(content.evaluate_vis16, "", '<footer>&copy; 2019 Colegio Ejemplo</footer>', feed=feed(dt.datetime(2026, 9, 1, tzinfo=UTC)))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)

    def test_vis16_current_and_unmeasurable(self) -> None:
        f = run(content.evaluate_vis16, "", '<footer>&copy; 2026 Colegio Ejemplo</footer>', feed=feed(dt.datetime(2026, 9, 1, tzinfo=UTC)))
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(run(content.evaluate_vis16, "", "<footer>Colegio Ejemplo</footer>").state, State.NO_VERIFICADO)

    def test_vis17_inscriptions(self) -> None:
        self.assertEqual(run(content.evaluate_vis17, "", f'<a href="{BASE}/inscripciones/">Inscripciones 2027</a>').state, State.APROBADO)
        f = run(content.evaluate_vis17, "", f'<a href="{BASE}/wp-login.php">Ingresar</a>')
        self.assertEqual(f.state, State.FALLA)
        f = run(content.evaluate_vis17, "", f'<a href="{BASE}/admisiones/">Admisiones</a>', links=link_survey({f"{BASE}/admisiones/": 404}))

    def test_vis19_factory_leftovers(self) -> None:
        tagline = '<meta property="og:description" content="Otro sitio realizado con WordPress">'
        self.assertEqual(run(content.evaluate_vis19, tagline).state, State.FALLA)
        self.assertEqual(run(content.evaluate_vis19, "", '<script>var t="lorem ipsum";</script><p>Tel 4555-1234</p>').state, State.APROBADO)
        icon = '<footer><a class="fusion-social-network-icon fusion-facebook" href="#" aria-label="Facebook"></a></footer>'
        self.assertEqual(run(content.evaluate_vis19, "", icon).state, State.FALLA)

    def test_ext24_passive_spam_signals(self) -> None:
        f = run(content.evaluate_ext24, "", '<div style="display:none"><a href="https://spam.example/">cheap viagra</a></div>')
        self.assertEqual(f.state, State.FALLA)
        self.assertTrue(f.hack_signal)
        f = run(content.evaluate_ext24, "", "<p>Los chicos armaron una réplica del Cabildo para el acto.</p>")
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertFalse(f.hack_signal)
        self.assertIn("site:colegio.test", f.reason)


if __name__ == "__main__":
    unittest.main()
