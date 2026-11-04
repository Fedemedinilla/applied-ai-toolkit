"""Command line: ``python3 -m sitecheck URL [options]`` (or ``python3 site_check.py URL``).

Options:
  URL                     the home of the site, http(s), root path ("/" or empty);
                          required, except with --rerender (then it is read from datos.json)
  --name NAME             the organisation's name (VIS-04 title test; report header)
  --kind KIND             kind of organisation, for the wording of the report:
                          colegio, escuela, instituto, jardín, empresa or institución
                          (default; kinds.py; anything else is exit 2)
  --to TEXT               the "Para:" line of the report (default "Dirección")
  --inner-page URL        an inner page to read (measured only if the home links it)
  --form-page URL         a page with a form for VIS-13 (measured only if the home links it)
  --psi-runs N            mobile PageSpeed runs, 1..5 (default 3; the median is used)
  --no-pagespeed          skip PageSpeed and CrUX entirely (speed checks stay grey)
  --observatory           also ask MDN Observatory for its header grade (off by default)
  --pause SECONDS         pause between site requests, 3 (default) to 60; never below 3
  --max-requests N        site request budget, 1 to 90 (default 90); never above 90
  --overrides FILE        colour overrides {ID: {"color", "motivo"}}, each with its reason
  --rerender DATOS_JSON   rebuild the report of an earlier run from its datos.json, no requests
  --compare BEFORE AFTER  compare two stored runs (folders or datos.json files), no requests;
                          writes comparacion.md and comparacion.json into the AFTER folder
  --out DIR               output root (default $SITE_CHECK_OUT, else ./site-check-runs)
  --exclude FILE          an exclusion list (default $SITE_CHECK_EXCLUDE); <out>/exclude.txt is read too
  --version               print the version

Environment: SITE_CHECK_CONTROL_DOMAIN (required for a real run: a site the
operator owns, used as the TTFB and DNS control), PAGESPEED_API_KEY (optional),
SITE_CHECK_OUT and SITE_CHECK_EXCLUDE.

Hidden TEST-ONLY flags (help=argparse.SUPPRESS):
  --test-loopback 127.0.0.1:PORT          route every *.test host to the fake site
  --test-services http://127.0.0.1:PORT   fake PSI/CrUX/DoH/RDAP/WP/Observatory/TLS/DBL
Both go together, require a URL under ".test" and loopback addresses; anything
else is exit 2. A ".test" URL without them is exit 2 as well.

Exit codes: exitcodes.ExitCode. main refuses to run (exit 2) when any module
of the package pulled in a third-party module (assert_stdlib_only): the tool is
standard library only, and ``python3 -I -S`` proves it.

main reconfigures stdout and stderr as UTF-8 with errors="replace" before
printing: a console in another code page cannot print the report's shapes.
"""

from __future__ import annotations

import argparse
import importlib
import ipaddress
import os
import pkgutil
import sys
from collections.abc import Sequence
from pathlib import Path
from urllib.parse import urlsplit

from . import __version__
from .config import (
    DEFAULT_KIND,
    DEFAULT_PACE_SECONDS,
    DEFAULT_PARA,
    DEFAULT_PSI_RUNS,
    DEFAULT_SITE_BUDGET,
    MAX_PACE_SECONDS,
    MAX_PSI_RUNS,
    MIN_PSI_RUNS,
    RunConfig,
    default_output_root,
    package_root,
)
from .endpoints import CONTROL_ENV_VAR, control_domain_from_env
from .exclusions import ENV_VAR as EXCLUDE_ENV_VAR
from .kinds import KINDS, normalize_kind

# Top-level module names already loaded when the CLI was imported (the
# interpreter's own startup, or the test runner). Only modules loaded AFTER
# this point are checked.
_BASELINE_MODULES: frozenset[str] = frozenset(name.partition(".")[0] for name in list(sys.modules))

