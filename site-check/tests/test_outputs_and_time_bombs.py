"""Output root, evidence retention, CLI help and the "time bombs".

* The output root comes from --out, then SITE_CHECK_OUT, then the working
  directory; the harness never writes outside its temporary folder.
* Evidence retention: only evidencia/ of runs older than 30 days goes, links
  are never followed, nothing else is ever deleted.
* Time bombs: a WordPress branch missing from the release table, a Lighthouse
  major the audit names were not verified for, the VIS-16 year gate; each is
  warned on the console and recorded in datos.json.
* A --rerender whose datos.json carries a foreign e-mail fails the control.
"""

from __future__ import annotations

import ast
import datetime as dt
import json
import os
import unittest
from pathlib import Path
from unittest import mock

import support  # noqa: F401
from support import TEST_KEY, patched_env, run_cli, temp_dir

from sitecheck import config, doh, domains, outputs, pipeline, psi, wpversions
from sitecheck.checks import content, security
from sitecheck.model import State
from sitecheck.wpapi import WpVersionStatus
from fakeapis import FakeApis
from fakesite import FakeSite
from obsfactory import BASE, html_page, make_ctx, make_obs
from sitefixtures import default_apis, school_scenario

UTC = dt.timezone.utc
DAY = dt.date(2026, 10, 14)  # a Wednesday
# 10:00 in Buenos Aires on Wednesday the clock of the end-to-end runs below.
FIXED = dt.datetime(2026, 10, 14, 13, 0, tzinfo=UTC)


def cli(site: FakeSite, apis: FakeApis, salidas: Path | None, *extra: str, nombre: str | None = "Colegio Ejemplo",
        clock: dt.datetime = FIXED) -> tuple[int, str, str]:
    """The real CLI against the fake site, with the run clock fixed (the dates of the row are then known)."""
    argv = [f"{BASE}/"]
    if nombre:
        argv += ["--name", nombre]
    if salidas is not None:
        argv += ["--out", str(salidas)]
    argv += ["--test-loopback", site.loopback, "--test-services", apis.base, *extra]
    with patched_env(SITE_CHECK_TEST_API_KEY=TEST_KEY, PAGESPEED_API_KEY="REAL-KEY-MUST-NEVER-BE-USED-000"), \
            mock.patch.object(pipeline, "_now_utc", lambda: clock):
        return run_cli(argv)


def only_run(salidas: Path) -> Path:
    runs = sorted(p for p in (salidas / "colegio.test").iterdir() if p.is_dir())
    assert len(runs) == 1, runs
    return runs[0]


class CommandsTest(unittest.TestCase):
    def test_help_shows_an_example_and_every_option(self) -> None:
        code, out, _ = run_cli(["--help"])
        self.assertEqual(code, 0)
        flat = " ".join(out.split())
        self.assertIn(
            'Example: SITE_CHECK_CONTROL_DOMAIN=your-own-site.example python3 -m sitecheck https://www.example.org/ '
            '--name "Example School" --kind colegio',
            flat,
        )
        for option in ("--name", "--kind", "--to", "--inner-page", "--form-page", "--psi-runs", "--no-pagespeed",
                       "--pause", "--max-requests", "--overrides", "--rerender", "--out", "--exclude"):
            self.assertIn(option, flat)
        self.assertNotIn("--test-loopback", flat, "the test hooks stay hidden")


    def test_the_stray_module_message_names_the_isolated_command(self) -> None:
        from sitecheck import cli

        with mock.patch.object(cli, "assert_stdlib_only", lambda: ["requests"]):
            code, _, err = run_cli(["--version"])
        self.assertEqual(code, 2)
        self.assertIn(
            "Configuration error: modules outside the standard library were loaded: requests. Run with python3 -I -S.",
            err,
        )


# ---------------------------------------------------------------------------
# C. Time bombs
# ---------------------------------------------------------------------------


