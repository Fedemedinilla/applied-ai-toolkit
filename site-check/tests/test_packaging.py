"""Packaging: pyproject.toml agrees with the package, and what it would ship runs.

Nothing here touches the network or publishes anything. The sdist is built
with the setuptools already on the machine, from a copy of the folder in a
temporary folder; without setuptools 77 or newer (the first that reads an SPDX
license string) those tests are skipped and the others still check the
metadata and the entry points.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tomllib
import unittest
import zipfile
from pathlib import Path

import support  # noqa: F401  (path setup and the network guard)
from support import temp_dir

import sitecheck

ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
PROJECT = PYPROJECT["project"]
DATA_FILES = ("sitecheck/catalogs/es.json", "sitecheck/catalogs/en.json")


# Local output that .gitignore keeps out of a checkout, so out of a build too.
NOT_CHECKED_IN = ("__pycache__", "*.pyc", "site-check-runs", "runs", "build", "dist", "*.egg-info")


def _copy_sources(dest: Path) -> None:
    """The whole folder as a checkout has it, tests and examples included, so the build decides what ships."""
    shutil.copytree(ROOT, dest, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*NOT_CHECKED_IN))


def _python(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True, text=True, timeout=120)


class MetadataTest(unittest.TestCase):
    def test_pyproject_agrees_with_the_package(self) -> None:
        self.assertEqual(PROJECT["name"], sitecheck.DIST_NAME)
        self.assertEqual(PROJECT["dynamic"], ["version"])
        self.assertEqual(PYPROJECT["tool"]["setuptools"]["dynamic"]["version"], {"attr": "sitecheck.__version__"})
        self.assertRegex(sitecheck.__version__, r"^\d+\.\d+\.\d+$")
        self.assertEqual(PROJECT["requires-python"], ">=3.11")
        self.assertEqual(PROJECT["dependencies"], [], "standard library only")
        self.assertNotIn("optional-dependencies", PROJECT)
        self.assertEqual(PROJECT["license"], "MIT")
        self.assertEqual(PROJECT["license-files"], ["LICENSE"])
        self.assertFalse([c for c in PROJECT["classifiers"] if c.startswith("License ::")])
        self.assertIn("MIT License", (ROOT / "LICENSE").read_text(encoding="utf-8"))
        self.assertEqual(PROJECT["readme"], "README.md")

    def test_every_package_folder_is_listed_and_the_data_is_declared(self) -> None:
        setuptools_cfg = PYPROJECT["tool"]["setuptools"]
        on_disk = {"sitecheck"} | {
            "sitecheck." + ".".join(p.parent.relative_to(ROOT / "sitecheck").parts)
            for p in (ROOT / "sitecheck").rglob("__init__.py")
            if p.parent != ROOT / "sitecheck"
        }
        self.assertEqual(set(setuptools_cfg["packages"]), on_disk | {"sitecheck.schema"})
        self.assertEqual(setuptools_cfg["package-dir"], {"sitecheck.schema": "schema"})
        self.assertEqual(setuptools_cfg["package-data"], {"sitecheck.catalogs": ["*.json"], "sitecheck.schema": ["*.json"]})
        for name in (*DATA_FILES, "schema/run.schema.json"):
            self.assertTrue((ROOT / name).is_file(), name)

    def test_the_console_script_names_a_function_that_runs(self) -> None:
        self.assertEqual(PROJECT["scripts"], {"site-check": "sitecheck.cli:main"})
        module_name, _, attr = PROJECT["scripts"]["site-check"].partition(":")
        entry = getattr(importlib.import_module(module_name), attr)
        self.assertTrue(callable(entry))
        code, out, _ = support.run_cli(["--version"])
        self.assertEqual((code, out.strip()), (0, f"site-check {sitecheck.__version__}"))


class EntryPointsTest(unittest.TestCase):
    def test_python_m_sitecheck_help(self) -> None:
        done = _python(["-S", "-m", "sitecheck", "--help"], ROOT)  # -I would drop the working directory
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("usage: site-check", done.stdout)
        self.assertIn("--sarif FILE", done.stdout)

    def test_the_installed_layout_runs_without_the_checkout(self) -> None:
        """The package alone in a folder, as a wheel installs it: the console entry, the catalogs and the guard."""
        with temp_dir() as root:
            site = root / "site-packages"
            shutil.copytree(ROOT / "sitecheck", site / "sitecheck", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(ROOT / "schema", site / "sitecheck" / "schema")
            run = root / "colegio.test" / "2026-10-14"
            run.mkdir(parents=True)
            shutil.copyfile(ROOT / "examples" / "run.json", run / "run.json")
            entry = "import sys; sys.path.insert(0, sys.argv.pop(1)); from sitecheck.cli import main; sys.exit(main())"
            done = _python(["-I", "-S", "-c", entry, str(site), "--help"], root)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("usage: site-check", done.stdout)
            done = _python(["-I", "-S", "-c", entry, str(site), "--rerender", str(run / "run.json"), "--lang", "en"], root)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("State of the site colegio.test", (run / "report.md").read_text(encoding="utf-8"))
            # Installed, nothing next to the package is exempt from the standard-library check.
            (site / "thirdparty.py").write_text("", encoding="utf-8")
            stray = "import sys; sys.path.insert(0, sys.argv.pop(1)); from sitecheck.cli import main; import thirdparty; sys.exit(main())"
            done = _python(["-I", "-S", "-c", stray, str(site), "--version"], root)
            self.assertEqual(done.returncode, 2, done.stdout)
            self.assertIn("modules outside the standard library were loaded: thirdparty", done.stderr)


def _setuptools_major() -> int | None:
    if importlib.util.find_spec("setuptools") is None:
        return None
    return int(importlib.metadata.version("setuptools").split(".")[0])


# pyproject.toml asks for setuptools>=77, which reads `license` as an SPDX expression.
MIN_SETUPTOOLS = 77


# CI sets SITECHECK_REQUIRE_BUILD=1 after installing setuptools, so a missing one fails there instead of skipping.
BUILD_REQUIRED = os.environ.get("SITECHECK_REQUIRE_BUILD") == "1"


class BuildToolTest(unittest.TestCase):
    def test_setuptools_is_new_enough_where_the_build_is_required(self) -> None:
        if not BUILD_REQUIRED:
            self.skipTest("SITECHECK_REQUIRE_BUILD is not set")
        self.assertGreaterEqual(_setuptools_major() or 0, MIN_SETUPTOOLS)


@unittest.skipUnless((_setuptools_major() or 0) >= MIN_SETUPTOOLS,
                     f"setuptools {MIN_SETUPTOOLS} or newer is not installed: the sdist is not built")
class BuildTest(unittest.TestCase):
    def test_the_sdist_builds_offline_and_carries_the_data(self) -> None:
        with temp_dir() as root:
            src, out = root / "src", root / "dist"
            src.mkdir()
            out.mkdir()
            _copy_sources(src)
            build = "import sys; from setuptools import build_meta; print(build_meta.build_sdist(sys.argv[1]))"
            done = _python(["-c", build, str(out)], src)
            self.assertEqual(done.returncode, 0, done.stderr[-2000:])
            # setuptools stops accepting deprecated metadata (a license table, license classifiers) on a
            # set date, so a deprecation today is a build that fails later.
            self.assertNotIn("Deprecat", done.stderr)
            # setuptools 69.3+ names the sdist after the PEP 625 normalized name (site_check_passive);
            # older ones keep the project name as written. Take the name the backend returns.
            stem = done.stdout.strip().splitlines()[-1].removesuffix(".tar.gz")
            normalized = re.sub(r"[-_.]+", "_", sitecheck.DIST_NAME).lower()
            self.assertIn(stem, {f"{sitecheck.DIST_NAME}-{sitecheck.__version__}", f"{normalized}-{sitecheck.__version__}"})
            archive = out / f"{stem}.tar.gz"
            self.assertTrue(archive.is_file(), sorted(p.name for p in out.iterdir()))
            prefix = f"{stem}/"
            with tarfile.open(archive) as tar:
                names = set(tar.getnames())
                info = tar.extractfile(prefix + "PKG-INFO")
                assert info is not None
                metadata = info.read().decode("utf-8")
            for name in (*DATA_FILES, "schema/run.schema.json", "LICENSE", "pyproject.toml", "sitecheck/cli.py",
                         "sitecheck/checks/security.py"):
                self.assertIn(prefix + name, names)
            self.assertEqual(sorted(n for n in names if "/tests/" in n or "/examples/" in n), [])
            self.assertNotIn(prefix + "site_check.py", names)
            self.assertIn(f"Name: {sitecheck.DIST_NAME}\n", metadata)
            self.assertIn(f"Version: {sitecheck.__version__}\n", metadata)
            self.assertIn("Requires-Python: >=3.11\n", metadata)
            self.assertIn("License-Expression: MIT\n", metadata)
            self.assertNotIn("Requires-Dist:", metadata)

    def test_the_wheel_carries_the_data_and_the_entry_point_where_it_can_be_built(self) -> None:
        with temp_dir() as root:
            src, out = root / "src", root / "dist"
            src.mkdir()
            out.mkdir()
            _copy_sources(src)
            build = "import sys; from setuptools import build_meta; print(build_meta.build_wheel(sys.argv[1]))"
            done = _python(["-c", build, str(out)], src)
            if done.returncode != 0:
                # Some distribution-patched setuptools cannot run bdist_wheel (install_layout); the sdist test stands.
                self.skipTest("this machine's setuptools cannot build a wheel: " + done.stderr.strip().splitlines()[-1])
            wheels = list(out.glob("*.whl"))
            self.assertEqual(len(wheels), 1)
            with zipfile.ZipFile(wheels[0]) as wheel:
                names = set(wheel.namelist())
                entry_points = next(n for n in names if n.endswith(".dist-info/entry_points.txt"))
                self.assertIn("site-check = sitecheck.cli:main", wheel.read(entry_points).decode("utf-8"))
            for name in (*DATA_FILES, "sitecheck/schema/run.schema.json", "sitecheck/cli.py"):
                self.assertIn(name, names)


if __name__ == "__main__":
    unittest.main()
