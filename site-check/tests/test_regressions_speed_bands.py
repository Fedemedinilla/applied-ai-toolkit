"""Regression tests of the EXT-08 bands and scopes, and of VIS-21 wording on the
contact page.
"""

from __future__ import annotations

import datetime as dt
import unittest

import support  # noqa: F401

from sitecheck import kinds
from sitecheck.checks import contact, speed
from sitecheck.doh import DnsBundle, DnsStatus
from sitecheck.model import State
from sitecheck.observations import MailDomainSurvey
from obsfactory import field, html_page, make_obs, psi_series
from test_checks_security import CONTROL
from test_checks_contact_paths import SITE_DNS, ans, check, ev

NX, NODATA, OK = DnsStatus.NXDOMAIN, DnsStatus.NODATA, DnsStatus.NOERROR
OLD = "colegio-viejo.test"


def ext08_field(lcp: int, scope: str = "pagina"):  # type: ignore[no-untyped-def]
    return ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(field=field(lcp=lcp, inp=150, cls=0.05, scope=scope))))


# ---------------------------------------------------------------------------
# the EXT-08 sentences
# ---------------------------------------------------------------------------


class Ext08BandTest(unittest.TestCase):
    """Every slow field LCP is a FALLA with one report sentence, the figure rounded half up as PageSpeed
    shows it, and a trace to the measured value."""

    REPORT = "En celular, lo principal de la página tarda {} segundos en aparecer; Google considera bien hasta 2,5 segundos."

    def test_every_case_of_the_round_is_report_only(self) -> None:
        cases = [  # (lcp in ms, scope, the figure of the report sentence), typed by hand
            (4830, "pagina", "4,8"),
            (5230, "origen", "5,2"),
            (3270, "pagina", "3,3"),
            (3550, "origen", "3,6"),
            (4000, "pagina", "4,0"),
            (4099, "pagina", "4,1"),
            (4100, "pagina", "4,1"),
            (2600, "pagina", "2,6"),
        ]
        for lcp, scope, figure in cases:
            f = ext08_field(lcp, scope=scope)
            self.assertEqual((f.state, f.trace), (State.FALLA, {"{lcp_s}": "checks[EXT-08].measured.lcp_ms"}), lcp)
            self.assertEqual(f.phrase_report.found, self.REPORT.format(figure), lcp)
            self.assertEqual((f.measured["lcp_ms"], f.measured["scope"]), (lcp, scope))

    def test_the_lab_case_is_report_only_too(self) -> None:
        lab = ev(speed.evaluate_ext08, make_obs(html_page(), psi=psi_series(labs=(4830.0, 5120.0, 4600.0))))
        self.assertEqual((lab.state, lab.trace), (State.FALLA, {"{lcp_s}": "checks[EXT-08].measured.lab_lcp_ms_median"}))
        self.assertEqual(lab.phrase_report.found, self.REPORT.format("4,8"))
        self.assertEqual(lab.note, "prueba de laboratorio; Google no tiene datos de usuarios reales de este sitio")


# ---------------------------------------------------------------------------
# VIS-21 on the contact page
# ---------------------------------------------------------------------------


def vis21(survey: MailDomainSurvey, *, interna: bool = False, kind: str = "colegio"):  # type: ignore[no-untyped-def]
    obs = make_obs(
        html_page(),
        interna_html=html_page() if interna else None,
        dns=DnsBundle(site=SITE_DNS, control=CONTROL, control_ok=True),
        mail_domains=survey,
    )
    return ev(contact.evaluate_vis21, obs, kind=kind)


class Vis21ContactPageTest(unittest.TestCase):

    def test_vis21_the_domain_only_variant_on_the_contact_page(self) -> None:
        f = vis21(MailDomainSurvey(checked=[check(OLD, ans(OLD, "MX", NX), pages=("interna",))], interna_read=True, interna_kind="contacto"),
                  interna=True)
        self.assertEqual(f.trace, {"{dominio}": "checks[VIS-21].measured.dominio_mail"})


if __name__ == "__main__":
    unittest.main()
