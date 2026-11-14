"""--lang: the report strings live in one catalog per language, with the same keys in each."""

from __future__ import annotations

import json
import re
import shutil
import unittest
from pathlib import Path

import support  # noqa: F401  (path setup and the network guard)
from support import run_cli, temp_dir

from sitecheck import cli, i18n, kinds, registry
from sitecheck.model import COLOUR_STYLES, Colour, State

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
TEST_HOOKS = ["--test-loopback", "127.0.0.1:9", "--test-services", "http://127.0.0.1:9"]


def _raw(lang: str) -> dict[str, str]:
    return json.loads((i18n.CATALOG_DIR / f"{lang}.json").read_text(encoding="utf-8"))


class CatalogParityTest(unittest.TestCase):
    def test_both_catalogs_have_exactly_the_same_keys(self) -> None:
        es, en = _raw("es"), _raw("en")
        self.assertEqual(sorted(es), sorted(en))
        self.assertGreater(len(es), 200)

    def test_each_key_has_the_same_placeholders_in_both(self) -> None:
        es, en = _raw("es"), _raw("en")
        for key in es:
            self.assertEqual(i18n.placeholders(es[key]), i18n.placeholders(en[key]), key)
        # Control: the comparison sees a placeholder, with or without a format.
        self.assertEqual(i18n.placeholders("{y}-{m:02d} y {name}"), {"y", "m", "name"})

    def test_no_string_is_empty_and_every_value_is_text(self) -> None:
        for lang in i18n.LANGS:
            for key, value in _raw(lang).items():
                self.assertIsInstance(value, str, key)
                self.assertTrue(value.strip(), f"{lang}: {key}")

    def test_every_check_has_a_name_and_a_description_in_both(self) -> None:
        ids = sorted(registry.by_id())
        self.assertEqual(len(ids), 37)
        for lang in i18n.LANGS:
            strings = _raw(lang)
            named = sorted(k.split(".")[1] for k in strings if k.startswith("check.") and k.endswith(".name"))
            about = sorted(k.split(".")[1] for k in strings if k.startswith("check.") and k.endswith(".about"))
            self.assertEqual(named, ids, lang)
            self.assertEqual(about, ids, lang)

    def test_the_spanish_catalog_is_what_the_rules_already_say(self) -> None:
        es = i18n.catalog("es")
        for check_id, spec in registry.by_id().items():
            self.assertEqual(es[f"check.{check_id}.name"], spec.name_plain, check_id)
        for colour in (Colour.ROJO, Colour.AMARILLO, Colour.AZUL, Colour.VERDE, Colour.GRIS):
            self.assertEqual(es[f"colour.{colour.value}.label"], COLOUR_STYLES[colour].label)
        for key, kind in kinds.KINDS.items():
            self.assertEqual(es[f"kind.{key}.the"], kind.el)
        for state in State:
            self.assertEqual(es[f"state.{state.value}"], state.value)

    def test_an_unknown_language_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            i18n.catalog("fr")
        code, _, err = run_cli(["https://www.colegio.test/", "--lang", "fr", *TEST_HOOKS])
        self.assertEqual(code, 2)
        self.assertIn("--lang", err)


