"""The command line speaks English, and still takes what earlier versions took."""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout

import support  # noqa: F401  (path setup and the network guard)
from support import run_cli, temp_dir

from sitecheck import cli, kinds
from sitecheck.colours import load_overrides
from sitecheck.model import Colour

SPANISH_IN_HELP = ("informe", "anexo", "motivo", "Para:", "DATOS", "evidencia", "comparacion")
TEST_HOOKS = ["--test-loopback", "127.0.0.1:9", "--test-services", "http://127.0.0.1:9"]


class HelpTest(unittest.TestCase):
    def test_help_names_nothing_in_spanish_but_the_kinds_of_the_report(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(SystemExit) as stop:
            cli.build_parser().parse_args(["--help"])
        self.assertEqual(stop.exception.code, 0)
        text = out.getvalue()
        for word in SPANISH_IN_HELP:
            self.assertNotIn(word, text)
        for expected in ("--rerender RUN_JSON", '{ID: {"colour", "reason"}}', "school, institute, kindergarten, company"):
            self.assertIn(expected, " ".join(text.split()))

    def test_no_option_is_stored_under_a_spanish_name(self) -> None:
        args = cli.build_parser().parse_args(["https://www.colegio.test/", "--to", "Board", "--inner-page", "https://www.colegio.test/a/"])
        self.assertEqual((args.to, args.inner_page), ("Board", "https://www.colegio.test/a/"))
        for name in ("para", "interna"):
            self.assertFalse(hasattr(args, name), name)


class KindTest(unittest.TestCase):
    def test_english_names_select_the_kind_the_report_words(self) -> None:
        for given, key in (
            ("school", "colegio"), ("Institute", "instituto"), ("kindergarten", "jardín"), ("company", "empresa"),
            ("organisation", "institución"), ("organization", "institución"),
            # The Spanish nouns, with or without the accent, as before.
            ("colegio", "colegio"), ("escuela", "escuela"), ("jardin", "jardín"), ("Institución", "institución"),
        ):
            self.assertEqual(kinds.normalize_kind(given), key, given)
            config = cli.parse_args(["https://www.colegio.test/", "--kind", given, *TEST_HOOKS])
            self.assertEqual(config.kind, key, given)
        self.assertEqual(set(kinds.ALIASES.values()) | {"escuela"}, set(kinds.KINDS))

    def test_an_unknown_kind_is_a_usage_error_that_lists_both_spellings(self) -> None:
        code, _, err = run_cli(["https://www.colegio.test/", "--kind", "club", *TEST_HOOKS])
        self.assertEqual(code, 2)
        self.assertIn("--kind must be one of: school, institute, kindergarten, company, organisation, colegio,", err)


class OverridesTest(unittest.TestCase):
    def _load(self, folder, data):
        path = folder / "overrides.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return load_overrides(path)

    def test_english_keys_and_colours(self) -> None:
        with temp_dir() as folder:
            got = self._load(folder, {"EXT-09": {"colour": "blue", "reason": "shared hosting"}})
            self.assertEqual((got["EXT-09"].colour, got["EXT-09"].motivo), (Colour.AZUL, "shared hosting"))
            for name, colour in (("red", Colour.ROJO), ("Yellow", Colour.AMARILLO), ("green", Colour.VERDE), ("grey", Colour.GRIS)):
                self.assertEqual(self._load(folder, {"EXT-09": {"colour": name, "reason": "x"}})["EXT-09"].colour, colour)

    def test_a_file_of_an_earlier_version_reads_the_same(self) -> None:
        with temp_dir() as folder:
            old = self._load(folder, {"EXT-09": {"color": "azul", "motivo": "hosting compartido"}})
            new = self._load(folder, {"EXT-09": {"colour": "blue", "reason": "hosting compartido"}})
            self.assertEqual(old, new)
            mixed = self._load(folder, {"EXT-09": {"color": "blue", "motivo": "hosting compartido"}})
            self.assertEqual(mixed, new)

    def test_problems_are_named_in_english(self) -> None:
        with temp_dir() as folder:
            for data, message in (
                ({"EXT-09": {"colour": "blue"}}, "EXT-09: the 'reason' is mandatory"),
                ({"EXT-09": {"colour": "violet", "reason": "x"}}, "EXT-09: unknown colour 'violet'"),
                ({"EXT-09": {"colour": "hidden", "reason": "x"}}, "EXT-09: colour 'hidden' cannot be set by hand"),
                ({"EXT-09": {"colour": "blue", "color": "azul", "reason": "x"}}, "EXT-09: 'colour' and 'color' are the same field; give one"),
                ({"EXT-09": {"colour": "blue", "reason": "x", "motivo": "y"}}, "EXT-09: 'reason' and 'motivo' are the same field; give one"),
                ({"EXT-99": {"colour": "blue", "reason": "x"}}, "unknown check ID in overrides: 'EXT-99'"),
            ):
                with self.assertRaises(ValueError) as caught:
                    self._load(folder, data)
                self.assertEqual(str(caught.exception), message)


if __name__ == "__main__":
    unittest.main()
