"""A slow site end to end: the report keeps the speed row with its numbers.
"""

from __future__ import annotations

import datetime as dt
import email.utils
import json
import unittest
from pathlib import Path

import support  # noqa: F401
from support import TEST_KEY, patched_env, run_cli

from fakeapis import FakeApis, FakeApisConfig
from fakesite import FakeSite, Scenario
from fixhelp import run_e2e
from sitefixtures import SchoolOptions, default_apis, school_scenario

END = "[Fin de las líneas internas]"

# Report rows of the default PageSpeed answer (field LCP 4830 ms, 2,9 MB with 1,9 MB of images), typed by hand.
SPEED_ROW = (
    "| En celular, lo principal de la página tarda 4,8 segundos en aparecer; Google considera bien hasta 2,5 segundos "
    "| Quien entra desde el celular espera más de lo que Google considera aceptable en cada visita | Plan de "
    "velocidad: imágenes, caché y lo que carga primero | Quien mantiene el sitio, con acceso al panel |"
)
# ---------------------------------------------------------------------------
# Scenarios (the renders of the task use these same builders)
# ---------------------------------------------------------------------------


def scenario_slow_old_footer() -> Scenario:
    """Colegio Ejemplo Norte with footer © 2019 and news of May 2024: slow (default PageSpeed), a WhatsApp number without
    the 54, no WordPress, no broken link."""
    options = SchoolOptions(domain="ejemplonorte.test", name="Colegio Ejemplo Norte", title="Colegio Ejemplo Norte | Nivel inicial, primario y secundario",
                            wp_version=None, broken_link=False, footer_year=2019, whatsapp="1145678900")
    return school_scenario(options)


# ---------------------------------------------------------------------------
# end to end
# ---------------------------------------------------------------------------


class OnlySlowTest(unittest.TestCase):
    """A site that is only slow, plus one CONTACTO finding: no mail, and the report keeps the speed."""

    def test_the_report_keeps_the_speed_row(self) -> None:
        r = run_e2e(scenario_slow_old_footer(), default_apis("ejemplonorte.test"), url="https://www.ejemplonorte.test/",
                    nombre="Colegio Ejemplo Norte", extra=("--kind", "colegio"))
        self.assertEqual(r.code, 0, r.err)
        self.assertIn(SPEED_ROW, r.files["informe.md"])


if __name__ == "__main__":
    unittest.main()
