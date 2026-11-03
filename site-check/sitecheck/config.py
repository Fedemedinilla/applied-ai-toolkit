"""RunConfig: everything a run needs, built by the CLI from the command line.

Immutable. NET reads it to build the services and the collection plan; CHECKS
reads institution/kind; the pipeline reads the rest. Paths are absolute.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_KIND = "institución"
DEFAULT_PARA = "Dirección"  # the "Para:" line of the report
DEFAULT_PSI_RUNS = 3  # mobile PageSpeed runs; the median one is used
MIN_PSI_RUNS = 1
MAX_PSI_RUNS = 5
# Pacing and budget of the site phase. --pause can only make the pause LONGER
# than 3 s, and --max-requests can only LOWER the 90-request budget: no option
# can make the tool more aggressive than a patient visitor.
DEFAULT_PACE_SECONDS = 3.0
MAX_PACE_SECONDS = 60.0
DEFAULT_SITE_BUDGET = 90

OUT_ENV_VAR = "SITE_CHECK_OUT"
OUT_DIR_NAME = "site-check-runs"
# The test harness points this at a temporary folder (tests/support.py), so no
# test ever writes next to the working directory.
DEFAULT_OUTPUT_ROOT: Path | None = None


def package_root() -> Path:
    """The folder that holds the sitecheck package (site-check/)."""
    return Path(__file__).resolve().parent.parent


def default_output_root() -> Path:
    """Where a run writes when --out is not given: $SITE_CHECK_OUT, else ./site-check-runs."""
    if DEFAULT_OUTPUT_ROOT is not None:
        return Path(DEFAULT_OUTPUT_ROOT)
    from_env = (os.environ.get(OUT_ENV_VAR) or "").strip()
    if from_env:
        return Path(from_env).absolute()
    return (Path.cwd() / OUT_DIR_NAME).absolute()


@dataclass(frozen=True)
class RunConfig:
    """One run of the tool.

    ``test_loopback`` ("127.0.0.1:PORT") and ``test_services``
    ("http://127.0.0.1:PORT") are TEST-ONLY (hidden flags --test-loopback and
    --test-services): they require a target under ``.test``, route every
    connection to loopback, set every wait to 0 and make
    credentials.load_api_key ignore the real key.

    ``psi_enabled`` False is enforced by the pipeline itself (it swaps the PSI
    and CrUX clients for stubs that never send anything). ``pace_seconds`` and
    ``site_budget`` are passed by services.build_services to ClientConfig in
    production (test mode keeps its zero waits).
    """

    url: str  # "" with --rerender: pipeline.rerender takes meta.url_entrada from datos.json
    institution: str | None = None  # --name
    kind: str = DEFAULT_KIND  # --kind
    para: str = DEFAULT_PARA  # --to
    interna: str | None = None  # --inner-page
    form_page: str | None = None  # --form-page
    psi_runs: int = DEFAULT_PSI_RUNS  # --psi-runs
    observatory: bool = False  # --observatory
    overrides: Path | None = None  # --overrides: colour overrides {ID: {color, motivo}}
    rerender_from: Path | None = None  # --rerender: path to an existing datos.json
    out_root: Path = field(default_factory=default_output_root)  # --out
    exclude: Path | None = None  # --exclude (or SITE_CHECK_EXCLUDE): extra exclusion list
    test_loopback: str | None = None
    test_services: str | None = None
    psi_enabled: bool = True  # --no-pagespeed sets False: no PSI and no CrUX call
    pace_seconds: float = DEFAULT_PACE_SECONDS  # --pause (>= 3, <= 60)
    site_budget: int = DEFAULT_SITE_BUDGET  # --max-requests (1..90)
    kind_explicit: bool = False  # True when --kind was given (datos.json meta.tipo_explicito)

    @property
    def test_mode(self) -> bool:
        """True when any test-only hook is set."""
        return self.test_loopback is not None or self.test_services is not None
