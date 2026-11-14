"""Machine output: the published schema of run.json, --json and --sarif."""

from __future__ import annotations

import copy
import json
import shutil
import unittest
from pathlib import Path
from typing import Any

import support  # noqa: F401  (path setup and the network guard)
from minischema import validate
from support import run_cli, temp_dir

from sitecheck import i18n, runformat, sarif

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "examples"
SCHEMA_PATH = ROOT / "schema" / "run.schema.json"


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


SCHEMA = _json(SCHEMA_PATH)


class MiniSchemaTest(unittest.TestCase):
    """The validator itself, on small cases, so a green run below means something."""

    def test_it_reports_each_kind_of_problem(self) -> None:
        schema = {
            "type": "object", "required": ["a"], "additionalProperties": False,
            "properties": {
                "a": {"type": ["integer", "null"], "minimum": 0},
                "b": {"enum": ["x", None]},
                "c": {"type": "array", "items": {"$ref": "#/$defs/id"}},
                "d": {"anyOf": [{"type": "null"}, {"type": "string"}]},
            },
            "$defs": {"id": {"type": "string", "pattern": "^[A-Z]+$"}},
        }
        self.assertEqual(validate({"a": 1, "b": None, "c": ["AB"], "d": None}, schema), [])
        self.assertEqual(validate({}, schema), ["$: missing 'a'"])
        self.assertEqual(validate({"a": True}, schema), ["$.a: expected integer or null, got bool"])
        self.assertEqual(validate({"a": -1}, schema), ["$.a: -1 is below 0"])
        self.assertEqual(validate({"a": 1, "b": "y"}, schema), ["$.b: 'y' is not one of ['x', None]"])
        self.assertEqual(validate({"a": 1, "c": ["AB", "ab"]}, schema), ["$.c[1]: 'ab' does not match '^[A-Z]+$'"])
        self.assertEqual(validate({"a": 1, "d": 3}, schema), ["$.d: matches none of the 2 alternatives"])
        self.assertEqual(validate({"a": 1, "z": 1}, schema), ["$: unexpected 'z'"])
        self.assertEqual(validate(1, {"const": 1}), [])
        self.assertEqual(validate(True, {"const": 1}), ["$: expected 1, got True"])

    def test_a_keyword_outside_the_subset_is_an_error_not_a_pass(self) -> None:
        with self.assertRaises(ValueError):
            validate({}, {"type": "object", "minProperties": 1})


class RunSchemaTest(unittest.TestCase):
    def test_the_example_runs_are_valid(self) -> None:
        for path in (EXAMPLES / "run.json", EXAMPLES / "after" / "run.json"):
            self.assertEqual(validate(_json(path), SCHEMA), [], path)

    def test_an_old_run_is_not_valid_until_it_is_migrated(self) -> None:
        old = _json(EXAMPLES / "datos.json")
        self.assertIn("$.schema_version: expected 2, got 1", validate(old, SCHEMA))
        self.assertIn("$: unexpected 'encabezado'", validate(old, SCHEMA))
        self.assertEqual(validate(runformat.migrate(old), SCHEMA), [])

    def test_a_spanish_name_or_value_fails(self) -> None:
        run = _json(EXAMPLES / "run.json")
        for change, problem in (
            (lambda r: r["meta"].update(dominio="colegio.test"), "$.meta: unexpected 'dominio'"),
            (lambda r: r["checks"][0].update(estado="FALLA"), "$.checks[0]: unexpected 'estado'"),
            (lambda r: r["checks"][0].update(state="FALLA"), "$.checks[0].state: 'FALLA' is not one of"),
            (lambda r: r["checks"][0].update(colour="rojo"), "$.checks[0].colour: 'rojo' is not one of"),
            (lambda r: r["summary"]["by_state"].update(FALLA=1), "$.summary.by_state.FALLA (name): 'FALLA' is not one of"),
            (lambda r: r.pop("output"), "$: missing 'output'"),
        ):
            broken = copy.deepcopy(run)
            change(broken)
            problems = validate(broken, SCHEMA)
            self.assertTrue(any(p.startswith(problem) for p in problems), (problem, problems))

    def test_the_schema_names_every_key_and_value_of_the_format(self) -> None:
        defs = SCHEMA["$defs"]
        self.assertEqual(set(defs["meta"]["properties"]), set(runformat.META_KEYS.values()) | {"user_agent"})
        self.assertEqual(set(defs["check"]["properties"]), set(runformat.CHECK_KEYS.values()) | {"id"})
        self.assertEqual(defs["check"]["properties"]["state"]["enum"], sorted(runformat.STATES.values()))
        self.assertEqual(defs["check"]["properties"]["priority"]["enum"], sorted(runformat.PRIORITIES.values()))
        self.assertEqual(SCHEMA["properties"]["schema_version"], {"const": 2})

    def test_a_run_that_ended_early_is_valid_too(self) -> None:
        # Exit 50 and exit 1 store a run with no checks, no header and no tables.
        run = _json(EXAMPLES / "run.json")
        run.update(header=None, checks=[], tables={}, hack_signals=[])
        run["output"] = {"code": 50, "name": "SCOPE_VIOLATION", "text_control": [], "deleted": []}
        self.assertEqual(validate(run, SCHEMA), [])


