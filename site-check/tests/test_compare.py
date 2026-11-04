"""--compare: the before/after report of two stored runs.

The fixtures are the fictional school as measured into examples/ (before) and
the same school after the fixes of tests/comparefixtures.py, measured into
examples/after/ by examples/make_compare_example.py. Expected sentences and
numbers are typed by hand from those two datos.json files, never computed with
the code under test.
"""

from __future__ import annotations

import copy
import importlib.util
import io
import json
import shutil
import unittest
from pathlib import Path
from typing import Any

import support  # noqa: F401  (path setup and the network guard)
from support import run_cli, temp_dir

from sitecheck import compare
from sitecheck.exitcodes import ExitCode
from sitecheck.outputs import dumps_datos

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
BEFORE = EXAMPLES / "datos.json"
AFTER = EXAMPLES / "after" / "datos.json"


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _check(datos: dict[str, Any], check_id: str) -> dict[str, Any]:
    return next(c for c in datos["checks"] if c["id"] == check_id)


def _resolve(datos: dict[str, Any], trace: str) -> Any:
    """A trace in the report's notation: checks[ID].measured.KEY is mediciones.KEY of the check with that id."""
    if trace.startswith("checks["):
        check_id, _, rest = trace[len("checks["):].partition("].measured.")
        return _check(datos, check_id)["mediciones"][rest]
    node: Any = datos
    for part in trace.replace("]", "").replace("[", ".").split("."):
        node = node[int(part)] if part.isdigit() else node[part]
    return node


def _assert_traces(test: unittest.TestCase, runs: "_Runs") -> None:
    """Every stored value resolves through its own trace in its own run; no value means no trace."""
    for row in runs.data["filas"]:
        for side, datos in (("antes", runs.before), ("despues", runs.after)):
            cell = row[side]
            if cell["valor"] is None:
                test.assertIsNone(cell["traza"], f"{row['clave']} {side}")
            else:
                test.assertEqual(_resolve(datos, cell["traza"]), cell["valor"], f"{row['clave']} {side}")


class _Runs:
    """Two temporary run folders holding (possibly edited) copies of the example runs."""

    def __init__(self, root: Path) -> None:
        self.before_dir = root / "antes"
        self.after_dir = root / "despues"
        self.before = _load(BEFORE)
        self.after = _load(AFTER)

    def write(self) -> None:
        for folder, datos in ((self.before_dir, self.before), (self.after_dir, self.after)):
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "datos.json").write_text(dumps_datos(datos), encoding="utf-8")

    def run(self) -> tuple[int, str, str]:
        self.write()
        out, err = io.StringIO(), io.StringIO()
        code = compare.run_compare(self.before_dir, self.after_dir, stdout=out, stderr=err)
        return int(code), out.getvalue(), err.getvalue()

    @property
    def report(self) -> str:
        return (self.after_dir / compare.REPORT).read_text(encoding="utf-8")

    @property
    def data(self) -> dict[str, Any]:
        return _load(self.after_dir / compare.DATA)

    def row(self, key: str) -> dict[str, Any]:
        return next(r for r in self.data["filas"] if r["clave"] == key)


