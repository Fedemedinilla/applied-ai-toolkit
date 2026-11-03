"""Core of the evaluation: colour mapping, evidence gate, Spanish formatting, registry,
WordPress release table, Google summary bands and HTML extraction.
"""

from __future__ import annotations

import datetime as dt
import json
import unittest

import support  # noqa: F401
from support import temp_dir

from sitecheck import colours, fmt, gate, htmlextract, registry, wpversions
from sitecheck.checks import header
from sitecheck.model import Colour, ColourException, Finding, Module, Priority, State
from obsfactory import HOME, html_page, make_obs, response

UTC = dt.timezone.utc


def finding(cid: str, state: State, priority: Priority, module: Module | None = None, **kw) -> Finding:
    return Finding(
        id=cid,
        name_plain="x",
        module=module or Module(cid.split("-")[0]),
        priority=priority,
        state=state,
        **kw,
    )


class RegistryDataTest(unittest.TestCase):
    """Static data of the registry (passes on the skeleton: it is the design)."""

    EXPECTED = {
        "EXT-08": Priority.ALTA,
        "EXT-21": Priority.MEDIA,
        "EXT-20": Priority.ALTA,
        "EXT-18": Priority.MEDIA,
        "EXT-19": Priority.MEDIA,
        "VIS-06": Priority.ALTA,
        "VIS-04": Priority.MEDIA,
        "VIS-01": Priority.CRITICA,
        "VIS-02": Priority.MEDIA,
        "VIS-03": Priority.MEDIA,
        "VIS-05": Priority.BAJA,
        "VIS-07": Priority.BAJA,
        "VIS-08": Priority.BAJA,
        "VIS-09": Priority.MEDIA,
        "VIS-10": Priority.MEDIA,
        "VIS-11": Priority.BAJA,
        "VIS-12": Priority.MEDIA,
        "VIS-13": Priority.MEDIA,
        "VIS-14": Priority.BAJA,
        "VIS-15": Priority.BAJA,
        "EXT-07": Priority.ALTA,
        "EXT-13": Priority.ALTA,
        "EXT-17": Priority.ALTA,
        "EXT-16": Priority.MEDIA,
        "EXT-01": Priority.ALTA,
        "EXT-05": Priority.ALTA,
        "EXT-23": Priority.CRITICA,
        "EXT-02": Priority.MEDIA,
        "EXT-09": Priority.BAJA,
        "EXT-24": Priority.CRITICA,
        "VIS-16": Priority.MEDIA,
        "VIS-17": Priority.MEDIA,
        "EXT-25": Priority.MEDIA,
        "VIS-18": Priority.MEDIA,
        "VIS-19": Priority.BAJA,
        "VIS-20": Priority.MEDIA,
        "VIS-21": Priority.MEDIA,
    }

    def test_exactly_the_37_checks_with_their_priorities(self) -> None:
        got = {c.id: c.priority for c in registry.CHECKS}
        self.assertEqual(len(registry.CHECKS), 37)
        self.assertEqual(got, self.EXPECTED)

    def test_header_is_not_a_check_and_ids_are_unique(self) -> None:
        ids = [c.id for c in registry.CHECKS]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertFalse(any(i.startswith("NUEVO") for i in ids))

    def test_speed_flags_and_modules(self) -> None:
        self.assertEqual({c.id for c in registry.CHECKS if c.speed}, colours.SPEED_IDS)
        for c in registry.CHECKS:
            self.assertEqual(c.module.value, c.id.split("-")[0], c.id)

    def test_names_are_clean_client_text(self) -> None:
        for c in registry.CHECKS:
            self.assertNotIn("\u2014", c.name_plain, c.id)
            self.assertNotIn("\u2013", c.name_plain, c.id)
            self.assertNotIn("certificado", c.name_plain.lower(), c.id)

    def test_wordpress_table_is_ordered_and_recent(self) -> None:
        dates = list(wpversions.BRANCH_RELEASES.values())
        self.assertEqual(dates, sorted(dates))
        self.assertIn("7.1", wpversions.BRANCH_RELEASES)


class RegistryFunctionsTest(unittest.TestCase):
    def test_lookup(self) -> None:
        self.assertEqual(registry.get("EXT-08").name_plain, "¿Qué tan rápido lo ven los usuarios reales en el celular?")
        self.assertEqual(len(registry.by_id()), 37)
        self.assertEqual([c.id for c in registry.all_specs()], [c.id for c in registry.CHECKS])
        with self.assertRaises(KeyError):
            registry.get("EXT-03")


