"""Unit tests of the output layer: exit codes, text control, the exclusion list,
outputs, rendering and the CLI.
"""

from __future__ import annotations

import datetime as dt
import json
import unittest

import support  # noqa: F401
from support import TEST_KEY, run_cli, temp_dir

from sitecheck import exclusions, exitcodes, outputs, render_report, textlint
from sitecheck.checks.header import GoogleSummary
from sitecheck.checks.tables import MailAuthTable, VelocityTable
from sitecheck.cli import parse_args
from sitecheck.config import RunConfig
from sitecheck.credentials import Redactor
from sitecheck.exitcodes import ExitCode, OutcomeFlags
from sitecheck.model import Colour, Finding, Module, Priority, ReportPhrase, State


def candidate(cid: str, *, state: State = State.FALLA, eligible: bool = True, hack: bool = False, colour: Colour = Colour.AZUL,
              priority: Priority = Priority.MEDIA, phrase: str | None = None) -> Finding:
    return Finding(
        id=cid,
        name_plain=f"Nombre de {cid}",
        module=Module(cid.split("-")[0]),
        priority=priority,
        state=state,
        phrase_report=ReportPhrase(f"Se encontró {cid}", "Consecuencia", f"Se hace {cid}", "Quien mantiene el sitio"),
        evidence_ok=True,
        hack_signal=hack,
        colour=colour,
        colour_derived=colour,
    )


class ExitCodeValuesTest(unittest.TestCase):
    """The table is a contract (passes on the skeleton)."""

    def test_values(self) -> None:
        self.assertEqual(
            {c.name: c.value for c in ExitCode},
            {"OK": 0, "UNEXPECTED": 1, "USAGE": 2, "HOME_UNREACHABLE": 3, "TEXT_CONTROL": 4, "NOT_COMPARABLE": 5, "HACK_GATE": 30, "EXCLUDED": 10, "SCOPE_VIOLATION": 50},
        )


class ExitCodeResolveTest(unittest.TestCase):
    def test_precedence(self) -> None:
        self.assertEqual(exitcodes.resolve(OutcomeFlags()), ExitCode.OK)
        self.assertEqual(exitcodes.resolve(OutcomeFlags(hack_gate=True)), ExitCode.HACK_GATE)
        self.assertEqual(exitcodes.resolve(OutcomeFlags(hack_gate=True, text_control_failed=True)), ExitCode.TEXT_CONTROL)
        self.assertEqual(exitcodes.resolve(OutcomeFlags(home_unreachable=True, text_control_failed=True)), ExitCode.HOME_UNREACHABLE)
        self.assertEqual(exitcodes.resolve(OutcomeFlags(scope_violation=True, home_unreachable=True)), ExitCode.SCOPE_VIOLATION)
        self.assertEqual(exitcodes.resolve(OutcomeFlags(excluded=True, scope_violation=True)), ExitCode.EXCLUDED)
        self.assertEqual(exitcodes.resolve(OutcomeFlags(usage_error=True, excluded=True)), ExitCode.USAGE)


class TextLintTest(unittest.TestCase):
    def rules(self, text: str, redactor: Redactor | None = None) -> list[str]:
        return [i.rule for i in textlint.lint_text(text, name="informe.md", redactor=redactor)]

    def test_clean_template_passes(self) -> None:
        self.assertEqual(self.rules("Además, después de más de un año, el inglés del sitio está bien."), [])

    def test_each_rule(self) -> None:
        self.assertEqual(self.rules("El Certificado vence."), ["palabra-prohibida"])
        self.assertEqual(self.rules("Queda pendiente."), ["palabra-prohibida"])
        self.assertEqual(self.rules("La versión es insecure."), ["palabra-prohibida"])
        self.assertEqual(self.rules("Si tenés dudas, escribime."), ["voseo", "voseo"])
        self.assertEqual(self.rules("Uno \u2014 dos"), ["raya"])
        self.assertEqual(self.rules("Uno \u2013 dos"), ["raya"])
        self.assertEqual(self.rules("Tarda {lcp_s} segundos."), ["marcador"])
        self.assertEqual(self.rules("Escriban a info@colegio.test"), ["correo"])
        self.assertEqual(self.rules(f"clave {TEST_KEY}", Redactor([TEST_KEY])), ["clave"])

    def test_line_numbers_and_redaction(self) -> None:
        issues = textlint.lint_text(f"ok\nok\nclave {TEST_KEY}\n", name="informe.md", redactor=Redactor([TEST_KEY]))
        self.assertEqual(issues[0].line, 3)
        self.assertNotIn(TEST_KEY, issues[0].excerpt)