class Ext02BranchMissingTest(unittest.TestCase):
    GEN = '<meta name="generator" content="WordPress {v}">'

    def ext02(self, version: str, status: WpVersionStatus):
        obs = make_obs(html_page(head=self.GEN.format(v=version)), wp_status=status)
        return security.evaluate_ext02(obs, make_ctx(obs))

    def test_an_insecure_release_of_a_branch_missing_from_the_table_keeps_its_case(self) -> None:
        # "insecure" is still read before the branch date, and it still decides the report consequence.
        f = self.ext02("7.2.1", WpVersionStatus("7.2.1", "insecure", "7.2.3", True, branch_highest="7.2.3"))
        self.assertEqual(security._ext02_case("7.2.1", "insecure", "7.2.3", False, None, None), "insegura")
        self.assertEqual(f.phrase_report.consequence, "Alguien puede buscar fallas conocidas de esa versión y entrar")
        self.assertEqual(f.phrase_report.found, "El sitio funciona con WordPress 7.2.1, y la versión se ve desde afuera")

    def test_control_an_outdated_release_of_that_branch_has_no_sentence(self) -> None:
        f = self.ext02("7.2.1", WpVersionStatus("7.2.1", "outdated", "7.2.3", True, branch_highest="7.2.3"))
        self.assertEqual(f.state, State.FALLA)
        self.assertIsNone(security._ext02_case("7.2.1", "outdated", "7.2.3", False, None, None))

    def test_the_table_note(self) -> None:
        self.assertEqual(
            wpversions.table_stale_note("7.2.3"),
            "La tabla de versiones de WordPress no tiene la rama 7.2: actualizar wpversions.py (se verificó por última "
            "vez el 8/10/2026).",
        )
        self.assertEqual(wpversions.missing_branch("8.0"), "8.0")
        # Controls: a branch in the table, and no answer at all.
        self.assertIsNone(wpversions.table_stale_note("7.1.3"))
        self.assertIsNone(wpversions.table_stale_note(None))


class WordpressMajorTest(unittest.TestCase):
    def test_the_boundaries(self) -> None:
        cases = {"2.9.2": False, "3.0": True, "7.1.3": True, "8.0.1": True, "9.9": True, "10.0.1": False}
        for version, expected in cases.items():
            self.assertEqual(wpversions.looks_like_wordpress_branch(version), expected, version)

    def asset_run(self, version: str):
        body = f'<script src="{BASE}/wp-includes/js/wp-emoji-release.min.js?ver={version}"></script>'
        obs = make_obs(html_page(body=body))
        return security.evaluate_ext02(obs, make_ctx(obs))

    def test_an_8_seen_only_through_ver_is_reported(self) -> None:
        f = self.asset_run("8.0.1")
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.measured["version"], "8.0.1")
        self.assertEqual(f.phrase_report.found, "El sitio funciona con WordPress 8.0.1, y la versión se ve desde afuera")

    def test_control_a_10_is_not_read_as_wordpress(self) -> None:
        f = self.asset_run("10.0.1")
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(f.phrase_report.found, "La página no anuncia la versión de WordPress")


