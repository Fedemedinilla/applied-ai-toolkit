"""The speed checks (EXT-08, EXT-20, EXT-21, EXT-18, EXT-19): thresholds, field versus
lab data, the lab-only green exception and the trace of every printed number.
"""

from __future__ import annotations

import unittest

import support  # noqa: F401

from sitecheck.checks import common, speed
from sitecheck.model import ColourException, State
from sitecheck.observations import TtfbSample, TtfbSeries
from sitecheck.psi import AuditResult
from sitecheck.tlsprobe import TlsResult
from obsfactory import HOME, field, html_page, make_ctx, make_obs, psi_series, response


def ext08(series):
    obs = make_obs(html_page(), psi=series)
    return speed.evaluate_ext08(obs, make_ctx(obs))


class Ext08Test(unittest.TestCase):
    def test_boundaries_count_as_good(self) -> None:
        f = ext08(psi_series(field=field(lcp=2500, inp=200, cls=0.10)))
        self.assertEqual(f.state, State.APROBADO)

    def test_slow_field_lcp_fails_with_its_trace(self) -> None:
        f = ext08(psi_series(field=field(lcp=4830, inp=180, cls=0.05)))
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.trace, {"{lcp_s}": "checks[EXT-08].measured.lcp_ms"})
        # The report sentence is the one it always was.
        self.assertEqual(
            f.phrase_report.found,
            "En celular, lo principal de la página tarda 4,8 segundos en aparecer; Google considera bien hasta 2,5 segundos.",
        )
        self.assertEqual(f.measured["lcp_ms"], 4830)
        self.assertEqual(f.measured["scope"], "pagina")
        self.assertTrue(any(e.startswith("psi-mobile-") for e in f.evidence))

    def test_inp_above_threshold_fails(self) -> None:
        self.assertEqual(ext08(psi_series(field=field(lcp=2000, inp=201, cls=0.05))).state, State.FALLA)

    def test_missing_inp_is_an_observation(self) -> None:
        f = ext08(psi_series(field=field(lcp=2000, inp=None, cls=0.05)))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertIsNone(f.colour_exception)

    def test_lab_only_pass_is_observation_with_the_green_exception(self) -> None:
        f = ext08(psi_series(field=None, labs=(2100.0, 2000.0, 2300.0), lab_cls=0.03))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(f.colour_exception, ColourException.LAB_ONLY_PASS)
        self.assertIn("laboratorio", f.note)
        self.assertEqual(f.measured["scope"], "laboratorio")

    def test_lab_only_slow_fails_with_the_lab_median(self) -> None:
        f = ext08(psi_series(field=None, labs=(3100.0, 3400.0, 2900.0)))
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(
            f.phrase_report.found,
            "En celular, lo principal de la página tarda 3,1 segundos en aparecer; Google considera bien hasta 2,5 segundos.",
        )
        self.assertEqual(f.note, "prueba de laboratorio; Google no tiene datos de usuarios reales de este sitio")

    def test_no_result_is_never_a_number(self) -> None:
        f = ext08(psi_series(status="cuota", reason=common.REASON_PSI_QUOTA))
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertEqual(f.reason, common.REASON_PSI_QUOTA)
        series = psi_series(field=None, labs=(2000.0, 2100.0, 1900.0))
        series.mobile[1].ok = series.mobile[2].ok = False
        f = ext08(series)
        self.assertEqual(f.state, State.NO_VERIFICADO, "fewer than 2 valid runs of 3 and no field data")


def ttfb(site: list[float | None], control: list[float | None]) -> TtfbSeries:
    return TtfbSeries(
        site=[TtfbSample(HOME, v, 200 if v else None) for v in site],
        control=[TtfbSample("https://control.test/", v, 200 if v else None) for v in control],
    )