class LanguageOfARunTest(unittest.TestCase):
    def _rerender(self, folder: Path, *options: str) -> None:
        code, _, err = run_cli(["--rerender", str(folder / "run.json"), *options])
        self.assertEqual(code, 0, err)

    def _copy(self, root: Path) -> Path:
        folder = root / "colegio.test" / "2026-10-14"
        folder.mkdir(parents=True)
        for name in ("run.json", "report.md", "technical-annex.md"):
            shutil.copyfile(EXAMPLES / name, folder / name)
        return folder

    def test_spanish_is_the_default_and_is_recorded(self) -> None:
        config = cli.parse_args(["https://www.colegio.test/", *TEST_HOOKS])
        self.assertEqual((config.lang, config.para), (None, "Dirección"))
        config = cli.parse_args(["https://www.colegio.test/", "--lang", "en", *TEST_HOOKS])
        self.assertEqual((config.lang, config.para), ("en", "Management"))
        self.assertEqual(json.loads((EXAMPLES / "run.json").read_text(encoding="utf-8"))["meta"]["report_language"], "es")

    def test_the_english_report_passes_the_text_control_and_prints_no_rule_sentence(self) -> None:
        with temp_dir() as root:
            folder = self._copy(root)
            self._rerender(folder, "--lang", "en")
            run = json.loads((folder / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(run["meta"]["report_language"], "en")
            self.assertEqual(run["output"]["text_control"], [])
            report = (folder / "report.md").read_text(encoding="utf-8")
            annex = (folder / "technical-annex.md").read_text(encoding="utf-8")
            for check in run["checks"]:
                for text in (check["sentence"] or {}).values():
                    if text:
                        self.assertNotIn(text, report, check["id"])
                self.assertNotIn(check["name"], report, check["id"])
            self.assertIn("| EXT-05 · Mail authentication | Whether the domain publishes SPF, DKIM and DMARC, "
                          "which stop forged mail sent in its name | Fails |", report)
            self.assertIn("**36 applicable checks:** ▲ 1 to fix now · ■ 6 to review · ◆ 6 optional improvements · "
                          "● 19 fine · ○ 4 that could not be seen.", report)
            self.assertIn("**Recommended next step:** Fix first what is marked to fix now and to review, "
                          "because the check «Mail authentication» fails.", report)
            self.assertIn("Date: 2026-10-14 · To: Dirección", report)
            self.assertIn("| EXT-07 | pass | ● Fine | tls.json |", annex)
            # The fold counts its bullets in English too.
            self.assertEqual(report.count(": could not be checked from outside."), 4)

    def test_every_number_the_english_annex_prints_is_the_stored_value_under_the_printed_name(self) -> None:
        with temp_dir() as root:
            folder = self._copy(root)
            self._rerender(folder, "--lang", "en")
            run = json.loads((folder / "run.json").read_text(encoding="utf-8"))
            by_id = {c["id"]: c for c in run["checks"]}
            annex = (folder / "technical-annex.md").read_text(encoding="utf-8")
            rows = re.findall(r"^\| ((?:EXT|VIS)-\d\d) \| ([a-z0-9_]+) \| ([^|]+) \|$", annex, flags=re.MULTILINE)
            self.assertGreater(len(rows), 100)
            for check_id, name, shown in rows:
                stored = by_id[check_id]["measured"][name]  # KeyError when the name is not in run.json
                expected = {True: "yes", False: "no"}[stored] if isinstance(stored, bool) else str(stored)
                self.assertEqual(shown, expected, f"{check_id} {name}")
            self.assertIn(("EXT-07", "calendar_days", "58"), rows)
            # And the other way: every stored number or yes/no of every check is printed.
            stored_n = sum(
                1 for c in run["checks"] for v in c["measured"].values() if isinstance(v, (bool, int, float))
            )
            self.assertEqual(len(rows), stored_n)
            # No number is printed in the English report outside the counts, scores, dates and request figures.
            report = (folder / "report.md").read_text(encoding="utf-8")
            self.assertNotIn("58", report)

    def test_a_rerender_keeps_the_language_and_spanish_comes_back_byte_for_byte(self) -> None:
        with temp_dir() as root:
            folder = self._copy(root)
            self._rerender(folder, "--lang", "en")
            english = (folder / "report.md").read_bytes()
            self._rerender(folder)  # no --lang: the language of the run
            self.assertEqual((folder / "report.md").read_bytes(), english)
            self._rerender(folder, "--lang", "es")
            self.assertEqual((folder / "report.md").read_bytes(), (EXAMPLES / "report.md").read_bytes())
            self.assertEqual((folder / "technical-annex.md").read_bytes(), (EXAMPLES / "technical-annex.md").read_bytes())

    def test_compare_takes_no_language(self) -> None:
        code, _, err = run_cli(["--compare", str(EXAMPLES), str(EXAMPLES / "after"), "--lang", "en"])
        self.assertEqual(code, 2)
        self.assertIn("takes no other options (got --lang)", err)


if __name__ == "__main__":
    unittest.main()
