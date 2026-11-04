"""Rebuild examples/after/ and its before/after comparison, fully offline.

    python3 examples/make_compare_example.py

examples/ holds the fictional school measured on 14/10/2026 (make_example.py).
This script measures the same school five weeks later, after the fixes listed
in tests/comparefixtures.py, with the same local fake site, fake APIs and pinned
inputs, and copies that run into examples/after/. Then it runs

    python3 site_check.py --compare examples examples/after

which writes examples/after/comparacion.md and comparacion.json. No request
leaves 127.0.0.1, and tests/test_compare.py checks that the committed files
match a fresh build byte for byte.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import io
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tests"))
sys.path.insert(0, str(HERE.parent))

_spec = importlib.util.spec_from_file_location("make_example", HERE / "make_example.py")
assert _spec is not None and _spec.loader is not None
make_example = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(make_example)

from comparefixtures import improved_apis, improved_scenario  # noqa: E402

from sitecheck.compare import DATA, REPORT, run_compare  # noqa: E402

# Five weeks after the "before" run, 10:00 in Buenos Aires.
AFTER_FIXED = dt.datetime(2026, 11, 18, 13, 0, tzinfo=dt.timezone.utc)
AFTER_DIR = "after"
FILES = (*make_example.FILES, REPORT, DATA)


def build(before: Path, dest: Path) -> tuple[int, str, str]:
    """Measure the improved school into ``dest`` and compare it against ``before``.

    ``before`` is a folder holding the "before" datos.json (examples/ itself).
    Returns (exit code, stdout, stderr) of the step that ended the build.
    """
    if dest.exists():
        shutil.rmtree(dest)
    code, stdout, stderr = make_example.build(
        dest, scenario=improved_scenario(), apis_config=improved_apis(AFTER_FIXED), now=AFTER_FIXED
    )
    if code != 0:
        return code, stdout, stderr
    out, err = io.StringIO(), io.StringIO()
    code = int(run_compare(before, dest, stdout=out, stderr=err))
    return code, out.getvalue(), err.getvalue()


def main() -> int:
    code, stdout, stderr = build(HERE, HERE / AFTER_DIR)
    print(stdout, end="")
    if code != 0:
        print(stderr, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