class Vis16YearGateInTheReportTest(unittest.TestCase):
    GRACE = "Antes de abril es común; si sigue así después de marzo, quien visita el sitio puede pensar que nadie lo mira"
    STALE = "Quien visita el sitio piensa que nadie lo mira, y eso pesa al elegir colegio"

    def vis16(self, body: str, day: dt.date, **fields):
        obs = make_obs(html_page(body=body), **fields)
        return content.evaluate_vis16(obs, make_ctx(obs, run_date=day))

    def test_last_years_footer_in_january_is_not_called_abandoned(self) -> None:
        f = self.vis16("<footer>&copy; 2026 Colegio Ejemplo</footer>", dt.date(2027, 1, 15))
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(f.measured["signals"], [])
        self.assertEqual(f.phrase_report.found, "El pie del sitio muestra el año 2026")
        self.assertEqual(f.phrase_report.consequence, self.GRACE)

    def test_control_the_same_footer_in_june(self) -> None:
        f = self.vis16("<footer>&copy; 2026 Colegio Ejemplo</footer>", dt.date(2027, 6, 15))
        self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(f.phrase_report.found, "El pie dice 2026")
        self.assertEqual(f.phrase_report.consequence, self.STALE)

    def test_january_footer_with_recent_news(self) -> None:
        from sitecheck.observations import FeedFetch
        from sitecheck.sitemapfeed import DocKind, FeedDoc, FeedItem

        feed = FeedFetch(url=f"{BASE}/feed/", doc=FeedDoc(kind=DocKind.RSS, items=[FeedItem("Acto", dt.datetime(2026, 12, 10, 12, tzinfo=UTC))]))
        f = self.vis16("<footer>&copy; 2026 Colegio Ejemplo</footer>", dt.date(2027, 1, 15), feed=feed)
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(f.phrase_report.found, "El pie del sitio muestra el año 2026 y el sitio tiene novedades recientes")
        self.assertEqual(f.phrase_report.consequence, self.GRACE)

    def test_january_ciclo_and_control_in_june(self) -> None:
        f = self.vis16("<p>Ciclo lectivo 2026</p>", dt.date(2027, 1, 15))
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(f.phrase_report.found, "La página principal habla del ciclo lectivo 2026")
        self.assertEqual(f.phrase_report.consequence, self.GRACE)
        g = self.vis16("<p>Ciclo lectivo 2026</p>", dt.date(2027, 6, 15))
        self.assertEqual(g.state, State.APROBADO_CON_OBSERVACION)
        self.assertEqual(g.phrase_report.found, "La portada habla del ciclo lectivo 2026")

    def test_the_report_uses_the_matched_words(self) -> None:
        f = self.vis16("<p>Inscripciones 2025</p><footer>&copy; 2024 Colegio Ejemplo</footer>", dt.date(2026, 6, 15))
        self.assertEqual(f.state, State.FALLA)
        self.assertEqual(f.phrase_report.found, "El pie dice 2024 y la portada habla de las inscripciones 2025")
        # Control: "Ciclo lectivo" keeps its own words.
        g = self.vis16("<p>Ciclo lectivo 2025</p><footer>&copy; 2024 Colegio Ejemplo</footer>", dt.date(2026, 6, 15))
        self.assertEqual(g.phrase_report.found, "El pie dice 2024 y la portada habla del ciclo lectivo 2025")

    def test_a_current_inscription_year_is_named_as_written(self) -> None:
        f = self.vis16("<p>Inscripciones 2027</p>", DAY)
        self.assertEqual(f.state, State.APROBADO)
        self.assertEqual(f.phrase_report.found, "La página principal habla de las inscripciones 2027")
        self.assertEqual(f.phrase_report.consequence, "Se ve cuidado y al día")


class LighthouseMajorTest(unittest.TestCase):
    def test_the_note(self) -> None:
        self.assertEqual(
            psi.lighthouse_note("14.0.0"),
            "PageSpeed respondió con Lighthouse 14.0.0 y los nombres de las pruebas que lee el script se verificaron "
            "con la versión 13: revisar psi.py (AUDIT_CANDIDATES)",
        )
        self.assertIsNotNone(psi.lighthouse_note("beta"))
        # Controls: the verified major, and no PageSpeed answer.
        self.assertIsNone(psi.lighthouse_note("13.5.0"))
        self.assertIsNone(psi.lighthouse_note(None))


class TimeBombRunTest(unittest.TestCase):
    """The two warnings end to end: on the console and in datos.json meta."""

    WP_LINE = (
        "Note: La tabla de versiones de WordPress no tiene la rama 7.2: actualizar wpversions.py (se verificó por "
        "última vez el 8/10/2026)."
    )
    LH_LINE = (
        "Note: PageSpeed respondió con Lighthouse 14.0.0 y los nombres de las pruebas que lee el script se "
        "verificaron con la versión 13: revisar psi.py (AUDIT_CANDIDATES)."
    )

    def test_a_new_lighthouse_major_and_a_new_wordpress_branch_are_warned(self) -> None:
        apis_cfg = default_apis()
        for payload in [*apis_cfg.psi_mobile, apis_cfg.psi_desktop]:
            payload["lighthouseResult"]["lighthouseVersion"] = "14.0.0"
        apis_cfg.wp_stable = {"6.1.1": "insecure", "7.2.0": "latest"}
        with temp_dir() as salidas, FakeSite(school_scenario()) as site, FakeApis(apis_cfg) as apis:
            _, out, _ = cli(site, apis, salidas)
            meta = json.loads((only_run(salidas) / "datos.json").read_text(encoding="utf-8"))["meta"]
        self.assertIn(self.WP_LINE, out.splitlines())
        self.assertIn(self.LH_LINE, out.splitlines())
        self.assertEqual(
            meta["aviso_wordpress"],
            "La tabla de versiones de WordPress no tiene la rama 7.2: actualizar wpversions.py (se verificó por última "
            "vez el 8/10/2026).",
        )
        self.assertEqual(meta["version_lighthouse"], "14.0.0")
        self.assertEqual(
            meta["aviso_lighthouse"],
            "PageSpeed respondió con Lighthouse 14.0.0 y los nombres de las pruebas que lee el script se verificaron "
            "con la versión 13: revisar psi.py (AUDIT_CANDIDATES)",
        )

    def test_control_the_default_run_has_no_warning(self) -> None:
        with temp_dir() as salidas, FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            _, out, _ = cli(site, apis, salidas)
            meta = json.loads((only_run(salidas) / "datos.json").read_text(encoding="utf-8"))["meta"]
        self.assertIsNone(meta["aviso_wordpress"])
        self.assertIsNone(meta["aviso_lighthouse"])
        self.assertNotIn("Atención: la tabla de versiones", out)
        self.assertNotIn("Lighthouse", out)


