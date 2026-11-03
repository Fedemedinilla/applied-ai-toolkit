"""Run folder, datos.json, 00-tiempo.txt and the final sweeps of the outputs.

Folder: ``<root>/<registrable>/<YYYY-MM-DD>/`` (local Buenos Aires date); if it
exists, ``<date>-2``, ``-3``... Evidence is NEVER overwritten. The root is --out,
else the SITE_CHECK_OUT environment variable, else ./site-check-runs
(config.default_output_root). Files:

* datos.json (schema below), informe.md (the report) and anexo-tecnico.md
  (the technical annex);
* 00-tiempo.txt: start and end, local time;
* evidencia/: requests.log and every artifact (artifacts.py). Deleted by
  prune_old_evidence at the start of a later run once its folder's date is more
  than EVIDENCE_RETENTION_DAYS old: raw pages can carry pictures and names of
  people, and the report does not need them after the review window. Nothing
  else of the run folder is ever deleted.

datos.json (schema_version 1; json.dumps(sort_keys=True, ensure_ascii=False, indent=2)).
Keys are Spanish, like the report they feed:
  schema_version;
  meta: version_script, version_python, version_openssl, version_expat,
        url_entrada, dominio (D), url_canonica (H), url_interna (I),
        origen_interna, institucion, tipo, para, inicio_utc, fin_utc,
        inicio_local, fin_local, user_agent, pedidos {por tipo y resultado},
        eventos_desafio, sitio_cortado, tope_agotado, clave ("presente"/"ausente"),
        corridas_psi {pedidas, validas, computadora_valida}, version_lighthouse,
        alcance (ScopeGuard.describe, with e-mails and long digit runs masked),
        corridas_previas, excluido, modo_prueba, errores, portada_no_respondio,
        sin_pagespeed, pausa_segundos, max_pedidos, pedidos_sitio, minutos_sitio,
        herramientas, condiciones, omitidos [{proposito, url, motivo}],
        aviso_pagespeed, aviso_lighthouse (a Lighthouse major other than
        psi.VERIFIED_LIGHTHOUSE_MAJOR), aviso_wordpress (the newest WordPress
        branch missing from wpversions.BRANCH_RELEASES), each a note or null;
  encabezado: GoogleSummary.to_datos;
  checks: [Finding.to_datos ...] in registry order;
  tablas: {velocidad: {intro, filas: [{que, valor, significa}], nota_laboratorio, atribucion},
           correo: {filas: [...], nota_no_aplica}};
  resumen: {por_color: {rojo, amarillo, azul, verde, gris}, aplicables, no_aplica, total, por_estado};
  senales_hackeo: [str] (evaluate.HackGate.reasons);
  salida: {codigo, nombre, control_texto: [{archivo, linea, regla, extracto}], borrados,
           rehecho (only after --rerender: {fecha_local, desde})}.
No e-mail address from the site (except the institutional role addresses VIS-21
names), no phone number, no RDAP entity, no key ever: the pipeline masks e-mail
addresses in every string of datos.json before writing (any found counts as a
text-control failure, exit 4).
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import enum
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import SCHEMA_VERSION
from .fmt import ART

if TYPE_CHECKING:
    from .credentials import Redactor

DATOS = "datos.json"
INFORME = "informe.md"
ANEXO = "anexo-tecnico.md"  # the technical annex, apart from the short report
TIEMPO = "00-tiempo.txt"
EVIDENCIA = "evidencia"
REQUESTS_LOG = "requests.log"

# Evidence retention: the evidencia/ folder of a run whose folder date is more
# than this many days before today is deleted at the start of the next run. Only
# that folder: the report, the annex and datos.json stay.
EVIDENCE_RETENTION_DAYS = 30
RUN_DIR_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$")

# An e-mail address: local part, "@", a dotted domain. A trailing sentence dot is
# not captured because every label must be followed by more label characters.
# The lookbehind keeps the scan linear with the same matches (artifacts._EMAIL_RE).
EMAIL_RE = re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
EMAIL_MASK = "[correo]"

_SAFE_COMPONENT_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,252}$")


@dataclass(frozen=True)
class RunPaths:
    root: Path
    evidencia: Path
    datos: Path
    informe: Path
    anexo: Path
    tiempo: Path
    requests_log: Path

    @classmethod
    def for_root(cls, root: Path) -> "RunPaths":
        """All paths of a run folder (nothing is created)."""
        root = Path(root)
        evidencia = root / EVIDENCIA
        return cls(
            root=root,
            evidencia=evidencia,
            datos=root / DATOS,
            informe=root / INFORME,
            anexo=root / ANEXO,
            tiempo=root / TIEMPO,
            requests_log=evidencia / REQUESTS_LOG,
        )

    def client_files(self) -> list[Path]:
        """The files a reader of the report gets: the ones textlint controls."""
        return [self.informe, self.anexo]


def create_run_dir(salidas: Path, registrable: str, run_date: dt.date) -> RunPaths:
    """Create ``salidas/<registrable>/<date>[-n]/evidencia/`` (never reusing a folder) and return its paths."""
    if not _SAFE_COMPONENT_RE.match(registrable or "") or ".." in registrable:
        raise ValueError(f"unsafe registrable domain for a folder name: {registrable!r}")
    base = Path(salidas) / registrable
    base.mkdir(parents=True, exist_ok=True)
    stem = run_date.isoformat()
    n = 1
    while True:
        root = base / (stem if n == 1 else f"{stem}-{n}")
        try:
            root.mkdir(exist_ok=False)
        except FileExistsError:
            n += 1
            continue
        break
    paths = RunPaths.for_root(root)
    paths.evidencia.mkdir()
    return paths


@dataclass
class PruneResult:
    """What prune_old_evidence did: the evidencia/ folders removed and the ones that could not be."""

    removed: list[Path] = dataclasses.field(default_factory=list)
    failed: list[Path] = dataclasses.field(default_factory=list)


def _is_link(path: Path) -> bool:
    """A symlink or a Windows junction: never followed and never deleted by the retention."""
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        return bool(is_junction()) if is_junction is not None else False
    except OSError:
        return True  # cannot tell: treat it as a link (never touched)


def _real_dirs(folder: Path) -> list[Path]:
    """The subfolders of ``folder`` that are real directories (links and files left out), sorted."""
    try:
        children = sorted(folder.iterdir())
    except OSError:
        return []
    return [c for c in children if not _is_link(c) and c.is_dir()]


def _run_date_of(name: str) -> dt.date | None:
    m = RUN_DIR_RE.match(name)
    if not m:
        return None
    try:
        return dt.date.fromisoformat(m.group(1))
    except ValueError:
        return None


def prune_old_evidence(root: Path, today: dt.date, *, days: int = EVIDENCE_RETENTION_DAYS) -> PruneResult:
    """Delete ``<root>/<domain>/<YYYY-MM-DD>[-n]/evidencia/`` of runs more than ``days`` days before ``today``.

    Only that subfolder of a run folder, and only when the run folder looks like
    one this tool wrote (datos.json, 00-tiempo.txt or evidencia/requests.log is
    there). Never anything else: not informe.md or datos.json, not a file
    outside a run folder, not the exclusion list. Links are never followed:
    a domain folder, a run folder or an evidencia that is a symlink or a
    junction is left alone, and shutil.rmtree removes a link inside evidencia
    without entering it. A folder name that is not a domain or a date is
    skipped. Errors never stop a run: the folder goes to ``failed``.
    """
    result = PruneResult()
    root = Path(root)
    if not root.is_dir():
        return result
    for domain_dir in _real_dirs(root):
        if not _SAFE_COMPONENT_RE.match(domain_dir.name) or "." not in domain_dir.name:
            continue
        for run_dir in _real_dirs(domain_dir):
            day = _run_date_of(run_dir.name)
            if day is None or (today - day).days <= days:
                continue
            evidence = run_dir / EVIDENCIA
            if _is_link(evidence) or not evidence.is_dir():
                continue
            if not any(p.is_file() for p in (run_dir / DATOS, run_dir / TIEMPO, evidence / REQUESTS_LOG)):
                continue
            try:
                shutil.rmtree(evidence)
            except OSError:
                result.failed.append(evidence)
                continue
            result.removed.append(evidence)
    return result


def prune_message(result: PruneResult, days: int = EVIDENCE_RETENTION_DAYS) -> str:
    """The console line of the retention: how many evidencia folders were removed."""
    n = len(result.removed)
    if n == 0:
        line = f"Evidence older than {days} days: nothing to delete."
    elif n == 1:
        line = f"Evidence older than {days} days: deleted 1 evidencia folder."
    else:
        line = f"Evidence older than {days} days: deleted {n} evidencia folders."
    if result.failed:
        line += f" {len(result.failed)} could not be deleted; the next run tries again."
    return line


def _is_protected(path: Path) -> bool:
    return path.name == DATOS or EVIDENCIA in path.parts[:-1]


def write_text(path: Path, text: str) -> None:
    """UTF-8, no BOM, newline '\\n'; refuses to overwrite datos.json or evidence (ValueError)."""
    path = Path(path)
    if _is_protected(path):
        raise ValueError(f"write_text never writes datos.json or evidence: {path.name}")
    data = text.replace("\r\n", "\n").replace("\r", "\n")
    if not data.endswith("\n"):
        data += "\n"
    path.write_bytes(data.encode("utf-8"))


def _json_default(obj: Any) -> Any:
    """Last-resort conversion for values that json cannot serialize."""
    if isinstance(obj, enum.Enum):
        return obj.value
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, (dt.datetime, dt.date)):
        return obj.isoformat()
    if isinstance(obj, (set, frozenset)):
        return sorted(obj, key=str)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    if isinstance(obj, bytes):
        return f"<{len(obj)} bytes>"
    return repr(obj)


def dumps_datos(datos: dict[str, Any]) -> str:
    """The exact text written to datos.json."""
    return json.dumps(datos, sort_keys=True, ensure_ascii=False, indent=2, default=_json_default) + "\n"


def _next_backup(root: Path) -> Path:
    n = 1
    while (root / f"datos-{n}.json").exists():
        n += 1
    return root / f"datos-{n}.json"


def write_datos(paths: RunPaths, datos: dict[str, Any], *, rerender: bool = False) -> None:
    """Write datos.json (sorted keys, ensure_ascii False, indent 2).

    A normal run writes it once. With ``rerender`` the existing file
    is first renamed to ``datos-<n>.json`` (n = 1, 2, ...; never lost) and the
    new one differs only in the derived sections (colours of checks, resumen,
    salida): measurements, evidence lists and meta are copied unchanged by the
    caller (pipeline.rerender).
    """
    text = dumps_datos(datos)
    if paths.datos.exists():
        if not rerender:
            raise ValueError("datos.json already exists in this run folder; it is written once")
        paths.datos.rename(_next_backup(paths.root))
    tmp = paths.datos.with_name(DATOS + ".tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, paths.datos)


def read_datos(path: Path) -> dict[str, Any]:
    """Load a datos.json for --rerender; ValueError (exit 2) when schema_version is unknown."""
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise ValueError(f"{path} does not exist") from exc
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError(f"cannot read {path.name}: {type(exc).__name__}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} does not have the shape of a datos.json")
    version = data.get("schema_version")
    if version != SCHEMA_VERSION:
        raise ValueError(f"{path.name} has schema_version {version!r}; this tool reads {SCHEMA_VERSION}")
    return data


def _dmy_hm(moment: dt.datetime) -> str:
    if moment.tzinfo is None:
        raise ValueError("naive datetime: the run clock is always timezone-aware")
    local = moment.astimezone(ART)
    return f"{local.day}/{local.month}/{local.year} {local.hour}:{local.minute:02d}"


def write_tiempo(paths: RunPaths, start: dt.datetime, end: dt.datetime) -> None:
    """00-tiempo.txt: two lines, 'inicio: 14:05' and 'fin: 14:13' (ART)."""
    write_text(paths.tiempo, f"inicio: {_dmy_hm(start)}\nfin: {_dmy_hm(end)}\n")


def sweep_secrets(root: Path, redactor: "Redactor") -> list[Path]:
    """Scan every file under ``root``; delete each one that contains a secret; return the deleted paths.

    A non-empty result makes the run fail with TEXT_CONTROL (exit 4).
    """
    deleted: list[Path] = []
    for path in sorted(Path(root).rglob("*")):
        if not path.is_file():
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if redactor.contains_secret(data):
            path.unlink()
            deleted.append(path)
    return deleted


def allowed_email_forms(addresses: "frozenset[str] | set[str] | list[str] | tuple[str, ...]") -> frozenset[str]:
    """The lowercased forms under which EMAIL_RE finds each allowed address in a text.

    An address with an accent in its local part ("secretaría@colegio.test") is
    found by EMAIL_RE only from the last ASCII run ("a@colegio.test"); that
    form is allowed too, so the institution's own address never fails the control.
    """
    forms: set[str] = set()
    for addr in addresses or ():
        text = str(addr or "").strip().lower()
        if not text:
            continue
        forms.add(text)
        forms.update(m.group(0).lower() for m in EMAIL_RE.finditer(text))
    return frozenset(forms)


def foreign_emails(text: str, allowed: frozenset[str] = frozenset()) -> list[str]:
    """E-mail addresses in ``text`` other than ``allowed`` (none may appear).

    ``allowed`` (lowercased, allowed_email_forms) is the run's institutional
    role addresses that VIS-21 names: the organisation's own published contact,
    never a person's address.
    """
    seen: list[str] = []
    for m in EMAIL_RE.finditer(text or ""):
        addr = m.group(0)
        if addr.lower() in allowed or addr in seen:
            continue
        seen.append(addr)
    return seen


def mask_foreign_emails(obj: Any, allowed: frozenset[str] = frozenset()) -> tuple[Any, list[str]]:
    """Deep copy of a JSON-like object with every foreign e-mail replaced by EMAIL_MASK.

    Returns (masked copy, addresses found). Keys are masked too. ``allowed``:
    as in foreign_emails.
    """
    found: list[str] = []

    def mask(text: str) -> str:
        addrs = foreign_emails(text, allowed)
        if not addrs:
            return text
        for a in addrs:
            if a not in found:
                found.append(a)
        return EMAIL_RE.sub(
            lambda m: m.group(0) if (m.group(0).lower() in allowed) else EMAIL_MASK,
            text,
        )

    def walk(value: Any) -> Any:
        if isinstance(value, str):
            return mask(value)
        if isinstance(value, dict):
            return {mask(k) if isinstance(k, str) else k: walk(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [walk(v) for v in value]
        return value

    return walk(obj), found


_LONG_DIGITS_RE = re.compile(r"\+?\d{8,}")


def mask_long_digit_runs(obj: Any) -> Any:
    """Deep copy with runs of 8 or more digits (phone numbers in URLs: wa.me/549...,
    ?phone=549...) replaced by "[numero]".

    Applied only to sections that list raw URLs (meta.alcance, meta.omitidos),
    never to measurements or hashes.
    """

    def mask(text: str) -> str:
        return _LONG_DIGITS_RE.sub("[numero]", text)

    def walk(value: Any) -> Any:
        if isinstance(value, str):
            return mask(value)
        if isinstance(value, dict):
            return {k: walk(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [walk(v) for v in value]
        return value

    return walk(obj)
