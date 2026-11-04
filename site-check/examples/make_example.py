"""Rebuild examples/ from a run against the fictional fake school, fully offline.

    python3 examples/make_example.py

It starts the same local fake site and fake APIs the tests use, runs the real
CLI against ``https://www.colegio.test/`` and copies the report, the annex and
datos.json here. No request leaves 127.0.0.1.

Three inputs would otherwise come from the machine and change between runs:

- the clock. One fixed instant feeds the run date (``fmt.now_utc``, the clock
  the pipeline, the RDAP day count and the TLS day count all read) and the
  dates the fake TLS and RDAP answers are built from;
- the time to first byte. On loopback it is about a millisecond and jitters, so
  the samples are pinned to 1 ms;
- the Python, OpenSSL and expat versions that datos.json records. They are
  pinned to fixed labels (the fake site's Server header is fixed in
  tests/fakesite.py for the same reason).

With all three fixed, two runs give byte-identical files, on any machine, and
tests/test_integration.py checks that the committed examples/ match a fresh build.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import shutil
import sys
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tests"))

import support  # noqa: E402,F401  (path setup and the network guard)
from fakeapis import FakeApis, FakeApisConfig  # noqa: E402
from fakesite import FakeSite, Scenario  # noqa: E402
from sitefixtures import default_apis, school_scenario  # noqa: E402
from support import TEST_KEY, patched_env, run_cli, temp_dir  # noqa: E402

from sitecheck import collect, fmt, pipeline  # noqa: E402

# 10:00 in Buenos Aires: the date printed in the example.
FIXED = dt.datetime(2026, 10, 14, 13, 0, tzinfo=dt.timezone.utc)
FILES = ("informe.md", "anexo-tecnico.md", "datos.json")
PINNED_TTFB_MS = 1.0
PINNED_VERSIONS = {"version_python": "pinned", "version_openssl": "pinned", "version_expat": "pinned"}

_real_ttfb_sample = collect._ttfb_sample


def _pinned_ttfb_sample(url: str, resp: collect.Response) -> collect.TtfbSample:
    sample = _real_ttfb_sample(url, resp)
    if sample.ttfb_ms is None:
        return sample
    return dataclasses.replace(sample, ttfb_ms=PINNED_TTFB_MS)


def build(
    dest: Path,
    *,
    scenario: Scenario | None = None,
    apis_config: FakeApisConfig | None = None,
    now: dt.datetime = FIXED,
) -> tuple[int, str, str]:
    """Run the CLI against the fake school and copy FILES into ``dest``.

    ``scenario``, ``apis_config`` and ``now`` default to the school as it is in
    examples/; examples/make_compare_example.py passes the improved school.
    Returns (exit code, stdout, stderr). On a non-zero exit nothing is copied.
    """
    scenario = scenario if scenario is not None else school_scenario()
    apis_config = apis_config if apis_config is not None else default_apis(now=now)
    with temp_dir() as out, FakeSite(scenario) as site, FakeApis(apis_config) as apis:
        argv = [
            "https://www.colegio.test/", "--name", "Colegio Ejemplo", "--kind", "colegio", "--out", str(out),
            "--test-loopback", site.loopback, "--test-services", apis.base,
        ]
        with (
            patched_env(SITE_CHECK_TEST_API_KEY=TEST_KEY),
            mock.patch.object(fmt, "now_utc", lambda: now),
            mock.patch.object(collect, "_ttfb_sample", _pinned_ttfb_sample),
            mock.patch.object(pipeline, "_runtime_versions", lambda: dict(PINNED_VERSIONS)),
        ):
            code, stdout, stderr = run_cli(argv)
        if code != 0:
            return code, stdout, stderr
        run_dir = next(p for p in (out / "colegio.test").iterdir() if p.is_dir())
        dest.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            shutil.copyfile(run_dir / name, dest / name)
    return code, stdout, stderr


def main() -> int:
    code, stdout, stderr = build(HERE)
    print(stdout, end="")
    if code != 0:
        print(stderr, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