class ExampleComparisonTest(unittest.TestCase):
    """The committed example: values typed by hand from the two datos.json files."""

    def setUp(self) -> None:
        self._tmp = temp_dir()
        self.runs = _Runs(self._tmp.__enter__())
        self.code, self.out, self.err = self.runs.run()

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def test_exit_ok_and_text_control_clean(self) -> None:
        self.assertEqual(self.code, 0, self.err)
        self.assertEqual(self.runs.data["salida"]["control_texto"], [])

    def test_field_rows(self) -> None:
        report = self.runs.report
        self.assertIn(
            "| Cuánto tarda en aparecer lo principal de la página | 4,8 segundos | 2,3 segundos | 2,5 segundos menos |", report
        )
        self.assertIn("| Cuánto tarda en responder cuando se toca algo | 0,18 segundos | 0,15 segundos | 0,03 segundos menos |", report)
        self.assertIn("| Cuánto se mueve la página mientras carga | 0,05 | 0,03 | 0,02 menos |", report)
        self.assertNotIn("Entre las dos mediciones pasaron", report)  # 35 days apart

    def test_lab_server_and_weight_rows(self) -> None:
        report = self.runs.report
        self.assertIn("| Puntaje de rendimiento en celular (corrida del medio de tres) | ▲ 45 (Bajo) | ■ 86 (A mejorar) | 41 puntos más |", report)
        self.assertIn("| Cuánto tarda en aparecer lo principal, en celular (valor del medio de tres) | 4,8 segundos | 2,2 segundos | 2,6 segundos menos |", report)
        self.assertIn("| Puntaje de rendimiento en computadora (una corrida) | ■ 78 (A mejorar) | ● 96 (Bien) | 18 puntos más |", report)
        self.assertIn("| Cuánto pesa la página principal | 2,9 MB | 1,2 MB | 1,7 MB menos |", report)
        self.assertIn("| Cuánto de ese peso llega de servicios externos | 0,3 MB | 0,3 MB | sin cambio |", report)
        self.assertIn("| Protecciones que el servidor le pide al navegador | 2 de 6 | 6 de 6 | 4 más |", report)
        self.assertIn("| Qué hacer con los mensajes falsos | falta | configurada: los manda a spam | se agregó |", report)
        self.assertTrue(self.runs.row("ttfb")["comparada"])

    def test_checks_per_module(self) -> None:
        report = self.runs.report
        self.assertIn("| Seguridad y velocidad vistas desde afuera (EXT) | 7 de 16 aplicables | 12 de 16 aplicables |", report)
        self.assertIn("| Visibilidad, accesibilidad y contacto (VIS) | 12 de 20 aplicables | 13 de 20 aplicables |", report)
        self.assertIn("| Total | 19 de 36 aplicables | 25 de 36 aplicables |", report)

    def test_colour_transitions(self) -> None:
        transitions = {t["id"]: (t["antes"], t["despues"], t["tipo"]) for t in self.runs.data["transiciones"]}
        self.assertEqual(
            transitions,
            {
                "EXT-05": ("rojo", "amarillo", "mejoro"),
                "EXT-08": ("amarillo", "verde", "mejoro"),
                "EXT-21": ("amarillo", "verde", "mejoro"),
                "EXT-19": ("amarillo", "verde", "mejoro"),
                "EXT-01": ("amarillo", "verde", "mejoro"),
                "EXT-02": ("amarillo", "verde", "mejoro"),
                "EXT-09": ("amarillo", "azul", "mejoro"),
                "VIS-16": ("azul", "verde", "mejoro"),
            },
        )
        self.assertIn("| ¿Pueden mandar mails falsos con el nombre del dominio? | ▲ Arreglar ya | ■ Revisar |", self.runs.report)
        self.assertIn("Ningún chequeo empeoró.", self.runs.report)

    def test_what_is_left_starts_with_the_worst(self) -> None:
        left = self.runs.data["quedan"]
        self.assertEqual(left[0]["id"], "EXT-05")
        self.assertEqual([r["color"] for r in left].count("gris"), 4)
        self.assertIn("4. Queda 1 chequeo para arreglar ya o revisar", self.runs.report)

    def test_every_compared_value_traces_to_its_run(self) -> None:
        _assert_traces(self, self.runs)

    def test_no_local_path_in_the_outputs(self) -> None:
        for name in (compare.REPORT, compare.DATA):
            text = (self.runs.after_dir / name).read_text(encoding="utf-8")
            self.assertNotIn(str(self.runs.after_dir.parent), text)

    def test_same_inputs_same_bytes(self) -> None:
        first = [(self.runs.after_dir / n).read_bytes() for n in (compare.REPORT, compare.DATA)]
        code, _, err = self.runs.run()
        self.assertEqual(code, 0, err)
        self.assertEqual(first, [(self.runs.after_dir / n).read_bytes() for n in (compare.REPORT, compare.DATA)])