# ---------------------------------------------------------------------------
# D. Contracts between modules
# ---------------------------------------------------------------------------


class ContractTest(unittest.TestCase):

    def test_the_local_only_suffix_with_the_real_tables(self) -> None:
        # A made-up school under the real esc.edu.ar: Gmail asks _dmarc.esc.edu.ar.
        self.assertEqual(doh.organizational_domain("ejemplo.esc.edu.ar"), "esc.edu.ar")
        # Control: the tool still treats each school under esc.edu.ar as its own site.
        self.assertEqual(domains.site_domain("www.ejemplo.esc.edu.ar"), "ejemplo.esc.edu.ar")

    def test_every_local_only_suffix_is_an_embedded_suffix(self) -> None:
        self.assertEqual(set(doh.LOCAL_ONLY_SUFFIXES) - set(domains.PUBLIC_SUFFIXES), set())
        self.assertIn("esc.edu.ar", doh.LOCAL_ONLY_SUFFIXES)


# ---------------------------------------------------------------------------
# E. Small fixes
# ---------------------------------------------------------------------------


class RerenderDatosProblemTest(unittest.TestCase):
    def measure_then_rerender(self, add_email: bool) -> tuple[int, Path, dict]:
        with temp_dir() as salidas, FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            code, _, err = cli(site, apis, salidas)
            self.assertEqual(code, 0, err)
            rd = only_run(salidas)
            path = rd / "datos.json"
            if add_email:
                d = json.loads(path.read_text(encoding="utf-8"))
                d["meta"]["errores"] = ["contacto: alguien@otro.test"]
                path.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
            code, _, _ = run_cli(["--rerender", str(path)])
            new = json.loads(path.read_text(encoding="utf-8"))
            names = {p.name for p in rd.iterdir()}
        return code, names, new

    def test_a_foreign_email_in_datos_fails_the_control_and_is_masked(self) -> None:
        code, names, new = self.measure_then_rerender(add_email=True)
        self.assertEqual(code, 4)
        self.assertEqual(new["meta"]["errores"], ["contacto: [correo]"])

    def test_control_without_the_email_the_rerender_is_clean(self) -> None:
        code, names, _ = self.measure_then_rerender(add_email=False)
        self.assertEqual(code, 0)


def main_block_is_last(source: str) -> bool:
    """True when ``if __name__ == "__main__":`` (if present) is the last statement of a module."""
    body = ast.parse(source).body
    for i, node in enumerate(body):
        if isinstance(node, ast.If) and "__main__" in ast.unparse(node.test):
            return i == len(body) - 1
    return True


def loaded_ids(module: object) -> list[str]:
    """The ids of every test the default loader finds in ``module``."""
    ids: list[str] = []

    def walk(suite: unittest.TestSuite) -> None:
        for item in suite:
            if isinstance(item, unittest.TestSuite):
                walk(item)
            else:
                ids.append(item.id())

    walk(unittest.TestLoader().loadTestsFromModule(module))
    return ids


class TestFilesTest(unittest.TestCase):
    def test_round4_no_longer_runs_the_round3_intro_tests(self) -> None:
        import test_regressions_wording
        import test_regressions_texts

        self.assertEqual([i for i in loaded_ids(test_regressions_texts) if "IntroListsTest" in i], [])
        # Control: the class still runs once, in its own module.
        self.assertTrue(any("IntroListsTest" in i for i in loaded_ids(test_regressions_wording)))

    def test_no_test_class_after_the_main_block(self) -> None:
        late = [p.name for p in sorted(support.TESTS_DIR.glob("test_*.py")) if not main_block_is_last(p.read_text(encoding="utf-8"))]
        self.assertEqual(late, [])
        # Control: the check flags a class after the block.
        self.assertFalse(main_block_is_last('if __name__ == "__main__":\n    pass\n\nclass Late:\n    pass\n'))

    def test_the_spf_redirect_names_a_test_domain(self) -> None:
        text = (support.TESTS_DIR / "test_regressions_checks.py").read_text(encoding="utf-8")
        self.assertNotIn("proveedor.com", text)
        self.assertIn("redirect=_spf.proveedor.test", text)


