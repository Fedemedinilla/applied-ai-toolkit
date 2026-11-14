"""The stored-run format: English names on disk, and runs of the earlier format still read.

The fixture is the committed example, in both layouts: examples/datos.json is
the fictional school as site-check wrote it before the rename (schema_version
1) and examples/run.json is the same run as it is written today. The first
must migrate to exactly the second.
"""

from __future__ import annotations

import io
import json
import shutil
import unittest
from pathlib import Path
from typing import Any

import support  # noqa: F401  (path setup and the network guard)
from support import run_cli, temp_dir

from sitecheck import SCHEMA_VERSION, compare, outputs, runformat

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
LEGACY = EXAMPLES / "datos.json"
RUN = EXAMPLES / "run.json"
AFTER = EXAMPLES / "after"
DAY_AFTER_RETENTION = __import__("datetime").date(2026, 12, 1)


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _keys(value: Any, out: set[str]) -> set[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            out.add(key)
            _keys(item, out)
    elif isinstance(value, list):
        for item in value:
            _keys(item, out)
    return out


def _resolve(run: dict[str, Any], trace: str) -> Any:
    """A trace as run.json writes it: checks[ID].measured.KEY, or a dotted path with [n] indexes."""
    if trace.startswith("checks["):
        check_id, _, key = trace[len("checks["):].partition("].measured.")
        return next(c for c in run["checks"] if c["id"] == check_id)["measured"][key]
    node: Any = run
    for part in trace.replace("]", "").replace("[", ".").split("."):
        node = node[int(part)] if part.isdigit() else node[part]
    return node


class MigrationTest(unittest.TestCase):
    def test_the_old_example_migrates_to_exactly_the_new_one(self) -> None:
        migrated = runformat.migrate(_json(LEGACY))
        self.assertEqual(outputs.dumps_json(migrated), RUN.read_text(encoding="utf-8"))
        self.assertEqual(migrated["schema_version"], SCHEMA_VERSION)

    def test_the_new_example_exports_to_exactly_the_old_one(self) -> None:
        self.assertEqual(outputs.dumps_legacy(outputs.read_datos(RUN)), LEGACY.read_text(encoding="utf-8"))

    def test_both_files_read_as_the_same_run(self) -> None:
        self.assertEqual(outputs.read_datos(LEGACY), outputs.read_datos(RUN))

    def test_a_migrated_document_is_left_alone(self) -> None:
        document = _json(RUN)
        self.assertIs(runformat.migrate(document), document)

    def test_other_versions_are_refused_with_the_reason(self) -> None:
        with temp_dir() as folder:
            for version, shown in ((99, "99"), (None, "None"), ("2", "'2'")):
                path = folder / "run.json"
                document = {"meta": {"dominio": "colegio.test"}}
                if version is not None:
                    document["schema_version"] = version
                path.write_text(json.dumps(document), encoding="utf-8")
                with self.assertRaises(ValueError) as caught:
                    outputs.read_datos(path)
                self.assertEqual(
                    str(caught.exception),
                    f"run.json has schema_version {shown}; this tool reads 2 and migrates 1",
                )
                code, _, err = run_cli(["--rerender", str(path)])
                self.assertEqual(code, 2)
                self.assertIn(f"schema_version {shown}; this tool reads 2 and migrates 1", err)


class PublicNamesTest(unittest.TestCase):
    """What is on disk carries none of the old names."""

    def test_the_tables_are_one_to_one(self) -> None:
        seen: dict[tuple[str, str], str] = {}
        for where, old, new in runformat.renames():
            self.assertNotEqual(old, new, where)
            self.assertNotIn((where, new), seen, f"{where}: {new} is the translation of two names")
            seen[(where, new)] = old

    def test_no_old_key_is_left_in_the_written_files(self) -> None:
        old_names = {old for where, old, _ in runformat.renames() if "values" not in where}
        # English words that are also an old name somewhere else: none today.
        for path in (RUN, AFTER / "run.json", AFTER / compare.DATA):
            left = _keys(_json(path), set()) & old_names
            self.assertEqual(left, set(), path.name)
        # Control: the old layout is full of them.
        self.assertGreater(len(_keys(_json(LEGACY), set()) & old_names), 100)

    def test_states_colours_and_priorities_are_english(self) -> None:
        run = _json(RUN)
        self.assertEqual({c["state"] for c in run["checks"]},
                         {"pass", "pass_with_note", "fail", "not_applicable", "not_verified"})
        self.assertEqual({c["colour"] for c in run["checks"]}, {"red", "yellow", "blue", "green", "grey", "hidden"})
        self.assertEqual({c["priority"] for c in run["checks"]}, {"critical", "high", "medium", "low"})
        self.assertEqual(run["summary"]["by_colour"], {"red": 1, "yellow": 6, "blue": 6, "green": 19, "grey": 4})
        self.assertEqual(run["meta"]["api_key"], "present")
        ext07 = next(c for c in run["checks"] if c["id"] == "EXT-07")
        self.assertEqual(ext07["measured"]["calendar_days"], 58)
        self.assertEqual(ext07["traces"]["{dias}"], "checks[EXT-07].measured.calendar_days")

    def test_every_trace_resolves_in_the_file_it_is_written_in(self) -> None:
        for path in (RUN, AFTER / "run.json"):
            run = _json(path)
            n = 0
            for check in run["checks"]:
                for placeholder, trace in check["traces"].items():
                    if not trace.startswith(("checks[", "meta.")):
                        continue  # free text, such as "home <title>"
                    for part in trace.split(", "):
                        full = part if part.startswith(("checks[", "meta.")) else trace.rpartition(".")[0] + "." + part
                        _resolve(run, full)  # KeyError when the name is not in the file
                        n += 1
            self.assertGreater(n, 10, path)
        comparison = _json(AFTER / compare.DATA)
        before, after = _json(RUN), _json(AFTER / "run.json")
        n = 0
        for row in comparison["rows"]:
            for side, run in (("before", before), ("after", after)):
                cell = row[side]
                if cell["value"] is None:
                    self.assertIsNone(cell["trace"])
                else:
                    self.assertEqual(_resolve(run, cell["trace"]), cell["value"], row["key"])
                    n += 1
        self.assertGreater(n, 20)

    def test_a_name_that_would_not_read_back_is_refused(self) -> None:
        # "calendar_days" is what dias_calendario becomes: a rule that stored both would lose one on the way back.
        run = outputs.read_datos(RUN)
        ext07 = next(c for c in run["checks"] if c["id"] == "EXT-07")
        ext07["mediciones"]["calendar_days"] = 1
        with self.assertRaises(runformat.RunFormatError):
            outputs.dumps_datos(run)
        # A new English key that collides with nothing passes unchanged.
        del ext07["mediciones"]["calendar_days"]
        ext07["mediciones"]["something_new"] = 1
        self.assertIn('"something_new": 1', outputs.dumps_datos(run))


class OldRunsStillWorkTest(unittest.TestCase):
    def _legacy_folder(self, root: Path) -> Path:
        folder = root / "colegio.test" / "2026-10-14"
        folder.mkdir(parents=True)
        shutil.copyfile(LEGACY, folder / "datos.json")
        (folder / "informe.md").write_text("el informe viejo\n", encoding="utf-8")
        return folder

    def test_rerender_reads_an_old_run_and_writes_the_new_files_next_to_it(self) -> None:
        with temp_dir() as root:
            folder = self._legacy_folder(root)
            code, _, err = run_cli(["--rerender", str(folder / "datos.json")])
            self.assertEqual(code, 0, err)
            self.assertIn("earlier format (schema_version 1)", err)
            self.assertEqual((folder / "datos.json").read_bytes(), LEGACY.read_bytes(), "the old run is left as it was")
            self.assertEqual((folder / "informe.md").read_text(encoding="utf-8"), "el informe viejo\n")
            self.assertEqual((folder / "report.md").read_bytes(), (EXAMPLES / "report.md").read_bytes())
            self.assertEqual((folder / "technical-annex.md").read_bytes(), (EXAMPLES / "technical-annex.md").read_bytes())
            new = _json(folder / "run.json")
            self.assertEqual(new["schema_version"], 2)
            self.assertEqual(new["output"]["rerendered"]["from"], "datos.json")
            # Apart from the record of the rerender, it is the example as it is written today.
            del new["output"]["rerendered"], new["output"]["rerender_errors"]
            self.assertEqual(new, _json(RUN))

    def test_compare_takes_an_old_run_and_a_new_one(self) -> None:
        with temp_dir() as root:
            before = self._legacy_folder(root)
            after = root / "after"
            after.mkdir()
            shutil.copyfile(AFTER / "run.json", after / "run.json")
            out, err = io.StringIO(), io.StringIO()
            code = compare.run_compare(before, after, stdout=out, stderr=err)
            self.assertEqual(int(code), 0, err.getvalue())
            for name in (compare.REPORT, compare.DATA):
                self.assertEqual((after / name).read_bytes(), (AFTER / name).read_bytes(), name)
            # The other way round too: a new BEFORE with an old AFTER.
            old_after = root / "colegio.test" / "2026-11-18"
            old_after.mkdir()
            (old_after / "datos.json").write_text(
                outputs.dumps_legacy(outputs.read_datos(AFTER / "run.json")), encoding="utf-8"
            )
            code = compare.run_compare(EXAMPLES, old_after, stdout=out, stderr=err)
            self.assertEqual(int(code), 0, err.getvalue())
            self.assertEqual((old_after / compare.REPORT).read_bytes(), (AFTER / compare.REPORT).read_bytes())

    def test_a_folder_with_both_files_is_read_from_the_new_one(self) -> None:
        self.assertEqual(outputs.run_file_of(EXAMPLES).name, "run.json")
        with temp_dir() as root:
            self.assertEqual(outputs.run_file_of(self._legacy_folder(root)).name, "datos.json")

    def test_the_retention_still_deletes_the_evidence_of_an_old_run(self) -> None:
        with temp_dir() as root:
            old = root / "colegio.test" / "2026-10-14"
            (old / "evidencia").mkdir(parents=True)
            (old / "evidencia" / "home.html").write_text("<html></html>", encoding="utf-8")
            (old / "datos.json").write_text("{}", encoding="utf-8")
            result = outputs.prune_old_evidence(root, DAY_AFTER_RETENTION)
            self.assertEqual(result.removed, [old / "evidencia"])
            self.assertTrue((old / "datos.json").is_file())
            # Neither name of the evidence folder can be written through write_text.
            for name in ("evidencia", "evidence"):
                with self.assertRaises(ValueError):
                    outputs.write_text(old / name / "home.html", "x")
            with self.assertRaises(ValueError):
                outputs.write_text(old / "datos.json", "{}")


if __name__ == "__main__":
    unittest.main()