def _folder(root: Path) -> Path:
    folder = root / "colegio.test" / "2026-10-14"
    folder.mkdir(parents=True)
    for name in ("run.json", "report.md", "technical-annex.md"):
        shutil.copyfile(EXAMPLES / name, folder / name)
    return folder


class JsonOptionTest(unittest.TestCase):
    def test_stdout_is_the_stored_run_and_nothing_else(self) -> None:
        with temp_dir() as root:
            folder = _folder(root)
            code, out, err = run_cli(["--rerender", str(folder / "run.json"), "--json"])
            self.assertEqual(code, 0, err)
            self.assertEqual(out, (folder / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(validate(json.loads(out), SCHEMA), [])
            self.assertIn("site-check colegio.test: exit 0 (report written).", err)
            # Control: without the option the summary is on stdout and no JSON is printed.
            code, out, _ = run_cli(["--rerender", str(folder / "run.json")])
            self.assertTrue(out.startswith("site-check colegio.test: exit 0"))

    def test_compare_takes_neither_option(self) -> None:
        for option in (["--json"], ["--sarif", "x.sarif"]):
            code, _, err = run_cli(["--compare", str(EXAMPLES), str(EXAMPLES / "after"), *option])
            self.assertEqual(code, 2)
            self.assertIn(f"takes no other options (got {option[0]})", err)


class SarifTest(unittest.TestCase):
    def setUp(self) -> None:
        self.run_doc = _json(EXAMPLES / "run.json")

    def test_structure(self) -> None:
        log = sarif.to_sarif(self.run_doc, i18n.catalog("es"))
        self.assertEqual((log["$schema"], log["version"]), ("https://json.schemastore.org/sarif-2.1.0.json", "2.1.0"))
        self.assertEqual(len(log["runs"]), 1)
        run = log["runs"][0]
        driver = run["tool"]["driver"]
        self.assertEqual((driver["name"], driver["version"]), ("site-check", "1.0.0"))
        self.assertEqual(len(run["results"]), 13)  # 1 red, 6 yellow, 6 blue in the example
        self.assertEqual([r["id"] for r in driver["rules"]], [r["ruleId"] for r in run["results"]])
        for index, result in enumerate(run["results"]):
            self.assertEqual(set(result), {"ruleId", "ruleIndex", "level", "message", "locations", "partialFingerprints", "properties"})
            self.assertEqual(result["ruleIndex"], index)
            self.assertEqual(driver["rules"][index]["defaultConfiguration"]["level"], result["level"])
            self.assertTrue(result["message"]["text"].strip())
            self.assertEqual(
                result["locations"], [{"physicalLocation": {"artifactLocation": {"uri": "https://www.colegio.test/"}}}]
            )
            self.assertRegex(result["partialFingerprints"]["siteCheck/v1"], r"^[0-9a-f]{64}$")
        self.assertEqual(len({r["partialFingerprints"]["siteCheck/v1"] for r in run["results"]}), 13)
        self.assertEqual(run["properties"]["notVerified"], 4)
        self.assertEqual(run["properties"]["notApplicable"], 1)
        self.assertEqual(run["invocations"], [{"executionSuccessful": True, "exitCode": 0}])

    def test_level_comes_from_the_colour(self) -> None:
        log = sarif.to_sarif(self.run_doc, i18n.catalog("es"))
        levels = {r["ruleId"]: r["level"] for r in log["runs"][0]["results"]}
        colours = {c["id"]: c["colour"] for c in self.run_doc["checks"]}
        expected = {"red": "error", "yellow": "warning", "blue": "note"}
        self.assertEqual(sarif.LEVEL_OF_COLOUR, expected)
        for check_id, colour in colours.items():
            if colour in expected:
                self.assertEqual(levels[check_id], expected[colour], check_id)
            else:
                self.assertNotIn(check_id, levels, f"{check_id} is {colour}: no result")
        # Typed by hand from the example report.
        self.assertEqual(levels["EXT-05"], "error")
        self.assertEqual(levels["EXT-08"], "warning")
        self.assertEqual(levels["VIS-09"], "note")
        self.assertNotIn("EXT-07", levels)  # green
        self.assertNotIn("EXT-23", levels)  # grey: could not be checked
        self.assertNotIn("VIS-08", levels)  # not applicable

    def test_an_override_moves_the_level_with_the_colour(self) -> None:
        run = copy.deepcopy(self.run_doc)
        next(c for c in run["checks"] if c["id"] == "EXT-05")["colour"] = "blue"
        next(c for c in run["checks"] if c["id"] == "EXT-08")["colour"] = "green"
        levels = {r["ruleId"]: r["level"] for r in sarif.to_sarif(run, i18n.catalog("es"))["runs"][0]["results"]}
        self.assertEqual(levels["EXT-05"], "note")
        self.assertNotIn("EXT-08", levels)

    def test_the_message_is_what_the_report_of_that_language_prints(self) -> None:
        ext05 = next(c for c in self.run_doc["checks"] if c["id"] == "EXT-05")
        spanish = sarif.to_sarif(self.run_doc, i18n.catalog("es"))["runs"][0]
        result = next(r for r in spanish["results"] if r["ruleId"] == "EXT-05")
        self.assertEqual(result["message"]["text"], f"{ext05['sentence']['found']}. {ext05['sentence']['action']}.")
        rule = spanish["tool"]["driver"]["rules"][result["ruleIndex"]]
        self.assertEqual((rule["id"], rule["shortDescription"]["text"]), ("EXT-05", ext05["name"]))
        english = sarif.to_sarif(self.run_doc, i18n.catalog("en"))["runs"][0]
        result = next(r for r in english["results"] if r["ruleId"] == "EXT-05")
        self.assertEqual(
            result["message"]["text"],
            "Mail authentication: Fails. Whether the domain publishes SPF, DKIM and DMARC, which stop forged mail "
            "sent in its name.",
        )
        self.assertEqual(result["properties"]["label"], "Fix now")
        for r in english["results"]:
            for check in self.run_doc["checks"]:
                self.assertNotIn((check["sentence"] or {}).get("found") or "\0", r["message"]["text"])

    def test_the_home_that_never_answered_is_located_at_the_input_url(self) -> None:
        run = copy.deepcopy(self.run_doc)
        run["meta"]["canonical_url"] = None
        uris = {
            r["locations"][0]["physicalLocation"]["artifactLocation"]["uri"]
            for r in sarif.to_sarif(run, i18n.catalog("es"))["runs"][0]["results"]
        }
        self.assertEqual(uris, {run["meta"]["input_url"]})

    def test_the_option_writes_the_same_bytes_every_time(self) -> None:
        with temp_dir() as root:
            folder = _folder(root)
            first, second = root / "a.sarif", root / "b.sarif"
            for target in (first, second):
                code, _, err = run_cli(["--rerender", str(folder / "run.json"), "--sarif", str(target)])
                self.assertEqual(code, 0, err)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            log = json.loads(first.read_text(encoding="utf-8"))
            self.assertEqual(log, sarif.to_sarif(_json(folder / "run.json"), i18n.catalog("es")))
            self.assertTrue(first.read_text(encoding="utf-8").endswith("}\n"))
            # No path of this machine and no clock other than the run's own.
            self.assertNotIn(str(root), first.read_text(encoding="utf-8"))
            code, _, err = run_cli(["--rerender", str(folder / "run.json"), "--sarif", str(root / "no" / "x.sarif")])
            self.assertEqual(code, 2)
            self.assertIn("--sarif needs a file path in a folder that exists", err)


if __name__ == "__main__":
    unittest.main()