class RefusalTest(unittest.TestCase):
    """Different tools or conditions: exit 5, the reason on stderr, nothing written."""

    def _refused(self, edit, expected: str) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            edit(runs.before, runs.after)
            code, _, err = runs.run()
            self.assertEqual(code, int(ExitCode.NOT_COMPARABLE), err)
            self.assertIn(expected, err)
            self.assertFalse((runs.after_dir / compare.REPORT).exists())
            self.assertFalse((runs.after_dir / compare.DATA).exists())

    def test_other_site_check_version(self) -> None:
        self._refused(lambda b, a: a["meta"].update(version_script="1.1.0"), "the site-check version (other rules) differs")

    def test_other_domain(self) -> None:
        self._refused(lambda b, a: a["meta"].update(dominio="otro.test"), "the domain differs")

    def test_other_measured_page(self) -> None:
        self._refused(lambda b, a: a["meta"].update(url_canonica="https://colegio.test/"), "the measured page")

    def test_other_number_of_valid_runs(self) -> None:
        def edit(b: dict[str, Any], a: dict[str, Any]) -> None:
            b["meta"]["corridas_psi"].update(pedidas=5, validas=3)
            a["meta"]["corridas_psi"].update(pedidas=5, validas=5)

        self._refused(edit, "the valid mobile PageSpeed runs (the median is taken over them) differs: 3 before, 5 after")

    def test_one_run_on_both_dates_is_not_a_median(self) -> None:
        def edit(b: dict[str, Any], a: dict[str, Any]) -> None:
            for datos in (b, a):
                datos["meta"]["corridas_psi"].update(pedidas=1, validas=1)

        self._refused(edit, "the BEFORE run has 1 valid mobile PageSpeed runs; the comparison takes the median of at least 3")

    def test_two_runs_on_both_dates_is_not_a_median(self) -> None:
        def edit(b: dict[str, Any], a: dict[str, Any]) -> None:
            for datos in (b, a):
                datos["meta"]["corridas_psi"].update(pedidas=3, validas=2)

        self._refused(edit, "the AFTER run has 2 valid mobile PageSpeed runs; the comparison takes the median of at least 3")

    def test_an_even_count_has_no_middle_run(self) -> None:
        def edit(b: dict[str, Any], a: dict[str, Any]) -> None:
            for datos in (b, a):
                datos["meta"]["corridas_psi"].update(pedidas=5, validas=4)

        self._refused(edit, "the BEFORE run has 4 valid mobile PageSpeed runs, an even count with no middle run")

    def test_missing_identity_keys_are_refused_not_matched(self) -> None:
        def edit(b: dict[str, Any], a: dict[str, Any]) -> None:
            for datos in (b, a):
                for key in ("dominio", "version_script", "url_canonica", "modo_prueba", "version_lighthouse"):
                    del datos["meta"][key]

        with temp_dir() as root:
            runs = _Runs(root)
            edit(runs.before, runs.after)
            code, _, err = runs.run()
            self.assertEqual(code, int(ExitCode.NOT_COMPARABLE), err)
            for expected in (
                "the BEFORE run does not record the domain",
                "the AFTER run does not record the site-check version",
                "the BEFORE run does not record the measured page (meta.url_canonica)",
                "the AFTER run does not record test mode",
                "the BEFORE run does not record the Lighthouse version (meta.version_lighthouse)",
            ):
                self.assertIn(expected, err)
            self.assertFalse((runs.after_dir / compare.REPORT).exists())

    def test_missing_psi_counts_are_refused(self) -> None:
        self._refused(lambda b, a: a["meta"].pop("corridas_psi"), "the AFTER run does not record validas in meta.corridas_psi")

    def test_pagespeed_off_in_one_run(self) -> None:
        self._refused(lambda b, a: a["meta"].update(sin_pagespeed=True), "PageSpeed on or off")

    def test_other_lighthouse_major(self) -> None:
        self._refused(lambda b, a: a["meta"].update(version_lighthouse="12.8.2"), "the Lighthouse major version differs")

    def test_observatory_in_one_run_only(self) -> None:
        self._refused(lambda b, a: a["meta"]["alcance"].update(observatory=True), "MDN Observatory asked")

    def test_after_not_later(self) -> None:
        self._refused(lambda b, a: a["meta"].update(inicio_utc=b["meta"]["inicio_utc"]), "the AFTER run is not later")

    def test_cut_run(self) -> None:
        self._refused(lambda b, a: b["meta"].update(sitio_cortado=True), "an anti-bot check cut the BEFORE run")

    def test_every_reason_is_listed(self) -> None:
        def edit(b: dict[str, Any], a: dict[str, Any]) -> None:
            a["meta"].update(version_script="1.1.0", max_pedidos=40)

        with temp_dir() as root:
            runs = _Runs(root)
            edit(runs.before, runs.after)
            code, _, err = runs.run()
        self.assertEqual(code, int(ExitCode.NOT_COMPARABLE))
        self.assertIn("site-check version", err)
        self.assertIn("request budget", err)

    def test_lighthouse_minor_difference_is_accepted(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            runs.after["meta"]["version_lighthouse"] = "13.6.1"
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            self.assertIn("Lighthouse 13.5.0 antes y 13.6.1 después, la misma versión principal", runs.report)


class FieldAndLabApartTest(unittest.TestCase):
    """A lab-only run stores its lab LCP in lcp_ms: it must never be shown as field data."""

    def test_missing_field_data_is_marked_not_replaced(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            m = _check(runs.after, "EXT-08")["mediciones"]
            m.update(scope="laboratorio", field_source=None, lcp_ms=m["lab_lcp_ms_median"], inp_ms=None, cls=m["lab_cls_median"])
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            row = runs.row("campo_lcp")
            self.assertFalse(row["comparada"])
            self.assertEqual(row["despues"]["texto"], "sin datos de campo")
            self.assertIsNone(row["despues"]["valor"])
            self.assertIn(
                "| Cuánto tarda en aparecer lo principal de la página | 4,8 segundos | sin datos de campo | no se compara: "
                "Google no tiene datos de usuarios reales en una de las dos fechas; no se reemplazan por la prueba de laboratorio |",
                runs.report,
            )
            self.assertIn("la velocidad se compara solo con la prueba de laboratorio", runs.report)
            # The lab rows still compare, from their own keys.
            self.assertTrue(runs.row("lab_lcp_celular")["comparada"])

    def test_page_and_origin_data_are_not_compared(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            _check(runs.after, "EXT-08")["mediciones"]["scope"] = "origen"
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            self.assertEqual(runs.row("campo_cls")["motivo"], "una medición es de la página principal y la otra de todo el sitio")

    def test_origin_data_on_both_dates_is_named_as_the_whole_site(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            for datos in (runs.before, runs.after):
                _check(datos, "EXT-08")["mediciones"]["scope"] = "origen"
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            self.assertTrue(runs.row("campo_lcp")["comparada"])
            self.assertIn("Quienes visitaron cualquier página del sitio desde un celular, en los 28 días", runs.report)
            self.assertNotIn("Quienes visitaron la página principal", runs.report)

    def test_page_data_on_both_dates_is_named_as_the_home(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            self.assertIn("Quienes visitaron la página principal desde un celular, en los 28 días", runs.report)

    def test_summary_names_the_field_rows_compared_when_lcp_is_missing(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            _check(runs.after, "EXT-08")["mediciones"]["lcp_ms"] = None
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            self.assertIn(
                "3. Para quienes visitan el sitio desde un celular, la respuesta cuando se toca algo pasó de 0,18 segundos "
                "a 0,15 segundos y cuánto se mueve la página mientras carga pasó de 0,05 a 0,03. El resto de los datos "
                "de usuarios reales falta en una de las dos fechas y no se compara.",
                runs.report,
            )
            self.assertIn("\n4. Queda 1 chequeo", runs.report)

    def test_overlapping_field_window_is_stated(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            runs.after["meta"]["inicio_utc"] = "2026-10-24T13:00:00+00:00"
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            self.assertIn("Entre las dos mediciones pasaron 10 días, menos que los 28 que cubre Google", runs.report)


class ChangeColumnTest(unittest.TestCase):
    """The change is worked out from the printed cells, so the three columns never disagree."""

    def _lcp_row(self, before_ms: int, after_ms: int) -> dict[str, Any]:
        with temp_dir() as root:
            runs = _Runs(root)
            _check(runs.before, "EXT-08")["mediciones"]["lcp_ms"] = before_ms
            _check(runs.after, "EXT-08")["mediciones"]["lcp_ms"] = after_ms
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            return runs.row("campo_lcp")

    def test_cells_that_print_apart_show_a_change(self) -> None:
        row = self._lcp_row(2949, 2951)
        self.assertEqual((row["antes"]["texto"], row["despues"]["texto"], row["cambio"]),
                         ("2,9 segundos", "3,0 segundos", "0,1 segundos más"))

    def test_cells_that_print_the_same_show_no_change(self) -> None:
        row = self._lcp_row(2860, 2940)
        self.assertEqual((row["antes"]["texto"], row["despues"]["texto"], row["cambio"]),
                         ("2,9 segundos", "2,9 segundos", "sin cambio"))

    def test_scales(self) -> None:
        self.assertEqual(compare.MEGABYTES.change(1_048_576 * 2.04, 1_048_576 * 2.06), "0,1 MB más")
        self.assertEqual(compare.CLS.change(0.054, 0.046), "sin cambio")
        self.assertEqual(compare.SECONDS_1.cell(40), "menos de una décima de segundo")
        self.assertEqual(compare.SECONDS_1.change(40, 140), "0,1 segundos más")


class MailRowsTest(unittest.TestCase):
    def test_reordered_and_extra_rows_trace_to_their_own_index(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            filas = runs.after["tablas"]["correo"]["filas"]
            filas.reverse()
            filas.append({"que": "Una fila nueva", "valor": "configurada", "significa": "Inventada para el test"})
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            dmarc = next(r for r in runs.data["filas"] if r["que"] == "Qué hacer con los mensajes falsos")
            self.assertEqual(dmarc["antes"]["traza"], "tablas.correo.filas[2].valor")
            self.assertEqual(dmarc["despues"]["traza"], "tablas.correo.filas[0].valor")
            extra = next(r for r in runs.data["filas"] if r["que"] == "Una fila nueva")
            self.assertFalse(extra["comparada"])
            self.assertEqual(extra["antes"]["texto"], "no se midió")
            _assert_traces(self, runs)

    def test_a_missing_value_is_not_measured_not_none(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            del runs.after["tablas"]["correo"]["filas"][0]["valor"]
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            self.assertNotIn("None", runs.report)
            row = next(r for r in runs.data["filas"] if r["que"] == "Quién puede enviar en nombre del dominio")
            self.assertEqual((row["despues"]["texto"], row["comparada"]), ("no se midió", False))

    def test_change_direction(self) -> None:
        self.assertEqual(compare._mail_change("falta", "configurada: los rechaza"), "se agregó")
        self.assertEqual(compare._mail_change("configurada", "falta"), "se quitó")
        self.assertEqual(compare._mail_change("configurada: solo observa", "configurada: los rechaza"), "mejoró")
        self.assertEqual(compare._mail_change("configurada", "incompleta"), "empeoró")
        self.assertEqual(compare._mail_change("no se pudo confirmar desde afuera", "configurada"), "cambió")


class ControlAndCountsTest(unittest.TestCase):
    def test_server_time_needs_a_valid_control_in_both_runs(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            ext20 = _check(runs.after, "EXT-20")
            ext20.update(estado="NO_VERIFICADO", motivo_no_verificado="el sitio de control tardó más de 0,8 segundos")
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            row = runs.row("ttfb")
            self.assertFalse(row["comparada"])
            self.assertEqual(row["motivo"], "sin un control válido en las dos fechas: el sitio de control tardó más de 0,8 segundos")

    def test_grey_counts_as_applicable_and_not_passed_and_not_applicable_is_left_out(self) -> None:
        run = compare.StoredRun(
            folder=Path("."),
            datos={},
            meta={},
            checks={
                "EXT-01": {"modulo": "EXT", "estado": "APROBADO"},
                "EXT-02": {"modulo": "EXT", "estado": "NO_VERIFICADO"},
                "EXT-03": {"modulo": "EXT", "estado": "APROBADO_CON_OBSERVACION"},
                "VIS-01": {"modulo": "VIS", "estado": "NO_APLICA"},
                "VIS-02": {"modulo": "VIS", "estado": "FALLA"},
            },
            started=None,
        )
        counts = compare.module_counts(run)
        self.assertEqual(counts["EXT"], {"aprobados": 1, "con_observacion": 1, "sin_verificar": 1, "aplicables": 3})
        self.assertEqual(counts["VIS"], {"aprobados": 0, "con_observacion": 0, "sin_verificar": 0, "aplicables": 1})
        self.assertEqual(counts["TOTAL"]["aplicables"], 4)

    def test_a_check_that_turns_grey_is_not_called_better_or_worse(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            _check(runs.after, "VIS-01").update(estado="NO_VERIFICADO", color_final="gris")
            code, _, err = runs.run()
            self.assertEqual(code, 0, err)
            kinds = {t["id"]: t["tipo"] for t in runs.data["transiciones"]}
            self.assertEqual(kinds["VIS-01"], "otro")
            self.assertIn("### Otros cambios (1)", runs.report)

    def test_text_control_failure_is_exit_4_with_files_written(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            phrase = _check(runs.after, "VIS-04")["frase_informe_llena"]
            phrase["que_se_encontro"] = "Un texto inseguro que no tendría que llegar al lector"
            code, _, err = runs.run()
            self.assertEqual(code, int(ExitCode.TEXT_CONTROL))
            self.assertIn("palabra-prohibida", err)
            self.assertTrue((runs.after_dir / compare.REPORT).exists())
            self.assertEqual(runs.data["salida"]["control_texto"][0]["regla"], "palabra-prohibida")


class CompareCliTest(unittest.TestCase):
    def test_cli_end_to_end(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            runs.write()
            code, out, err = run_cli(["--compare", str(runs.before_dir), str(runs.after_dir / "datos.json")])
            self.assertEqual(code, 0, err)
            self.assertIn("Checks passed: 19/36 before, 25/36 after; 8 colour changes.", out)

    def test_cli_refuses_other_options(self) -> None:
        code, _, err = run_cli(["https://www.example.org/", "--compare", str(EXAMPLES), str(EXAMPLES / "after")])
        self.assertEqual(code, 2)
        self.assertIn("--compare reads two stored runs and takes no other options (got a URL)", err)

    def test_cli_refuses_measurement_options(self) -> None:
        for option in (["--observatory"], ["--no-pagespeed"], ["--psi-runs", "3"], ["--pause=5"], ["--max-requests", "40"]):
            code, _, err = run_cli(["--compare", str(EXAMPLES), str(EXAMPLES / "after"), *option])
            self.assertEqual(code, 2, option)
            self.assertIn(f"takes no other options (got {option[0].split('=')[0]})", err)

    def test_cli_missing_run(self) -> None:
        with temp_dir() as root:
            code, _, err = run_cli(["--compare", str(EXAMPLES), str(root / "no-existe")])
        self.assertEqual(code, 2)
        self.assertIn("the --compare AFTER run does not exist", err)

    def test_the_same_run_twice(self) -> None:
        code, _, err = run_cli(["--compare", str(EXAMPLES), str(EXAMPLES / "datos.json")])
        self.assertEqual(code, 2)
        self.assertIn("--compare needs two different runs", err)

    def test_wrong_order_is_refused(self) -> None:
        with temp_dir() as root:
            runs = _Runs(root)
            runs.before, runs.after = copy.deepcopy(runs.after), copy.deepcopy(runs.before)
            code, _, err = runs.run()
        self.assertEqual(code, int(ExitCode.NOT_COMPARABLE))
        self.assertIn("pass the older run first", err)


class CompareExampleIsReproducibleTest(unittest.TestCase):
    """examples/after/ is what examples/make_compare_example.py builds today, byte for byte."""

    def test_a_fresh_build_matches_the_committed_files(self) -> None:
        spec = importlib.util.spec_from_file_location("make_compare_example", EXAMPLES / "make_compare_example.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with temp_dir() as root:
            before = root / "antes"
            before.mkdir()
            shutil.copyfile(BEFORE, before / "datos.json")
            fresh = root / "after"
            code, _, err = module.build(before, fresh)
            self.assertEqual(code, 0, err)
            for name in module.FILES:
                self.assertEqual(
                    (fresh / name).read_bytes(), (EXAMPLES / "after" / name).read_bytes(),
                    f"examples/after/{name} is stale: run python3 examples/make_compare_example.py",
                )


if __name__ == "__main__":
    unittest.main()