# ---------------------------------------------------------------------------
# F. The output root and the evidence retention
# ---------------------------------------------------------------------------


def make_run(root: Path, domain: str, name: str, *, markers: bool = True) -> Path:
    """A run folder as the tool leaves it: datos.json, informe.md and evidencia/ with two files."""
    run = root / domain / name
    (run / "evidencia").mkdir(parents=True)
    (run / "evidencia" / "home.html").write_text("<html></html>", encoding="utf-8")
    if markers:
        (run / "datos.json").write_text("{}", encoding="utf-8")
        (run / "evidencia" / "requests.log").write_text("{}\n", encoding="utf-8")
    (run / "informe.md").write_text("informe", encoding="utf-8")
    return run


def directory_link(target: Path, link: Path) -> bool:
    """A Windows junction or a POSIX symlink to a directory; False where neither can be made (the test skips)."""
    try:
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
        return True
    except (ImportError, AttributeError, OSError):
        pass
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except OSError:
        return False


class RetentionTest(unittest.TestCase):
    def test_old_evidence_goes_and_everything_else_stays(self) -> None:
        with temp_dir() as root:
            old = make_run(root, "colegio.test", "2026-09-13")  # 31 days before 14/10/2026
            old_n = make_run(root, "colegio.test", "2026-08-01-2")
            edge = make_run(root, "colegio.test", "2026-09-14")  # 30 days: kept
            recent = make_run(root, "otro.test", "2026-10-13")
            (root / "exclude.txt").write_text("lista.test\n", encoding="utf-8")
            (root / "colegio.test" / "notas.txt").write_text("notas", encoding="utf-8")
            result = outputs.prune_old_evidence(root, DAY)
            self.assertEqual(sorted(result.removed), sorted([old / "evidencia", old_n / "evidencia"]))
            self.assertEqual(result.failed, [])
            for run in (old, old_n):
                self.assertFalse((run / "evidencia").exists())
                for name in ("datos.json", "informe.md"):
                    self.assertTrue((run / name).is_file(), (run, name))
            for run in (edge, recent):
                self.assertTrue((run / "evidencia" / "home.html").is_file(), run)
            self.assertEqual((root / "exclude.txt").read_text(encoding="utf-8"), "lista.test\n")
            self.assertTrue((root / "colegio.test" / "notas.txt").is_file())

    def test_malformed_names_and_a_file_named_evidencia_are_left_alone(self) -> None:
        with temp_dir() as root:
            kept = [
                make_run(root, "colegio.test", "2026-13-01"),  # not a date
                make_run(root, "colegio.test", "viejo"),
                make_run(root, "colegio.test", "2026-01-01-b"),
                make_run(root, "Notas", "2026-01-01"),  # not a domain folder
                make_run(root, "sin-punto", "2026-01-01"),
                make_run(root, "colegio.test", "2026-01-02", markers=False),  # not written by the tool
            ]
            as_file = root / "colegio.test" / "2026-01-03"
            as_file.mkdir(parents=True)
            (as_file / "datos.json").write_text("{}", encoding="utf-8")
            (as_file / "evidencia").write_text("un archivo", encoding="utf-8")
            result = outputs.prune_old_evidence(root, DAY)
            self.assertEqual(result.removed, [])
            for run in kept:
                self.assertTrue((run / "evidencia" / "home.html").is_file(), run)
            self.assertEqual((as_file / "evidencia").read_text(encoding="utf-8"), "un archivo")
            # Control: the same tree with one well-formed old run loses only that evidence.
            good = make_run(root, "colegio.test", "2026-01-04")
            self.assertEqual(outputs.prune_old_evidence(root, DAY).removed, [good / "evidencia"])

    def test_links_are_never_followed(self) -> None:
        with temp_dir() as tmp:
            root, outside = tmp / "raiz", tmp / "afuera"
            root.mkdir()
            outside_run = make_run(outside, "lejos.test", "2026-01-01")
            # 1. An old run whose evidencia is a link to a folder outside the root.
            run = root / "colegio.test" / "2026-01-01"
            run.mkdir(parents=True)
            (run / "datos.json").write_text("{}", encoding="utf-8")
            if not directory_link(outside_run / "evidencia", run / "evidencia"):
                self.skipTest("directory links cannot be created here")
            # 2. A domain folder that is a link to another tree with old runs.
            directory_link(outside / "lejos.test", root / "lejos.test")
            # 3. A link inside an old evidencia folder: the folder goes, the target stays.
            inner = make_run(root, "otro.test", "2026-01-01")
            directory_link(outside / "lejos.test", inner / "evidencia" / "enlace")
            result = outputs.prune_old_evidence(root, DAY)
            self.assertEqual(result.removed, [inner / "evidencia"])
            self.assertTrue((outside_run / "evidencia" / "home.html").is_file())
            self.assertTrue((outside_run / "evidencia" / "requests.log").is_file())
            self.assertTrue((run / "evidencia").exists(), "the link itself is not deleted either")

    def test_a_run_prunes_before_measuring(self) -> None:
        with temp_dir() as salidas, FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            old = make_run(salidas, "colegio.test", "2026-09-01")
            code, out, err = cli(site, apis, salidas)
            self.assertEqual(code, 0, err)
            self.assertIn("Evidence older than 30 days: deleted 1 evidencia folder.", err.splitlines())
            self.assertFalse((old / "evidencia").exists())
            self.assertTrue((old / "informe.md").is_file())
            new = salidas / "colegio.test" / "2026-10-14"
            self.assertTrue((new / "evidencia" / "requests.log").is_file(), "the new run keeps its evidence")
            # Control: a --rerender deletes no evidence, even of a run that is now old.
            code, _, err = run_cli(["--rerender", str(new / "datos.json")])
            self.assertEqual(code, 0, err)
            self.assertNotIn("Evidence older than", err)

    def test_the_console_line(self) -> None:
        r = outputs.PruneResult
        self.assertEqual(outputs.prune_message(r()), "Evidence older than 30 days: nothing to delete.")
        self.assertEqual(outputs.prune_message(r(removed=[Path("a")])), "Evidence older than 30 days: deleted 1 evidencia folder.")
        self.assertEqual(
            outputs.prune_message(r(removed=[Path("a"), Path("b")], failed=[Path("c")])),
            "Evidence older than 30 days: deleted 2 evidencia folders. 1 could not be deleted; the next run tries again.",
        )