class Ext20Test(unittest.TestCase):
    def evaluate(self, site, control):
        obs = make_obs(html_page(), ttfb=ttfb(site, control))
        return speed.evaluate_ext20(obs, make_ctx(obs))

    def test_states(self) -> None:
        self.assertEqual(self.evaluate([700, 900, 750], [300, 320, 310]).state, State.APROBADO)
        self.assertEqual(self.evaluate([800, 800, 900], [300, 320, 310]).state, State.APROBADO, "0,8 s counts as good")
        f = self.evaluate([900, 850, 810], [300, 320, 310])
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.measured["ttfb_ms_median"], 850)

    def test_slow_control_or_too_few_samples(self) -> None:
        f = self.evaluate([700, 750, 720], [1200, 1300, 900])
        self.assertEqual(f.state, State.NO_VERIFICADO)
        self.assertEqual(f.reason, common.REASON_CONTROL_SLOW)
        self.assertEqual(self.evaluate([700, None, None], [300, 320, 310]).state, State.NO_VERIFICADO)


class Ext21Test(unittest.TestCase):
    def evaluate(self, total: int, images: int):
        audits = {
            "total_byte_weight": AuditResult("total-byte-weight", 0.5, "numeric", float(total), None),
            "resource_summary": AuditResult(
                "resource-summary", None, "informative", None, 2,
                {"items": [{"resourceType": "total", "transferSize": total}, {"resourceType": "image", "transferSize": images}]},
            ),
        }
        obs = make_obs(html_page(), psi=psi_series(field=field(), audits=audits))
        return speed.evaluate_ext21(obs, make_ctx(obs))

    def test_threshold_and_phrases(self) -> None:
        self.assertEqual(self.evaluate(1_638_400, 500_000).state, State.APROBADO)
        f = self.evaluate(3_000_000, 2_000_000)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.phrase_report.found, "La página principal pesa 2,9 MB: 1,9 MB son imágenes")
        self.assertEqual(
            f.trace,
            {"{peso_mb}": "checks[EXT-21].measured.total_bytes", "{img_mb}": "checks[EXT-21].measured.image_bytes"},
        )
        # Control: images under 0,1 MB are not named in the report sentence.
        f = self.evaluate(3_000_000, 50_000)
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.phrase_report.found, "La página principal pesa 2,9 MB; Google aconseja no pasar de 1,6 MB")

    def test_no_psi(self) -> None:
        obs = make_obs(html_page(), psi=psi_series(status="error", reason=common.REASON_PSI_ERROR))
        self.assertEqual(speed.evaluate_ext21(obs, make_ctx(obs)).state, State.NO_VERIFICADO)


class Ext18Ext19Test(unittest.TestCase):
    def test_protocol_and_compression(self) -> None:
        obs = make_obs(html_page(), tls=[TlsResult("www.colegio.test", ok=True, alpn="h2")])
        obs.home.response = response(HOME, body=html_page(), headers=[("Content-Type", "text/html"), ("Content-Encoding", "gzip")], content_encoding="gzip", raw_length=400)
        self.assertEqual(speed.evaluate_ext18(obs, make_ctx(obs)).state, State.APROBADO)
        obs.tls = [TlsResult("www.colegio.test", ok=True, alpn="http/1.1")]
        self.assertEqual(speed.evaluate_ext18(obs, make_ctx(obs)).state, State.FALLA)

    def test_cache(self) -> None:
        hit = [response(HOME, body=html_page(), headers=[("Content-Type", "text/html"), ("X-LiteSpeed-Cache", "hit")]) for _ in range(2)]
        obs = make_obs(html_page(), home_reloads=hit)
        self.assertEqual(speed.evaluate_ext19(obs, make_ctx(obs)).state, State.APROBADO)
        miss = [response(HOME, body=html_page(), headers=[("Content-Type", "text/html"), ("Cache-Control", "no-cache, max-age=0")]) for _ in range(2)]
        obs = make_obs(html_page(), home_reloads=miss)
        self.assertEqual(speed.evaluate_ext19(obs, make_ctx(obs)).state, State.FALLA)
        obs = make_obs(html_page(body="<!-- Page cached by LiteSpeed Cache 5.7 -->"), home_reloads=miss)
        self.assertEqual(speed.evaluate_ext19(obs, make_ctx(obs)).state, State.APROBADO_CON_OBSERVACION)
        obs = make_obs(html_page(), home_reloads=[])
        self.assertEqual(speed.evaluate_ext19(obs, make_ctx(obs)).state, State.NO_VERIFICADO)


if __name__ == "__main__":
    unittest.main()
