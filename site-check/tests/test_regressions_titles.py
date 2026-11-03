"""Regression tests: a run without --name, EXT-01 with no protection active, legal forms in the name match.

Expected phrases are written by hand per case. No test names a real URL.
"""

from __future__ import annotations

import dataclasses
import unittest

import support  # noqa: F401

from sitecheck import render_report
from sitecheck.model import State
from test_regressions_report import finding, report_ctx
from test_regressions_wording import NOSNIFF, XFO
from test_regressions_texts import ext01


class BlindTitleTest(unittest.TestCase):
    """Without --name the institution is the domain: the title must not repeat it."""

    def test_blind_run_names_the_domain_once(self) -> None:
        ctx = dataclasses.replace(report_ctx([finding("VIS-04")]), institution="colegio.test")
        first = render_report.render_report(ctx).splitlines()[0]
        self.assertEqual(first, "**Estado del sitio colegio.test**")

    def test_control_named_run_keeps_the_name(self) -> None:
        first = render_report.render_report(report_ctx([finding("VIS-04")])).splitlines()[0]
        self.assertEqual(first, "**Colegio Ejemplo · Estado del sitio colegio.test**")


class Ext01NoneActiveTest(unittest.TestCase):
    """'ninguna de las 6' already covers every protection: naming two read as if only those were missing."""

    def test_none_of_six(self) -> None:
        f = ext01()
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.phrase_report.found, "El servidor no activa ninguna de las 6 protecciones que ofrecen los navegadores")

    def test_control_some_active_still_names_what_is_missing(self) -> None:
        f = ext01(XFO)
        self.assertEqual(
            f.phrase_report.found,
            "El servidor activa 1 de las 6 protecciones que ofrecen los navegadores; falta la que obliga a usar la "
            "conexión segura; falta la que fija el tipo de cada archivo",
        )

    def test_control_nosniff_only(self) -> None:
        f = ext01(NOSNIFF)
        self.assertEqual(
            f.phrase_report.found,
            "El servidor activa 1 de las 6 protecciones que ofrecen los navegadores; falta la que obliga a usar la "
            "conexión segura",
        )


class LegalSuffixNameMatchTest(unittest.TestCase):
    """The legal form of a company name never counts as name words in the title test."""

    def test_company_with_legal_form_matches_in_full(self) -> None:
        from sitecheck.checks import seo

        self.assertEqual(seo.name_match("Acme S.A.", "Acme | Inicio"), "full")

    def test_control_without_legal_form(self) -> None:
        from sitecheck.checks import seo

        self.assertEqual(seo.name_match("Acme", "Acme | Inicio"), "full")
        self.assertEqual(seo.name_match("Acme S.A.", "Inicio"), "none")


if __name__ == "__main__":
    unittest.main()