class ColoursTest(unittest.TestCase):
    def test_table(self) -> None:
        d = colours.derive_colour
        self.assertEqual(d("EXT-01", Module.EXT, State.FALLA, Priority.ALTA), Colour.ROJO)
        self.assertEqual(d("EXT-23", Module.EXT, State.FALLA, Priority.CRITICA), Colour.ROJO)
        self.assertEqual(d("EXT-02", Module.EXT, State.FALLA, Priority.MEDIA), Colour.AMARILLO)
        self.assertEqual(d("EXT-25", Module.EXT, State.FALLA, Priority.MEDIA), Colour.AMARILLO)
        self.assertEqual(d("EXT-08", Module.EXT, State.FALLA, Priority.ALTA), Colour.AMARILLO, "speed")
        self.assertEqual(d("EXT-20", Module.EXT, State.FALLA, Priority.ALTA), Colour.AMARILLO, "speed")
        self.assertEqual(d("VIS-01", Module.VIS, State.FALLA, Priority.CRITICA), Colour.AZUL)
        self.assertEqual(d("VIS-16", Module.VIS, State.FALLA, Priority.MEDIA), Colour.AZUL)
        self.assertEqual(d("VIS-06", Module.VIS, State.APROBADO_CON_OBSERVACION, Priority.ALTA), Colour.AMARILLO)
        self.assertEqual(d("VIS-04", Module.VIS, State.APROBADO_CON_OBSERVACION, Priority.MEDIA), Colour.AZUL)
        self.assertEqual(d("EXT-07", Module.EXT, State.APROBADO, Priority.ALTA), Colour.VERDE)
        self.assertEqual(d("EXT-07", Module.EXT, State.NO_VERIFICADO, Priority.ALTA), Colour.GRIS)
        self.assertEqual(d("VIS-08", Module.VIS, State.NO_APLICA, Priority.BAJA), Colour.OCULTO)

    def test_decision_3_lab_only_pass_is_green(self) -> None:
        f = finding("EXT-08", State.APROBADO_CON_OBSERVACION, Priority.ALTA, colour_exception=ColourException.LAB_ONLY_PASS)
        colours.colour_finding(f)
        self.assertEqual((f.colour_derived, f.colour), (Colour.AMARILLO, Colour.VERDE))
        self.assertIn("laboratorio", f.colour_reason)
        self.assertEqual((f.shape, f.label), ("●", "Bien"))

    def test_decision_4_sitewide_noindex_is_red(self) -> None:
        f = finding("VIS-01", State.FALLA, Priority.CRITICA, colour_exception=ColourException.SITEWIDE_NOINDEX)
        colours.colour_finding(f)
        self.assertEqual((f.colour_derived, f.colour), (Colour.AZUL, Colour.ROJO))
        self.assertEqual((f.shape, f.label), ("▲", "Arreglar ya"))

    def test_mismatched_exception_is_ignored(self) -> None:
        f = finding("EXT-08", State.FALLA, Priority.ALTA, colour_exception=ColourException.LAB_ONLY_PASS)
        colours.colour_finding(f)
        self.assertEqual(f.colour, Colour.AMARILLO)

    def test_overrides(self) -> None:
        f = finding("EXT-09", State.FALLA, Priority.BAJA)
        colours.colour_finding(f, {"EXT-09": colours.ColourOverride(Colour.AZUL, "el hosting es compartido y no lo permite")})
        self.assertEqual((f.colour_derived, f.colour), (Colour.AMARILLO, Colour.AZUL))
        self.assertEqual(f.colour_reason, "el hosting es compartido y no lo permite")
        nv = finding("EXT-13", State.NO_VERIFICADO, Priority.ALTA)
        colours.colour_finding(nv, {"EXT-13": colours.ColourOverride(Colour.VERDE, "lo miré a mano")})
        self.assertEqual(nv.colour, Colour.GRIS, "a grey can never be turned green")
        na = finding("VIS-08", State.NO_APLICA, Priority.BAJA)
        colours.colour_finding(na, {"VIS-08": colours.ColourOverride(Colour.AZUL, "x")})
        self.assertEqual(na.colour, Colour.OCULTO)

    def test_load_overrides(self) -> None:
        with temp_dir() as d:
            ok = d / "ajustes.json"
            ok.write_text(json.dumps({"EXT-09": {"color": "azul", "motivo": "hosting compartido"}}), encoding="utf-8")
            self.assertEqual(colours.load_overrides(ok)["EXT-09"], colours.ColourOverride(Colour.AZUL, "hosting compartido"))
            for bad in ({"EXT-09": {"color": "azul"}}, {"EXT-09": {"color": "violeta", "motivo": "x"}}, {"EXT-99": {"color": "azul", "motivo": "x"}}):
                p = d / "malo.json"
                p.write_text(json.dumps(bad), encoding="utf-8")
                with self.assertRaises(ValueError, msg=repr(bad)):
                    colours.load_overrides(p)


