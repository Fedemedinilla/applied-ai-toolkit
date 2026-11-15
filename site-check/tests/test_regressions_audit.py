"""Regression tests for the audit findings fixed in November 2026.

Each test reproduces one confirmed finding and failed before its fix.
"""

from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path
from typing import Any

import support  # noqa: F401
from support import TEST_KEY, SleepRecorder, run_cli, temp_dir

from sitecheck import runformat

from sitecheck.challenge import ChallengeDetector
from sitecheck.credentials import Redactor
from sitecheck.endpoints import Endpoints
from sitecheck.httpclient import ClientConfig, HttpClient, LoopbackRoute, _declared_length, public_address
from sitecheck.requestlog import RequestLog
from sitecheck.scope import Purpose, ScopeGuard
from fakeapis import FakeApis
from fakesite import FakeSite, Route
from sitefixtures import default_apis, school_scenario

BASE = "https://colegio.test"
EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


class _Rig:
    def __init__(self, site: FakeSite, apis: FakeApis) -> None:
        self.sleeps = SleepRecorder()
        redactor = Redactor([TEST_KEY])
        self.guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test(apis.base), test_loopback=True)
        self.guard.set_canonical(f"{BASE}/")
        config = ClientConfig(pace_seconds=0.0, pace_jitter=0.0, challenge_wait=60.0, challenge_pace=6.0, loopback=LoopbackRoute(port=site.port))
        self.client = HttpClient(self.guard, RequestLog(None, redactor), ChallengeDetector(), redactor, config, sleeper=self.sleeps)


class Nat64AddressTest(unittest.TestCase):
    """public_address looks through the IPv4 address that NAT64 and 6to4 embed."""

    def test_well_known_nat64_prefix_to_private_ipv4_is_refused(self) -> None:
        for ip in ("64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::c0a8:101"):
            with self.subTest(ip=ip):
                self.assertFalse(public_address(ip))

    def test_local_use_nat64_prefix_to_private_ipv4_is_refused(self) -> None:
        self.assertFalse(public_address("64:ff9b:1::a00:1"))

    def test_6to4_to_private_ipv4_is_refused(self) -> None:
        self.assertFalse(public_address("2002:a00:1::1"))
        self.assertFalse(public_address("2002:7f00:1::1"))

    def test_nat64_to_public_ipv4_is_allowed(self) -> None:
        self.assertTrue(public_address("64:ff9b::101:101"))  # 1.1.1.1
        self.assertTrue(public_address("2606:4700:4700::1111"))
        self.assertFalse(public_address("::ffff:10.0.0.1"))


class NonAsciiDigitHeaderTest(unittest.TestCase):
    """str.isdigit() accepts the latin-1 superscripts that http.client can decode."""

    def test_content_length_superscript_is_not_a_length(self) -> None:
        self.assertIsNone(_declared_length([("Content-Length", "²")]))
        self.assertEqual(_declared_length([("Content-Length", "12")]), 12)

    def test_retry_after_superscript_still_cuts_the_host(self) -> None:
        busy = Route(429, [("Content-Type", "text/html"), ("Retry-After", "²")], b"<html><body>Too many</body></html>")
        sc = school_scenario()
        sc.routes.update({f"{BASE}/a/": busy, f"{BASE}/b/": busy})
        with FakeSite(sc) as site, FakeApis(default_apis()) as apis:
            rig = _Rig(site, apis)
            rig.guard.admit_linked([f"{BASE}/a/", f"{BASE}/b/"], purpose=Purpose.LINK_CHECK, source="t")
            rig.client.fetch(f"{BASE}/a/", purpose=Purpose.LINK_CHECK, headers_only=True)
            self.assertTrue(rig.client.blocked)
            self.assertEqual(rig.client.fetch(f"{BASE}/b/", purpose=Purpose.LINK_CHECK, headers_only=True).skipped, "blocked")


