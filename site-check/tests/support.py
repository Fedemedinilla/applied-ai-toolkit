"""Shared test support: import path, network isolation, helpers, CLI runner.

Importing this module (every test file does it first):

* puts the site-check folder on sys.path so ``import sitecheck`` works from
  ``python3 -m unittest discover -s tests`` run in site-check/;
* installs a NETWORK ISOLATION GUARD for the whole test process: any socket
  connection or name lookup that is not loopback raises OSError. A test can
  therefore never reach a real site, whatever the code under test does.
"""

from __future__ import annotations

import contextlib
import io
import os
import socket
import sys
import tempfile
from collections.abc import Iterator, Mapping
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = TESTS_DIR.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

# A fake key, long enough for the Redactor, never a real one.
TEST_KEY = "TEST-ONLY-KEY-0123456789abcdef"

# --------------------------------------------------------------------------
# Network isolation
# --------------------------------------------------------------------------

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def _is_loopback(host: object) -> bool:
    if host is None:
        return True
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    return str(host).strip("[]").lower() in _LOOPBACK_HOSTS


def _refuse(what: str, host: object) -> OSError:
    return OSError(f"test network isolation: refused {what} to {host!r}")


_orig_connect = socket.socket.connect
_orig_connect_ex = socket.socket.connect_ex
_orig_getaddrinfo = socket.getaddrinfo
_orig_gethostbyname = socket.gethostbyname
_orig_gethostbyname_ex = socket.gethostbyname_ex


def _guarded_connect(self, address):  # type: ignore[no-untyped-def]
    host = address[0] if isinstance(address, tuple) else address
    if not _is_loopback(host):
        raise _refuse("connection", host)
    return _orig_connect(self, address)


def _guarded_connect_ex(self, address):  # type: ignore[no-untyped-def]
    host = address[0] if isinstance(address, tuple) else address
    if not _is_loopback(host):
        raise _refuse("connection", host)
    return _orig_connect_ex(self, address)


def _guarded_getaddrinfo(host, *args, **kwargs):  # type: ignore[no-untyped-def]
    if not _is_loopback(host):
        raise socket.gaierror(socket.EAI_NONAME, f"test network isolation: refused lookup of {host!r}")
    return _orig_getaddrinfo(host, *args, **kwargs)


def _guarded_gethostbyname(host):  # type: ignore[no-untyped-def]
    if not _is_loopback(host):
        raise socket.gaierror(socket.EAI_NONAME, f"test network isolation: refused lookup of {host!r}")
    return _orig_gethostbyname(host)


def _guarded_gethostbyname_ex(host):  # type: ignore[no-untyped-def]
    if not _is_loopback(host):
        raise socket.gaierror(socket.EAI_NONAME, f"test network isolation: refused lookup of {host!r}")
    return _orig_gethostbyname_ex(host)


def install_network_guard() -> None:
    """Patch the socket module for the whole test process (idempotent)."""
    socket.socket.connect = _guarded_connect  # type: ignore[method-assign]
    socket.socket.connect_ex = _guarded_connect_ex  # type: ignore[method-assign]
    socket.getaddrinfo = _guarded_getaddrinfo  # type: ignore[assignment]
    socket.gethostbyname = _guarded_gethostbyname  # type: ignore[assignment]
    socket.gethostbyname_ex = _guarded_gethostbyname_ex  # type: ignore[assignment]


install_network_guard()

# The default output root is never the real one in a test, whatever
# SITE_CHECK_OUT says: a run or a --rerender without --out reads and writes an
# empty temporary folder, removed when the test process ends. The exclusion
# list variable is cleared for the same reason.
os.environ.pop("SITE_CHECK_EXCLUDE", None)
os.environ.pop("SITE_CHECK_OUT", None)
# A real (non-test) run needs a control domain the operator owns. Tests that
# parse a real URL get a reserved name (RFC 2606) that no connection can reach.
os.environ["SITE_CHECK_CONTROL_DOMAIN"] = "control-ejemplo.example"
import atexit  # noqa: E402
import shutil  # noqa: E402

from sitecheck import config as _config  # noqa: E402

DEFAULT_ROOT = Path(tempfile.mkdtemp(prefix="sitecheck-raiz-"))
atexit.register(shutil.rmtree, DEFAULT_ROOT, True)
_config.DEFAULT_OUTPUT_ROOT = DEFAULT_ROOT

# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


class AllWritten(Mapping[str, bool]):
    """artifacts_written stand-in where every artifact name counts as written."""

    def __getitem__(self, key: str) -> bool:
        return True

    def __iter__(self) -> Iterator[str]:
        return iter(())

    def __len__(self) -> int:
        return 0

    def get(self, key: str, default: object = None) -> bool:  # type: ignore[override]
        return True

    def __contains__(self, key: object) -> bool:
        return True


class SleepRecorder:
    """Injected sleeper: records the requested waits and never sleeps."""

    def __init__(self) -> None:
        self.calls: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


@contextlib.contextmanager
def temp_dir() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="sitecheck-test-") as d:
        yield Path(d)


@contextlib.contextmanager
def patched_env(**values: str | None) -> Iterator[None]:
    """Set (or, with None, remove) environment variables for the duration of the block."""
    old = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    """Call sitecheck.cli.main(argv) in-process; return (exit code, stdout, stderr)."""
    from sitecheck import cli

    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli.main(argv)
        except SystemExit as exc:  # argparse usage errors and --help
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 2)
    return int(code), out.getvalue(), err.getvalue()