class ExclusionListTest(unittest.TestCase):
    def test_entries_and_matching(self) -> None:
        self.assertEqual(exclusions.parse_line("https://www.Colegio-Ejemplo.TEST/inicio"), (["colegio-ejemplo.test"], None))
        self.assertEqual(exclusions.parse_line("  colegio.test  pidió no ser medido"), (["colegio.test"], None))
        self.assertEqual(exclusions.parse_line("*.red-escuelas.test"), (["red-escuelas.test"], None))
        self.assertEqual(exclusions.parse_line("# a comment"), ([], None))
        self.assertEqual(exclusions.parse_line(""), ([], None))
        self.assertEqual(exclusions.parse_line("not a domain"), ([], exclusions.PROBLEM_NOT_A_DOMAIN))
        with temp_dir() as out:
            (out / "exclude.txt").write_text("# opted out\nred-escuelas.test\na.otra-red.test\n", encoding="utf-8")
            lst = exclusions.load([out / "exclude.txt"])
            self.assertEqual(lst.match("https://www.red-escuelas.test/"), "red-escuelas.test")
            self.assertEqual(lst.match("escuela1.red-escuelas.test"), "red-escuelas.test")
            self.assertEqual(lst.match("a.otra-red.test"), "a.otra-red.test")
            self.assertIsNone(lst.match("b.otra-red.test"))
            self.assertIsNone(lst.match("micolegio.test"))
        with temp_dir() as empty:
            self.assertEqual(exclusions.load([empty / "exclude.txt", None]).entries, [])

    def test_two_files_are_merged_and_a_bad_line_is_a_problem(self) -> None:
        with temp_dir() as out:
            a, b = out / "a.txt", out / "b.txt"
            a.write_text("\ufeffuno.test\n", encoding="utf-8")
            b.write_text("dos.test\nfrase sin dominio\n", encoding="utf-8")
            lst = exclusions.load([a, b, a])
            self.assertEqual(lst.entries, ["uno.test", "dos.test"])
            self.assertEqual(lst.problems, [(b, 2, exclusions.PROBLEM_NOT_A_DOMAIN)])
            self.assertEqual(lst.sources, [a, b])
            self.assertIn("line 2", lst.problems_message())

    def test_prior_runs(self) -> None:
        with temp_dir() as out:
            for name in ("2026-10-01", "2026-10-01-2", "notas"):
                (out / "colegio.test" / name).mkdir(parents=True)
            self.assertEqual(exclusions.prior_runs(out, "colegio.test"), ["2026-10-01", "2026-10-01-2"])
            self.assertEqual(exclusions.prior_runs(out, "otro.test"), [])


class OutputsTest(unittest.TestCase):
    def test_run_dirs_are_never_reused(self) -> None:
        with temp_dir() as salidas:
            a = outputs.create_run_dir(salidas, "colegio.test", dt.date(2026, 10, 9))
            b = outputs.create_run_dir(salidas, "colegio.test", dt.date(2026, 10, 9))
            self.assertEqual(a.root, salidas / "colegio.test" / "2026-10-09")
            self.assertEqual(b.root, salidas / "colegio.test" / "2026-10-09-2")
            self.assertTrue(a.evidencia.is_dir())
            self.assertEqual(a.requests_log, a.evidencia / "requests.log")

    def test_datos_roundtrip_and_schema(self) -> None:
        with temp_dir() as salidas:
            paths = outputs.create_run_dir(salidas, "colegio.test", dt.date(2026, 10, 9))
            outputs.write_datos(paths, {"schema_version": 1, "meta": {"institucion": "Colegio Ejemplo"}})
            self.assertEqual(outputs.read_datos(paths.datos)["meta"]["institucion"], "Colegio Ejemplo")
            raw = paths.datos.read_text(encoding="utf-8")
            self.assertIn("Colegio Ejemplo", raw, "ensure_ascii=False")
            bad = salidas / "viejo.json"
            bad.write_text(json.dumps({"schema_version": 99}), encoding="utf-8")
            with self.assertRaises(ValueError):
                outputs.read_datos(bad)

    def test_sweeps(self) -> None:
        self.assertEqual(outputs.foreign_emails("Escribir a info@colegio.test"), ["info@colegio.test"])
        self.assertEqual(outputs.foreign_emails("Escribir a info@colegio.test", frozenset({"info@colegio.test"})), [])
        with temp_dir() as root:
            (root / "ok.txt").write_text("nada", encoding="utf-8")
            leak = root / "evidencia" / "psi-mobile-1.json"
            leak.parent.mkdir()
            leak.write_text(f'{{"k": "{TEST_KEY}"}}', encoding="utf-8")
            deleted = outputs.sweep_secrets(root, Redactor([TEST_KEY]))
            self.assertEqual(deleted, [leak])
            self.assertFalse(leak.exists())
            self.assertTrue((root / "ok.txt").exists())