class OutputRootTest(unittest.TestCase):
    HOOKS = ["--test-loopback", "127.0.0.1:9", "--test-services", "http://127.0.0.1:9"]

    def test_the_default_root_is_the_environment_variable_else_the_working_directory(self) -> None:
        with temp_dir() as profile, mock.patch.object(config, "DEFAULT_OUTPUT_ROOT", None), \
                patched_env(SITE_CHECK_OUT=str(profile / "runs")):
            self.assertEqual(config.default_output_root(), profile / "runs")
            from sitecheck.cli import parse_args

            self.assertEqual(parse_args(["https://www.colegio.test/", *self.HOOKS]).out_root, profile / "runs")

            # Control: --out still wins.
            other = profile / "otra"
            self.assertEqual(parse_args(["https://www.colegio.test/", "--out", str(other), *self.HOOKS]).out_root, other)

    def test_the_harness_never_uses_the_real_profile(self) -> None:
        self.assertEqual(config.default_output_root(), support.DEFAULT_ROOT)
        with mock.patch.object(config, "DEFAULT_OUTPUT_ROOT", None), patched_env(SITE_CHECK_OUT=None):
            self.assertEqual(config.default_output_root(), Path.cwd() / "site-check-runs")

    def test_the_list_lives_in_the_root(self) -> None:
        with temp_dir() as root, mock.patch.object(config, "DEFAULT_OUTPUT_ROOT", root), \
                FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            (root / "exclude.txt").write_text("colegio.test\n", encoding="utf-8")
            code, out, _ = cli(site, apis, None)
            self.assertEqual(code, 10)
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["exclude.txt"])
            self.assertEqual(site.requested_urls(), [])
            # Control: without the list, the run measures and writes under that root.
            (root / "exclude.txt").unlink()
            code, _, err = cli(site, apis, None)
            self.assertEqual(code, 0, err)


if __name__ == "__main__":
    unittest.main()