def _stored_run(root: Path, name: str, edit: Any) -> Path:
    """A copy of examples/<name> in its own folder, changed by ``edit(document)``."""
    folder = root / "run"
    folder.mkdir()
    document = json.loads((EXAMPLES / name).read_text(encoding="utf-8"))
    edit(document)
    path = folder / name
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    return path


class MalformedStoredRunTest(unittest.TestCase):
    """A stored run that is not valid is exit 2 on --rerender, never a traceback and exit 1."""

    def _rerender(self, edit: Any) -> tuple[int, str]:
        with temp_dir() as root:
            code, _, err = run_cli(["--rerender", str(_stored_run(root, "run.json", edit))])
        return code, err

    def test_unknown_state_is_a_usage_error(self) -> None:
        code, err = self._rerender(lambda d: d["checks"][0].__setitem__("state", "bogus"))
        self.assertEqual(code, 2, err)
        self.assertIn("--rerender", err)
        self.assertNotIn("Traceback", err)

    def test_unknown_colour_is_a_usage_error(self) -> None:
        code, err = self._rerender(lambda d: d["checks"][0].__setitem__("colour", "purple"))
        self.assertEqual(code, 2, err)
        self.assertNotIn("Traceback", err)

    def test_checks_that_are_not_a_list_of_objects_are_a_usage_error(self) -> None:
        for value in ("abc", ["abc"], {"EXT-01": {}}):
            with self.subTest(checks=value):
                code, err = self._rerender(lambda d, v=value: d.__setitem__("checks", v))
                self.assertEqual(code, 2, err)
                self.assertNotIn("Traceback", err)


class SchemaVersionTypeTest(unittest.TestCase):
    """schema_version is an integer: JSON true is not 1 and 2.0 is not 2."""

    def test_bool_and_float_versions_are_refused(self) -> None:
        for version in (True, 2.0, 1.0, False):
            with self.subTest(version=version):
                with self.assertRaises(runformat.RunFormatError):
                    runformat.to_internal({"schema_version": version, "meta": {}})
                self.assertFalse(runformat.is_legacy({"schema_version": version}))

    def test_rerender_refuses_a_boolean_version_with_exit_2(self) -> None:
        for name, version in (("datos.json", True), ("run.json", 2.0)):
            with self.subTest(name=name), temp_dir() as root:
                path = _stored_run(root, name, lambda d, v=version: d.__setitem__("schema_version", v))
                code, _, err = run_cli(["--rerender", str(path)])
                self.assertEqual(code, 2, err)
                self.assertIn("schema_version", err)
                self.assertFalse((path.parent / "report.md").exists())


class RerenderKindTest(unittest.TestCase):
    """--kind on --rerender cannot change whether VIS-17 (admissions) applies: the run holds no data for that."""

    def test_school_run_rerendered_as_a_company_is_refused(self) -> None:
        with temp_dir() as root:
            path = _stored_run(root, "run.json", lambda d: None)
            code, _, err = run_cli(["--rerender", str(path), "--kind", "company"])
            self.assertEqual(code, 2, err)
            self.assertIn("--kind", err)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["meta"]["kind"], "colegio")
            self.assertFalse((path.parent / "report.md").exists())

    def test_company_run_rerendered_as_a_school_is_refused(self) -> None:
        with temp_dir() as root:
            path = _stored_run(root, "run.json", lambda d: d["meta"].__setitem__("kind", "empresa"))
            code, _, err = run_cli(["--rerender", str(path), "--kind", "school"])
            self.assertEqual(code, 2, err)

    def test_a_kind_with_the_same_checks_is_still_accepted(self) -> None:
        with temp_dir() as root:
            path = _stored_run(root, "run.json", lambda d: None)
            code, _, err = run_cli(["--rerender", str(path), "--kind", "kindergarten"])
            self.assertEqual(code, 0, err)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["meta"]["kind"], "jardín")


if __name__ == "__main__":
    unittest.main()