def report_ctx(findings: list[Finding], hack: bool = False) -> render_report.ReportContext:
    start = dt.datetime(2026, 10, 9, 14, 5, tzinfo=dt.timezone(dt.timedelta(hours=-3)))
    return render_report.ReportContext(
        institution="Colegio Ejemplo",
        domain="colegio.test",
        run_date=dt.date(2026, 10, 9),
        para="Dirección",
        started_local=start,
        finished_local=start + dt.timedelta(minutes=8),
        findings=findings,
        google_summary=GoogleSummary(reason="la cuota de Google se agotó ese día"),
        velocity=VelocityTable(intro="Medida en un celular, tres veces, con el valor del medio."),
        mail_auth=MailAuthTable(),
        hack_gate=hack,
        n_site_requests=41,
        site_minutes=4,
    )


class RenderTest(unittest.TestCase):
    FINDINGS = [
        candidate("EXT-01", colour=Colour.ROJO, priority=Priority.ALTA),
        candidate("VIS-04", colour=Colour.AZUL),
        candidate("EXT-02", colour=Colour.AMARILLO),
        candidate("EXT-07", state=State.APROBADO, colour=Colour.VERDE, priority=Priority.ALTA),
        candidate("EXT-13", state=State.NO_VERIFICADO, colour=Colour.GRIS, priority=Priority.ALTA),
        candidate("VIS-08", state=State.NO_APLICA, colour=Colour.OCULTO, priority=Priority.BAJA),
    ]

    def test_report_reading_order_folding_and_denominator(self) -> None:
        text = render_report.render_report(report_ctx(self.FINDINGS))
        self.assertTrue(text.startswith("**Colegio Ejemplo · Estado del sitio colegio.test**"))
        self.assertIn("Fecha: 9/10/2026 · Para: Dirección", text)
        red, yellow, blue = text.index("▲ Arreglar ya"), text.index("■ Revisar"), text.index("◆ Mejora opcional")
        self.assertLess(red, yellow)
        self.assertLess(yellow, blue)
        self.assertIn("<details><summary>● 1 cosa bien</summary>", text, "singular written in full")
        self.assertIn("<details><summary>○ 1 cosa que no se pudo ver</summary>", text)
        self.assertLess(blue, text.index("<details><summary>●"))
        self.assertIn("**5 chequeos aplicables:**", text)
        self.assertNotIn("Se encontró VIS-08", text.split("## Anexo técnico")[0], "NO_APLICA is not shown in the client part")
        self.assertNotIn("{", text)
        for bad in ("\u2014", "\u2013", "certificado"):
            self.assertNotIn(bad, text)

    def test_empty_groups_are_omitted(self) -> None:
        text = render_report.render_report(report_ctx([candidate("VIS-04", colour=Colour.AZUL)]))
        self.assertNotIn("▲ Arreglar ya", text)
        self.assertNotIn("■ Revisar", text)

    def test_five_lines_and_next_step(self) -> None:
        lines = render_report.five_lines(self.FINDINGS)
        self.assertEqual(lines[:3], ["Se encontró EXT-01", "Se encontró EXT-02", "Se encontró VIS-04"])
        self.assertEqual(lines[3], "Se encontró EXT-07")
        self.assertEqual(lines[4], "Lo primero: se hace EXT-01; después, se hace EXT-02.")
        self.assertEqual(render_report.next_step(self.FINDINGS, hack_gate=True)[0], render_report.STEP_COMPROMISED)
        self.assertEqual(render_report.next_step(self.FINDINGS, hack_gate=False)[0], render_report.STEP_FIX)
        all_green = [candidate("EXT-07", state=State.APROBADO, colour=Colour.VERDE), candidate("EXT-13", state=State.NO_VERIFICADO, colour=Colour.GRIS)]
        self.assertEqual(render_report.next_step(all_green, hack_gate=False)[0], render_report.STEP_KEEP)