class GateTest(unittest.TestCase):
    def test_green_without_written_evidence_becomes_grey(self) -> None:
        obs = make_obs(html_page())
        f = finding("EXT-13", State.APROBADO, Priority.ALTA, evidence=["rdap.json"])
        gate.apply_gate([f], registry.by_id(), obs, {"rdap.json": False})
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertEqual(f.reason, gate.REASON_NO_EVIDENCE)
        self.assertFalse(f.evidence_ok)
        g = finding("EXT-13", State.APROBADO, Priority.ALTA, evidence=[])
        gate.apply_gate([g], registry.by_id(), obs, {})
        self.assertEqual(g.state, State.NO_VERIFICADO)

    def test_html_failure_on_a_challenged_home_turns_grey(self) -> None:
        obs = make_obs(html_page(), home_challenge="a:One moment, please")
        f = finding("VIS-06", State.FALLA, Priority.ALTA, evidence=["home.html"], )
        gate.apply_gate([f], registry.by_id(), obs, {"home.html": True})
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertEqual(f.reason, gate.REASON_CHALLENGE)

    def test_html_failure_on_a_good_home_stays(self) -> None:
        obs = make_obs(html_page())
        f = finding("VIS-06", State.FALLA, Priority.ALTA, evidence=["home.html"], )
        gate.apply_gate([f], registry.by_id(), obs, {"home.html": True})
        self.assertEqual(f.state, State.FALLA)
        self.assertTrue(f.evidence_ok)

    def test_html_evidence_criteria(self) -> None:
        good = response(HOME, body=html_page())
        self.assertTrue(gate.html_evidence_ok(good, "www.colegio.test").ok)
        self.assertFalse(gate.html_evidence_ok(response(HOME, body="<html><head></head></html>"), "www.colegio.test").ok, "too small")
        self.assertFalse(gate.html_evidence_ok(response(HOME, body=html_page(), headers=[("Content-Type", "text/plain")]), "www.colegio.test").ok)
        self.assertFalse(gate.html_evidence_ok(response(HOME, body=html_page(), final_url="https://parking.example/"), "www.colegio.test").ok)
        self.assertFalse(gate.html_evidence_ok(response(HOME, status=403, body=html_page()), "www.colegio.test").ok)
        self.assertFalse(gate.html_evidence_ok(None, "www.colegio.test").ok)


class FmtTest(unittest.TestCase):
    def test_numbers(self) -> None:
        self.assertEqual(fmt.ms_to_s(4830), "4,8")
        self.assertEqual(fmt.ms_to_s(2500), "2,5")
        self.assertEqual(fmt.ms_to_s(4850), "4,9", "half up, not banker's rounding")
        self.assertEqual(fmt.ms_to_s(180), "0,2")
        self.assertEqual(fmt.decimal_es(0.05, 2), "0,05")
        self.assertEqual(fmt.decimal_es(12345.0, 0), "12.345")
        self.assertEqual(fmt.bytes_to_mb(2_621_440), "2,5")
        self.assertEqual(fmt.bytes_to_mb(3_000_000), "2,9")
        self.assertEqual(fmt.bytes_to_kb(384_000), "375")
        self.assertEqual(fmt.cls_es(0.1), "0,10")

    def test_dates(self) -> None:
        self.assertEqual(fmt.fecha_dmy(dt.date(2026, 10, 8)), "8/10/2026")
        self.assertEqual(fmt.fecha_larga(dt.date(2026, 12, 6)), "6 de diciembre de 2026")
        self.assertEqual(fmt.mes_anio(dt.date(2022, 11, 1)), "noviembre de 2022")
        late = dt.datetime(2026, 10, 9, 2, 0, tzinfo=UTC)
        self.assertEqual(fmt.local_date(late), dt.date(2026, 10, 8), "02:00 UTC is still the 8th in Buenos Aires")
        self.assertEqual(fmt.hora(late), "23:00")
        self.assertEqual(fmt.whole_months_between(dt.date(2024, 5, 20), dt.date(2026, 10, 9)), 28)
        self.assertEqual(fmt.whole_months_between(dt.date(2024, 5, 20), dt.date(2024, 6, 19)), 0)
        self.assertEqual(fmt.whole_years_between(dt.date(2022, 11, 1), dt.date(2026, 10, 9)), 3)
        with self.assertRaises(ValueError):
            fmt.to_local(dt.datetime(2026, 10, 9, 2, 0))

    def test_site_text_is_sanitized(self) -> None:
        self.assertEqual(fmt.sanitize_site_text("Inicio \u2013 Colegio Ejemplo"), "Inicio - Colegio Ejemplo")
        self.assertEqual(fmt.sanitize_site_text("Inicio &amp; más\n\n  texto"), "Inicio & más texto")
        self.assertNotIn("@", fmt.sanitize_site_text("Escribir a secretaria@colegio.test hoy"))
        long = fmt.sanitize_site_text("palabra " * 40, max_len=30)
        self.assertLessEqual(len(long), 33)
        self.assertTrue(long.endswith("..."))