TEST_SUFFIX = ".test"
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1"})
# Options that only shape a measurement; --compare refuses them instead of ignoring them.
_MEASURE_ONLY_OPTIONS = (
    "--no-pagespeed", "--observatory", "--psi-runs", "--max-requests", "--inner-page", "--form-page", "--pause",
)


class _Parser(argparse.ArgumentParser):
    """argparse with usage errors on stderr and exit code 2."""

    def error(self, message: str) -> None:  # type: ignore[override]
        self.print_usage(sys.stderr)
        self.exit(2, f"Usage error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    """The argparse parser described in the module docstring."""
    p = _Parser(
        prog="site-check",
        description=(
            "Passive, outside-in website check: reads only what the site serves to any visitor, plus public "
            "DNS, RDAP, Spamhaus and PageSpeed answers, and writes datos.json, informe.md and anexo-tecnico.md."
        ),
        epilog=(
            "Example: SITE_CHECK_CONTROL_DOMAIN=your-own-site.example "
            "python3 -m sitecheck https://www.example.org/ --name \"Example School\" --kind colegio"
        ),
        allow_abbrev=False,
    )
    p.add_argument("url", nargs="?", metavar="URL", help="home page of the site (http or https, no path)")
    p.add_argument("--name", metavar="NAME", help="the organisation's name, for the title check and the report")
    p.add_argument("--kind", metavar="KIND", default=None, help=f"kind of organisation: {', '.join(KINDS)} (default: {DEFAULT_KIND})")
    p.add_argument("--to", dest="para", metavar="TEXT", default=None, help=f'the "Para:" line of the report (default: {DEFAULT_PARA})')
    p.add_argument("--inner-page", dest="interna", metavar="URL", help="inner page; read only if the home links it")
    p.add_argument("--form-page", dest="form_page", metavar="URL", help="page with a form; read only if the home links it")
    p.add_argument(
        "--psi-runs", dest="psi_runs", type=int, default=DEFAULT_PSI_RUNS, metavar="N",
        help=f"mobile PageSpeed runs, {MIN_PSI_RUNS} to {MAX_PSI_RUNS} (default: {DEFAULT_PSI_RUNS})",
    )
    p.add_argument("--no-pagespeed", dest="no_pagespeed", action="store_true", help="skip PageSpeed and CrUX (speed checks stay grey)")
    p.add_argument("--observatory", action="store_true", help="also ask MDN Observatory")
    p.add_argument(
        "--pause", type=float, default=DEFAULT_PACE_SECONDS, metavar="SECONDS",
        help=f"pause between site requests, {DEFAULT_PACE_SECONDS:g} to {MAX_PACE_SECONDS:g} (default: {DEFAULT_PACE_SECONDS:g})",
    )
    p.add_argument(
        "--max-requests", dest="max_requests", type=int, default=DEFAULT_SITE_BUDGET, metavar="N",
        help=f"site request budget, 1 to {DEFAULT_SITE_BUDGET} (default: {DEFAULT_SITE_BUDGET})",
    )
    p.add_argument("--overrides", metavar="FILE", help='colour overrides with a reason: {ID: {"color", "motivo"}}')
    p.add_argument("--rerender", metavar="DATOS_JSON", help="rebuild the report from a datos.json, without requests")
    p.add_argument(
        "--compare", nargs=2, metavar=("BEFORE", "AFTER"),
        help="compare two stored runs (folders or datos.json files) without requests; writes into the AFTER folder",
    )
    p.add_argument("--out", metavar="DIR", help="output root (default: $SITE_CHECK_OUT, else ./site-check-runs)")
    p.add_argument("--exclude", metavar="FILE", help=f"exclusion list, one domain per line (default: ${EXCLUDE_ENV_VAR})")
    p.add_argument("--version", action="version", version=f"site-check {__version__}")
    # TEST-ONLY hooks, hidden from --help.
    p.add_argument("--test-loopback", dest="test_loopback", default=None, help=argparse.SUPPRESS)
    p.add_argument("--test-services", dest="test_services", default=None, help=argparse.SUPPRESS)
    return p


def _is_loopback_host(host: str | None) -> bool:
    return (host or "").strip("[]").lower() in _LOOPBACK_HOSTS


def _valid_port(port: int | None) -> bool:
    return port is not None and 1 <= port <= 65535


def _check_loopback(value: str) -> str | None:
    """The problem with a --test-loopback value, or None when it is HOST:PORT on loopback."""
    try:
        parsed = urlsplit(f"//{value}")
        host, port = parsed.hostname, parsed.port
    except ValueError:
        return "--test-loopback must be 127.0.0.1:PORT"
    if not _is_loopback_host(host) or not _valid_port(port) or parsed.path or parsed.query:
        return "--test-loopback must be 127.0.0.1:PORT"
    return None


def _check_services(value: str) -> str | None:
    """The problem with a --test-services value, or None when it is http://127.0.0.1:PORT."""
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        return "--test-services must be http://127.0.0.1:PORT"
    if (
        parsed.scheme != "http"
        or not _is_loopback_host(host)
        or not _valid_port(port)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.username
    ):
        return "--test-services must be http://127.0.0.1:PORT"
    return None


def _check_home_url(url: str, *, test_hooks: bool) -> str | None:
    """The problem with the input URL, or None when it is a valid home URL."""
    try:
        parsed = urlsplit(url.strip())
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return "the URL cannot be parsed"
    if parsed.scheme not in ("http", "https"):
        return "the URL must start with http:// or https://"
    if not host:
        return "the URL has no domain"
    if parsed.username is not None or parsed.password is not None:
        return "the URL cannot carry a user or a password"
    if port is not None and not test_hooks:
        return "the URL cannot carry a port"
    if parsed.path not in ("", "/"):
        return "the URL must be the home page, without a path (for example https://www.example.org/)"
    if parsed.query or parsed.fragment or url.strip().endswith(("?", "#")):
        return "the URL cannot carry ? or #"
    try:
        ipaddress.ip_address(host.strip("[]"))
        return "the URL must name a domain, not an IP address"
    except ValueError:
        pass
    if "." not in host.strip("."):
        return "the domain of the URL is not valid"
    is_test_host = host.rstrip(".").lower().endswith(TEST_SUFFIX)
    if test_hooks and not is_test_host:
        return "the test options only work with a .test domain"
    if is_test_host and not test_hooks:
        return "a .test domain is only used with the test options"
    return None


def _check_control_domain(domain: str) -> str | None:
    """The problem with SITE_CHECK_CONTROL_DOMAIN, or None when it names a domain.

    A real run sends the same TTFB and DNS questions to the control site, so
    the operator has to name a site they own. There is no default on purpose.
    """
    if not domain:
        return (
            f"set {CONTROL_ENV_VAR} to a domain you own (for example example.org): "
            "the TTFB and DNS controls are measured against it on every run"
        )
    probe = f"https://{domain}/"
    if "/" in domain or _check_home_url(probe, test_hooks=False) is not None:
        return f"{CONTROL_ENV_VAR} must be a bare domain name (for example example.org), not {domain!r}"
    return None


def _check_page_url(option: str, url: str) -> str | None:
    try:
        parsed = urlsplit(url.strip())
        host = parsed.hostname
    except ValueError:
        return f"{option} cannot be parsed"
    if parsed.scheme not in ("http", "https") or not host:
        return f"{option} must be a full address, with http:// or https://"
    if parsed.username is not None or parsed.password is not None:
        return f"{option} cannot carry a user or a password"
    return None




def parse_args(argv: Sequence[str]) -> RunConfig:
    """Parse and validate into a RunConfig.

    Validation: URL scheme http/https, a host, no userinfo, no port (except
    with the test hooks), path "/" or empty, no query or fragment; --psi-runs in
    1..5; --pause in 3..60; --max-requests in 1..90; test hooks only together,
    with a ".test" host and loopback addresses. Usage errors raise
    SystemExit(2) through argparse.error.

    With --rerender, no URL is accepted, and --to and --kind stay empty unless
    given (the values recorded in datos.json are used then).
    """
    parser = build_parser()
    args = parser.parse_args(list(argv))

    if not MIN_PSI_RUNS <= args.psi_runs <= MAX_PSI_RUNS:
        parser.error(f"--psi-runs must be between {MIN_PSI_RUNS} and {MAX_PSI_RUNS}")
    if not (DEFAULT_PACE_SECONDS <= args.pause <= MAX_PACE_SECONDS):
        parser.error(f"--pause must be between {DEFAULT_PACE_SECONDS:g} and {MAX_PACE_SECONDS:g} seconds")
    if not 1 <= args.max_requests <= DEFAULT_SITE_BUDGET:
        parser.error(f"--max-requests must be between 1 and {DEFAULT_SITE_BUDGET}")
    for name, option in (("name", "--name"), ("kind", "--kind"), ("para", "--to")):
        value = getattr(args, name)
        if value is not None and not value.strip():
            parser.error(f"{option} cannot be empty")

    if args.kind is not None:
        kind_key = normalize_kind(args.kind)
        if kind_key is None:
            parser.error(f"--kind must be one of: {', '.join(KINDS)}")
        args.kind = kind_key

    out_root = Path(args.out).absolute() if args.out else default_output_root()
    overrides = Path(args.overrides).absolute() if args.overrides else None
    if overrides is not None and not overrides.is_file():
        parser.error(f"the --overrides file does not exist: {overrides}")
    # An explicit list (the option or the variable) must exist: a typo must not
    # silently measure every opted-out domain. Only <out>/exclude.txt may be absent.
    exclude_text = args.exclude or (os.environ.get(EXCLUDE_ENV_VAR) or "").strip() or None
    exclude = Path(exclude_text).absolute() if exclude_text else None
    if exclude is not None and not exclude.is_file():
        source = "--exclude" if args.exclude else f"${EXCLUDE_ENV_VAR}"
        parser.error(f"the {source} file does not exist: {exclude}")

    test_hooks = args.test_loopback is not None or args.test_services is not None
    if test_hooks:
        if args.test_loopback is None or args.test_services is None:
            parser.error("--test-loopback and --test-services go together")
        problem = _check_loopback(args.test_loopback) or _check_services(args.test_services)
        if problem:
            parser.error(problem)

    if args.compare:
        given = [
            option
            for option, value in (
                ("a URL", args.url), ("--rerender", args.rerender), ("--overrides", args.overrides),
                ("--name", args.name), ("--kind", args.kind), ("--to", args.para), ("--out", args.out),
                ("--exclude", args.exclude),
            )
            if value
        ]
        # Options with a default value: only argv tells whether they were typed.
        given += [
            option
            for option in _MEASURE_ONLY_OPTIONS
            if any(token == option or token.startswith(option + "=") for token in argv)
        ]
        if test_hooks:
            given.append("the test options")
        if given:
            parser.error(f"--compare reads two stored runs and takes no other options (got {', '.join(given)})")
        before, after = (Path(value).absolute() for value in args.compare)
        for label, path in (("BEFORE", before), ("AFTER", after)):
            if not (path.is_dir() or path.is_file()):
                parser.error(f"the --compare {label} run does not exist: {path}")
        return RunConfig(url="", compare=(before, after), out_root=out_root)

    if args.rerender:
        if args.url:
            parser.error("--rerender takes no URL: it is read from datos.json")
        if test_hooks:
            parser.error("--rerender makes no requests: no test options")
        rerender_from = Path(args.rerender).absolute()
        if not rerender_from.is_file():
            parser.error(f"the --rerender file does not exist: {rerender_from}")
        return RunConfig(
            url="",
            institution=args.name.strip() if args.name else None,
            kind=args.kind.strip() if args.kind else DEFAULT_KIND,
            kind_explicit=args.kind is not None,
            para=args.para.strip() if args.para else "",
            overrides=overrides,
            rerender_from=rerender_from,
            out_root=out_root,
            exclude=exclude,
        )

    if not args.url:
        parser.error("missing the URL of the home page (or --rerender DATOS_JSON)")
    url = args.url.strip()
    problem = _check_home_url(url, test_hooks=test_hooks)
    if problem:
        parser.error(problem)
    for option, value in (("--inner-page", args.interna), ("--form-page", args.form_page)):
        if value:
            problem = _check_page_url(option, value)
            if problem:
                parser.error(problem)
    if not test_hooks:
        problem = _check_control_domain(control_domain_from_env())
        if problem:
            parser.error(problem)

    return RunConfig(
        url=url,
        institution=args.name.strip() if args.name else None,
        kind=args.kind.strip() if args.kind else DEFAULT_KIND,
        kind_explicit=args.kind is not None,
        para=args.para.strip() if args.para else DEFAULT_PARA,
        interna=args.interna.strip() if args.interna else None,
        form_page=args.form_page.strip() if args.form_page else None,
        psi_runs=args.psi_runs,
        observatory=args.observatory,
        overrides=overrides,
        rerender_from=None,
        out_root=out_root,
        exclude=exclude,
        test_loopback=args.test_loopback,
        test_services=args.test_services,
        psi_enabled=not args.no_pagespeed,
        pace_seconds=float(args.pause),
        site_budget=int(args.max_requests),
    )


def _load_package() -> None:
    """Import every module of the sitecheck package, so a stray import anywhere shows up."""
    package = sys.modules[__package__ or "sitecheck"]
    for info in pkgutil.walk_packages(package.__path__, prefix=package.__name__ + "."):
        if info.name.endswith(".__main__"):
            continue  # the -m entry point runs main on import
        importlib.import_module(info.name)


def _under(path_text: str | None, root: Path) -> bool:
    if not path_text:
        return False
    try:
        Path(path_text).resolve().relative_to(root)
        return True
    except (ValueError, OSError):
        return False


def assert_stdlib_only() -> list[str]:
    """Names of loaded top-level modules that are not in sys.stdlib_module_names
    (excluding sitecheck itself). The CLI refuses to run (exit 2) when not empty.

    Modules that were already loaded when the CLI was imported (interpreter
    startup hooks, the test runner) and modules that live inside the site-check
    folder (the test harness) are not counted: the check is about what sitecheck pulls in.
    """
    stdlib = set(sys.stdlib_module_names) | set(sys.builtin_module_names)
    own = (__package__ or "sitecheck").partition(".")[0]
    root = package_root().resolve()
    bad: set[str] = set()
    for name, module in list(sys.modules.items()):
        top = name.partition(".")[0]
        if top in stdlib or top in (own, "__main__") or top in _BASELINE_MODULES:
            continue
        if _under(getattr(module, "__file__", None), root):
            continue
        bad.add(top)
    return sorted(bad)


def _utf8_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point: parse, run (or rerender), return the exit code as int."""
    from .exitcodes import ExitCode

    _utf8_console()
    _load_package()
    strays = assert_stdlib_only()
    if strays:
        print(f"Configuration error: modules outside the standard library were loaded: {', '.join(strays)}. "
              "Run with python3 -I -S.", file=sys.stderr)
        return int(ExitCode.USAGE)
    try:
        config = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else (0 if exc.code is None else int(ExitCode.USAGE))

    if config.compare is not None:
        from .compare import run_compare

        return int(run_compare(config.compare[0], config.compare[1], stdout=sys.stdout, stderr=sys.stderr))

    from . import pipeline

    try:
        outcome = pipeline.rerender(config) if config.rerender_from is not None else pipeline.run(config)
    except KeyboardInterrupt:
        print("Run interrupted by hand.", file=sys.stderr)
        return int(ExitCode.UNEXPECTED)
    return int(outcome.exit_code)