class CliTest(unittest.TestCase):
    def test_defaults(self) -> None:
        c = parse_args(["https://www.colegio-ejemplo.edu.ar/"])
        self.assertIsInstance(c, RunConfig)
        self.assertFalse(c.test_mode)
        c = parse_args(["https://www.colegio-ejemplo.edu.ar", "--name", "Colegio X", "--psi-runs", "1", "--observatory"])
        self.assertEqual((c.institution, c.psi_runs, c.observatory), ("Colegio X", 1, True))
        with temp_dir() as d:
            datos = d / "datos.json"
            datos.write_text("{}", encoding="utf-8")
            c = parse_args(["--rerender", str(datos)])
            self.assertEqual(c.rerender_from, datos)

    def test_invalid_input_is_exit_2(self) -> None:
        for argv in (
            ["ftp://colegio-ejemplo.edu.ar/"],
            ["https://www.colegio-ejemplo.edu.ar/inicio/"],
            ["https://user:pass@colegio-ejemplo.edu.ar/"],
            ["https://www.colegio-ejemplo.edu.ar/", "--psi-runs", "0"],
            ["https://www.colegio-ejemplo.edu.ar/", "--test-loopback", "127.0.0.1:8000"],
            ["https://www.colegio.test/", "--test-loopback", "10.0.0.5:8000"],
            ["https://www.colegio.test/", "--test-loopback", "127.0.0.1:8000", "--test-services", "http://example.com:80"],
        ):
            code, _, _ = run_cli(argv)
            self.assertEqual(code, 2, argv)

    def test_help_hides_test_flags(self) -> None:
        code, out, _ = run_cli(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--name", out)
        self.assertNotIn("--test-loopback", out)
        self.assertNotIn("--test-services", out)


class CliExtrasTest(unittest.TestCase):
    """--no-pagespeed, --pause, --max-requests, --out and the stricter input checks."""

    def test_new_options(self) -> None:
        c = parse_args(["https://www.colegio-ejemplo.edu.ar/", "--no-pagespeed", "--pause", "5", "--max-requests", "40"])
        self.assertEqual((c.psi_enabled, c.pace_seconds, c.site_budget), (False, 5.0, 40))
        c = parse_args(["https://www.colegio-ejemplo.edu.ar/"])
        self.assertEqual((c.psi_enabled, c.pace_seconds, c.site_budget), (True, 3.0, 90))
        with temp_dir() as d:
            c = parse_args(["https://www.colegio-ejemplo.edu.ar/", "--out", str(d)])
            self.assertEqual(c.out_root, d)

    def test_more_invalid_input_is_exit_2(self) -> None:
        with temp_dir() as d:
            datos = d / "datos.json"
            datos.write_text("{}", encoding="utf-8")
            for argv in (
                [],
                ["https://www.colegio-ejemplo.edu.ar/", "--pause", "2"],
                ["https://www.colegio-ejemplo.edu.ar/", "--max-requests", "91"],
                ["https://www.colegio-ejemplo.edu.ar/?a=1"],
                ["https://www.colegio-ejemplo.edu.ar:8443/"],
                ["https://192.168.0.1/"],
                ["https://www.colegio.test/"],
                ["https://www.colegio.test/", "--test-loopback", "127.0.0.1:8000"],
                ["https://www.colegio-ejemplo.edu.ar/", "--rerender", str(datos)],
                ["--rerender", str(d / "no-existe.json")],
                ["https://www.colegio-ejemplo.edu.ar/", "--inner-page", "/inicio/"],
                ["https://www.colegio-ejemplo.edu.ar/", "--name", "  "],
            ):
                code, _, err = run_cli(argv)
                self.assertEqual(code, 2, argv)
                self.assertIn("Usage error", err, argv)

    def test_a_missing_exclusion_list_from_the_environment_is_exit_2(self) -> None:
        import os
        from unittest import mock

        with temp_dir() as d:
            missing = d / "no-such-list.txt"
            with mock.patch.dict(os.environ, {exclusions.ENV_VAR: str(missing)}):
                code, _, err = run_cli(["https://www.colegio-ejemplo.edu.ar/"])
            self.assertEqual(code, 2)
            self.assertIn("SITE_CHECK_EXCLUDE", err)
            present = d / "list.txt"
            present.write_text("otro-ejemplo.test\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {exclusions.ENV_VAR: str(present)}):
                self.assertEqual(parse_args(["https://www.colegio-ejemplo.edu.ar/"]).exclude, present)

    def test_a_real_run_needs_a_control_domain(self) -> None:
        import os
        from unittest import mock

        for value in ("", "   ", "https://example.org/", "192.0.2.10", "example.org/path"):
            with mock.patch.dict(os.environ, {"SITE_CHECK_CONTROL_DOMAIN": value}):
                code, _, err = run_cli(["https://www.colegio-ejemplo.edu.ar/"])
            self.assertEqual(code, 2, value)
            self.assertIn("SITE_CHECK_CONTROL_DOMAIN", err, value)
        with mock.patch.dict(os.environ, {"SITE_CHECK_CONTROL_DOMAIN": "Control-Ejemplo.example."}):
            parse_args(["https://www.colegio-ejemplo.edu.ar/"])
            from sitecheck.endpoints import Endpoints

            e = Endpoints()
            self.assertEqual((e.control_domain, e.control_url), ("control-ejemplo.example", "https://control-ejemplo.example/"))

    def test_test_hooks_together(self) -> None:
        c = parse_args(["https://www.colegio.test/", "--test-loopback", "127.0.0.1:8000", "--test-services", "http://127.0.0.1:9000"])
        self.assertTrue(c.test_mode)
        self.assertEqual((c.test_loopback, c.test_services), ("127.0.0.1:8000", "http://127.0.0.1:9000"))

    def test_rerender_leaves_to_and_kind_to_datos(self) -> None:
        with temp_dir() as d:
            datos = d / "datos.json"
            datos.write_text("{}", encoding="utf-8")
            c = parse_args(["--rerender", str(datos)])
            self.assertEqual((c.para, c.institution, c.url), ("", None, ""))
            c = parse_args(["--rerender", str(datos), "--to", "Rectoría"])
            self.assertEqual(c.para, "Rectoría")

    def test_stdlib_guard_is_clean(self) -> None:
        from sitecheck import cli

        cli._load_package()
        self.assertEqual(cli.assert_stdlib_only(), [])


class OutputsExtrasTest(unittest.TestCase):
    def test_guards(self) -> None:
        with temp_dir() as salidas:
            paths = outputs.create_run_dir(salidas, "colegio.test", dt.date(2026, 10, 9))
            with self.assertRaises(ValueError):
                outputs.write_text(paths.datos, "{}")
            with self.assertRaises(ValueError):
                outputs.write_text(paths.evidencia / "home.html", "x")
            with self.assertRaises(ValueError):
                outputs.create_run_dir(salidas, "../afuera", dt.date(2026, 10, 9))
            outputs.write_datos(paths, {"schema_version": 1})
            with self.assertRaises(ValueError):
                outputs.write_datos(paths, {"schema_version": 1})
            outputs.write_datos(paths, {"schema_version": 1, "n": 2}, rerender=True)
            outputs.write_datos(paths, {"schema_version": 1, "n": 3}, rerender=True)
            self.assertEqual(json.loads((paths.root / "datos-1.json").read_text(encoding="utf-8")), {"schema_version": 1})
            self.assertEqual(json.loads((paths.root / "datos-2.json").read_text(encoding="utf-8"))["n"], 2)
            self.assertEqual(outputs.read_datos(paths.datos)["n"], 3)

    def test_tiempo_in_buenos_aires_time(self) -> None:
        with temp_dir() as salidas:
            paths = outputs.create_run_dir(salidas, "colegio.test", dt.date(2026, 10, 9))
            start = dt.datetime(2026, 10, 9, 17, 5, tzinfo=dt.timezone.utc)
            outputs.write_tiempo(paths, start, start + dt.timedelta(minutes=8))
            self.assertEqual(paths.tiempo.read_text(encoding="utf-8"), "inicio: 9/10/2026 14:05\nfin: 9/10/2026 14:13\n")


class TextLintExtrasTest(unittest.TestCase):
    def rules(self, text: str) -> list[str]:
        return [i.rule for i in textlint.lint_text(text, name="informe.md")]

    def test_voseo_is_accent_sensitive_and_usted_passes(self) -> None:
        self.assertEqual(self.rules("Mira el informe y mire la tabla."), [])
        self.assertEqual(self.rules("Mirá el informe."), ["voseo"])
        self.assertEqual(self.rules("Si usted sos... no."), ["voseo"])
        self.assertEqual(self.rules("Los INSEGUROS y la certificación."), ["palabra-prohibida"])


class RenderExtrasTest(unittest.TestCase):
    def test_singular_counts_and_grey_question(self) -> None:
        grey = candidate("EXT-13", state=State.NO_VERIFICADO, colour=Colour.GRIS, priority=Priority.ALTA)
        grey.name_plain = "¿El dominio está por vencer?"
        grey.phrase_report = ReportPhrase("el registro del dominio no respondió")
        ctx = report_ctx([candidate("VIS-04", colour=Colour.AZUL), grey])
        text = render_report.render_report(ctx)
        self.assertIn("**2 chequeos aplicables:** ▲ 0 para arreglar ya · ■ 0 para revisar · ◆ 1 mejora opcional · ● 0 bien · ○ 1 que no se pudo ver.", text)
        self.assertIn("- ¿El dominio está por vencer? El registro del dominio no respondió.", text)
        # the manual check is written once, in the annex, never in the report.
        self.assertNotIn("lookup.icann.org", text)
        self.assertIn("- Vencimiento del dominio: https://lookup.icann.org/", render_report.render_annex(ctx))
        self.assertIn("Se hicieron 41 pedidos a su sitio en 4 minutos", text)

    def test_next_step_when_nothing_was_measured_and_only_blues(self) -> None:
        greys = [candidate("EXT-13", state=State.NO_VERIFICADO, colour=Colour.GRIS)]
        self.assertEqual(render_report.next_step(greys, hack_gate=False)[0], "Repetir el chequeo")
        blues = [candidate("VIS-04", colour=Colour.AZUL)]
        self.assertEqual(
            render_report.next_step(blues, hack_gate=False, kind="instituto")[0],
            "Las mejoras opcionales, si el instituto quiere mejorar cómo se ve y se encuentra",
        )

    def test_lower_first_keeps_names(self) -> None:
        self.assertEqual(render_report.lower_first("Actualizar WordPress."), "actualizar WordPress.")
        self.assertEqual(render_report.lower_first("WordPress muestra su versión"), "WordPress muestra su versión")
        self.assertEqual(render_report.lower_first("DMARC falta"), "DMARC falta")


class _FakeLog:
    def counts(self) -> dict:
        return {"site": 12}

    def site_window(self) -> tuple[str, str]:
        return ("2026-10-09T17:05:00+00:00", "2026-10-09T17:07:40+00:00")


def _fake_services_factory(leak: bool = False):  # type: ignore[no-untyped-def]
    import types

    def factory(config, evidence_dir, *, sleeper):  # type: ignore[no-untyped-def]
        (evidence_dir / "requests.log").write_text("{}\n", encoding="utf-8")
        if leak:
            (evidence_dir / "psi-mobile-1.json").write_text(f'{{"k": "{TEST_KEY}"}}', encoding="utf-8")
        return types.SimpleNamespace(
            redactor=Redactor([TEST_KEY]),
            key=types.SimpleNamespace(present=True, as_datos=lambda: "presente"),
            log=_FakeLog(),
            guard=types.SimpleNamespace(describe=lambda: {"rechazados": ["mailto:info@colegio.test", "https://wa.me/5491123456789"]}),
            artifacts=types.SimpleNamespace(written_map=lambda: {"home.html": True}),
            psi=object(),
            crux=object(),
        )

    return factory


class PipelineWithFakesTest(unittest.TestCase):
    """OUT's own paths of pipeline.run, with collect and evaluate replaced by hand-made results."""

    def run_pipeline(self, findings, *, leak=False, collect_error=None, **cfg):  # type: ignore[no-untyped-def]
        import io
        from unittest import mock

        from sitecheck import evaluate, pipeline
        from sitecheck.observations import Observations

        seen = {}

        def fake_collect(config, services, *, no_contact_check=None, progress=None):  # type: ignore[no-untyped-def]
            seen["psi"] = services.psi
            if collect_error is not None:
                raise collect_error
            obs = Observations(input_url=config.url, registrable="colegio.test")
            obs.site_requests = 12
            return obs

        def fake_evaluate_all(obs, ctx, overrides=None):  # type: ignore[no-untyped-def]
            return evaluate.EvaluationResult(
                findings=findings,
                google_summary=GoogleSummary(reason="la cuota de Google se agotó ese día"),
                velocity=VelocityTable(intro="Medida en un celular, tres veces, con el valor del medio."),
                mail_auth=MailAuthTable(),
                hack_gate=evaluate.HackGate(active=any(f.hack_signal for f in findings)),
            )

        salidas_cm = temp_dir()
        salidas = salidas_cm.__enter__()
        self.addCleanup(salidas_cm.__exit__, None, None, None)
        config = RunConfig(
            url="https://www.colegio.test/", institution="Colegio Ejemplo", out_root=salidas,
            test_loopback="127.0.0.1:1", test_services="http://127.0.0.1:1", **cfg,
        )
        with mock.patch("sitecheck.collect.collect", fake_collect), \
                mock.patch.object(evaluate, "build_pages", lambda obs: {}), \
                mock.patch.object(evaluate, "evaluate_all", fake_evaluate_all):
            res = pipeline.run(config, services_factory=_fake_services_factory(leak), stdout=io.StringIO(), stderr=io.StringIO())
        return res, seen

    def mail_findings(self) -> list[Finding]:
        return [
            candidate("VIS-16", phrase="El pie del sitio dice 2019."),
            candidate("VIS-18", colour=Colour.AMARILLO, priority=Priority.MEDIA,
                      phrase="El número de WhatsApp del sitio no tiene el 54 adelante."),
            candidate("EXT-07", state=State.APROBADO, colour=Colour.VERDE, priority=Priority.ALTA),
        ]


    def test_key_in_evidence_is_deleted(self) -> None:
        res, _ = self.run_pipeline(self.mail_findings(), leak=True)
        self.assertEqual(res.exit_code, ExitCode.TEXT_CONTROL)
        self.assertFalse((res.run_dir / "evidencia" / "psi-mobile-1.json").exists())
        self.assertTrue((res.run_dir / "informe.md").exists())
        d = json.loads(res.datos_path.read_text(encoding="utf-8"))
        self.assertIn("evidencia/psi-mobile-1.json", d["salida"]["borrados"])
        self.assertNotIn(TEST_KEY, res.datos_path.read_text(encoding="utf-8"))


    def test_scope_error_is_exit_50_with_datos(self) -> None:
        from sitecheck.scope import ScopeError

        res, _ = self.run_pipeline([], collect_error=ScopeError("refused https://www.colegio.test/wp-json/"))
        self.assertEqual(res.exit_code, ExitCode.SCOPE_VIOLATION)
        d = json.loads(res.datos_path.read_text(encoding="utf-8"))
        self.assertEqual((d["salida"]["codigo"], d["checks"]), (50, []))
        self.assertFalse((res.run_dir / "informe.md").exists())

    def test_sin_pagespeed_swaps_the_clients(self) -> None:
        res, seen = self.run_pipeline(self.mail_findings(), psi_enabled=False)
        series = seen["psi"].run_series("https://www.colegio.test/", 3)
        self.assertEqual((series.status, series.reason), ("omitido", "la medición de velocidad no se pidió en esta corrida"))
        self.assertIn("La medición de velocidad de Google no se hizo en esta corrida.", (res.run_dir / "informe.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