class WpVersionsTest(unittest.TestCase):
    def test_branch_age(self) -> None:
        self.assertEqual(wpversions.branch_of("6.1.15"), "6.1")
        self.assertEqual(wpversions.branch_of("6.1"), "6.1")
        self.assertIsNone(wpversions.branch_of("seis"))
        self.assertEqual(wpversions.branch_release_date("6.1.1"), dt.date(2022, 11, 1))
        self.assertEqual(wpversions.branch_age_years("6.1.1", dt.date(2026, 10, 9)), 3)
        # 3.0 to 4.9 are in the table since the audit; older branches still give no age.
        self.assertEqual(wpversions.branch_age_years("4.9.8", dt.date(2026, 10, 9)), 8)
        self.assertIsNone(wpversions.branch_age_years("2.9.2", dt.date(2026, 10, 9)), "unknown branch: no age, no number")


class GoogleSummaryTest(unittest.TestCase):
    def test_bands(self) -> None:
        self.assertEqual((header.score_cell(45, None).shape, header.score_cell(45, None).label), ("▲", "Bajo"))
        self.assertEqual(header.score_cell(50, None).shape, "■")
        self.assertEqual(header.score_cell(89, None).label, "A mejorar")
        self.assertEqual(header.score_cell(90, None).shape, "●")
        missing = header.score_cell(None, "la cuota de Google se agotó ese día")
        self.assertEqual((missing.shape, missing.reason), ("○", "la cuota de Google se agotó ese día"))


class HtmlExtractTest(unittest.TestCase):
    def test_extraction(self) -> None:
        html = html_page(
            head='<meta content="Colegio" property="og:title"><meta name="description" content="Desc">'
            '<meta name="robots" content="NOINDEX, follow"><link rel="canonical" href="/">'
            '<script type="application/ld+json">{"@type":"School","name":"C"}</script>',
            body='<h1>A</h1><script>document.write("<h1>no</h1>")</script><template><h2>no</h2></template><h3>B</h3>'
            '<img src="a.jpg" alt=""><img src="b.jpg" data-alt="x"><noscript><img src="b.jpg"></noscript>'
            '<a href="/inscripciones/" aria-label="Inscripción ABIERTA">Ir</a>'
            '<div class="fusion-footer"><a href="tel:+541145678900">Llamar</a> &copy; 2019</div>',
        )
        p = htmlextract.extract_page(html, HOME)
        self.assertEqual(p.lang, "es-ar")
        self.assertEqual(p.og["og:title"], ["Colegio"])
        self.assertEqual(p.meta_description, "Desc")
        self.assertEqual(p.robots_meta, ["noindex, follow"])
        self.assertEqual(p.canonicals, [HOME])
        self.assertEqual(p.headings, [1, 3])
        self.assertEqual([(i.alt, i.in_noscript) for i in p.images], [("", False), (None, False), (None, True)])
        self.assertEqual(len(p.jsonld_blocks), 1)
        self.assertTrue(p.footer_found)
        self.assertIn("2019", p.footer_text)
        tel = [a for a in p.anchors if a.scheme == "tel"][0]
        self.assertTrue(tel.in_footer)
        self.assertEqual(htmlextract.normalize_for_match("Inscripción  ABIERTA"), "inscripcion abierta")

    def test_link_header(self) -> None:
        parsed = htmlextract.parse_link_header('<https://www.colegio.test/>; rel="canonical", <https://www.colegio.test/wp-json/>; rel="https://api.w.org/"')
        self.assertEqual(parsed[0], ("https://www.colegio.test/", {"rel": "canonical"}))
        self.assertEqual(len(parsed), 2)


if __name__ == "__main__":
    unittest.main()
