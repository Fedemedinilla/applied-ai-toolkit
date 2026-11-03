"""Helpers for the end-to-end regression tests.

Runs the real CLI against a FakeSite and FakeApis and keeps, in memory,
everything a test wants to look at after the temporary folder is gone.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import support  # noqa: F401
from support import TEST_KEY, patched_env, run_cli, temp_dir

from fakeapis import FakeApis, FakeApisConfig
from fakesite import FakeSite, Route, Scenario

HTML = [("Content-Type", "text/html; charset=UTF-8")]


@dataclass
class RunResult:
    code: int
    out: str
    err: str
    site_urls: list[str]
    api_paths: list[str]
    api_queries: list[str]
    folder: str | None = None  # <out>/<folder>/<date>
    datos: dict[str, Any] | None = None
    files: dict[str, str] = field(default_factory=dict)  # client files, by name
    evidence: dict[str, bytes] = field(default_factory=dict)  # evidencia/<name> -> bytes

    def check(self, cid: str) -> dict[str, Any]:
        assert self.datos is not None, "no datos.json"
        return next(c for c in self.datos["checks"] if c["id"] == cid)

    def log_lines(self) -> list[dict[str, Any]]:
        raw = self.evidence.get("requests.log", b"").decode("utf-8")
        return [json.loads(x) for x in raw.splitlines() if x.strip()]


def run_e2e(
    scenario: Scenario,
    apis_cfg: FakeApisConfig,
    *,
    url: str = "https://www.colegio.test/",
    nombre: str | None = "Colegio Ejemplo",
    extra: tuple[str, ...] = (),
    key: str = TEST_KEY,
    exclude: str | None = None,
    kind: str | None = "colegio",
) -> RunResult:
    """``kind`` defaults to "colegio" because the fake site is a (fictional) school."""
    with temp_dir() as salidas, FakeSite(scenario) as site, FakeApis(apis_cfg) as apis:
        if exclude is not None:
            (salidas / "exclude.txt").write_text(exclude, encoding="utf-8")
        argv = [url, "--out", str(salidas), "--test-loopback", site.loopback, "--test-services", apis.base, *extra]
        if kind is not None and "--kind" not in extra:
            argv[1:1] = ["--kind", kind]
        if nombre is not None:
            argv[1:1] = ["--name", nombre]
        with patched_env(SITE_CHECK_TEST_API_KEY=key, PAGESPEED_API_KEY="REAL-KEY-MUST-NEVER-BE-USED-000"):
            code, out, err = run_cli(argv)
        result = RunResult(
            code=code,
            out=out,
            err=err,
            site_urls=site.requested_urls(),
            api_paths=[r.path for r in apis.requests],
            api_queries=[r.raw_path for r in apis.requests],
        )
        runs = [p for p in salidas.glob("*/*") if p.is_dir()]
        if runs:
            rd = runs[0]
            result.folder = rd.parent.name
            if (rd / "datos.json").exists():
                result.datos = json.loads((rd / "datos.json").read_text(encoding="utf-8"))
            for p in rd.iterdir():
                if p.is_file() and p.suffix in (".md", ".txt"):
                    result.files[p.name] = p.read_text(encoding="utf-8")
            ev = rd / "evidencia"
            if ev.is_dir():
                for p in ev.iterdir():
                    if p.is_file():
                        result.evidence[p.name] = p.read_bytes()
        return result


def filler(n: int = 40) -> str:
    return "".join(f"<p>Párrafo {i} del colegio con información para las familias sobre niveles y horarios.</p>\n" for i in range(n))


def small_home(extra_links: str = "", *, links: bool = True, pad: int = 40, title: str = "Colegio Ejemplo | Educación") -> bytes:
    """A small static home (about 4 KB with pad=40) with on-site links."""
    nav = (
        '<nav><a href="/">Inicio</a> <a href="/institucional/">Institucional</a> <a href="/contacto/">Contacto</a>'
        f"{extra_links}</nav>"
        if links
        else ""
    )
    return (
        '<!DOCTYPE html><html lang="es-AR"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{title}</title>"
        '<meta name="description" content="Colegio Ejemplo en Buenos Aires con nivel inicial, primario y secundario, jornada completa e inglés.">'
        f"</head><body>{nav}<h1>Colegio Ejemplo</h1>{filler(pad)}<footer>&copy; 2026 Colegio Ejemplo</footer></body></html>"
    ).encode("utf-8")


def control_route() -> Route:
    return Route(200, list(HTML), b"<!DOCTYPE html><html><head><title>Control</title></head><body>ok</body></html>")
