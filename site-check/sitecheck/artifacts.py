"""Evidence files: ``<out>/<D>/<date>/evidencia/``.

"A green without evidence does not exist." Every measurement that a
state relies on is written here as soon as it is obtained, and the store
remembers which names were written successfully; the evidence gate (gate.py)
downgrades to NO_VERIFICADO any green whose files are missing.

Every write passes through the Redactor (the PSI JSON never contains the key;
this is the second line of defence). RDAP JSON is stored without entities
(rdap.scrub_rdap does that before put_json). Names are flat file names; no
subdirectories, no path separators.

Personal data: the
evidence keeps what was measured, not the people on the page. Before writing,
every HTML, XML and text file, and every string of a JSON file, is masked with
mask_personal_data: e-mail addresses (also mailto:, %40 and &#64;) become
"[correo]", phone-like numbers of 8 or more digits (also tel:, wa.me/ and
phone=) become "[numero]", user names in /author/<name> and ?author= become
"[usuario]", and the content of <dc:creator> and <author> becomes "[autor]".
Dates, year ranges and version numbers are kept. Names written in free text
("Directora: María Gómez") cannot be told apart from any other words and stay.
The original is never lost for integrity: requests.log keeps the SHA-256
prefix of every body as received, and ``tapado.json`` lists, per masked
file, the full SHA-256 of the original and how many values were masked.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .credentials import Redactor

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")

# Fixed artifact names used across modules (checks cite them in Finding.evidence).
HOME_HTML = "home.html"
HOME_HEADERS = "headers-home.txt"
HOME_RELOAD_HEADERS = "headers-home-{n}.txt"  # n = 2, 3
INTERNA_HTML = "interna.html"
INTERNA_HEADERS = "headers-interna.txt"
FORM_HTML = "formulario.html"
VARIANTS = "variantes.json"  # EXT-17 chains
TTFB = "ttfb.json"  # EXT-20 samples, site and control
ROBOTS = "robots.txt"
SITEMAP = "sitemap.xml"
SITEMAP_CHILD = "sitemap-hijo.xml"
FEED = "feed.xml"
OG_IMAGE = "og-image.json"  # status, type, size, pixel size (not the bytes)
HREFLANG = "hreflang.json"
LINKS = "enlaces.json"  # VIS-09 survey
PSI_MOBILE = "psi-mobile-{n}.json"  # n = 1..runs
PSI_DESKTOP = "psi-desktop.json"
CRUX = "crux.json"
DNS = "dns.json"
MAIL_DOMAINS = "dominios-correo.json"  # VIS-21: MX, then A/AAAA, of the mailto: domains (never an address)
RDAP = "rdap.json"
DBL = "dbl.json"
TLS = "tls.json"
WP_STABLE = "wp-stable-check.json"  # only the relevant entries, not the whole list
OBSERVATORY = "observatory.json"
SCOPE = "alcance.json"  # ScopeGuard.describe
MASKED = "tapado.json"  # what mask_personal_data replaced, per file

# Names owned by other writers in the same folder; the store never writes them.
RESERVED_NAMES: frozenset[str] = frozenset({"requests.log"})


_MASK_EXTENSIONS: tuple[str, ...] = (".html", ".xml", ".txt")

# The lookbehind makes a match start only where a run of local-part characters
# starts: the leftmost match always starts there anyway, so the matches are the
# same, and a long run without "@" (a percent-encoded SVG in a data: URI) is
# scanned once instead of once per character (audit: 50 KiB took
# minutes).
_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+(?:@|%40|&#0*64;|&#x0*40;)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+",
    re.IGNORECASE,
)
# Numbers inside a link: tel:, wa.me/, api.whatsapp.com/send?phone=, phone=.
_LINK_PHONE_RE = re.compile(r"((?:tel:|wa\.me/|[?&](?:amp;)?phone=)\s*)(\+?[\d\s().%20-]{8,40}\d)", re.IGNORECASE)
# A phone written as text: digits with spaces, dots, dashes or parentheses.
_TEXT_PHONE_RE = re.compile(r"(?<![\w/.:#=%&+-])\+?\(?\d[\d \t.()-]{6,40}\d(?![\w/])")
_YEAR_RANGE_RE = re.compile(r"(?:19|20)\d\d\s*[-/]\s*(?:19|20)\d\d")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}")
_AUTHOR_PATH_RE = re.compile(r"(/author/)([^/?#\"'\s<>]+)", re.IGNORECASE)
_AUTHOR_QUERY_RE = re.compile(r"([?&](?:amp;)?author=)([^&#\"'\s<>]+)", re.IGNORECASE)
_PERSON_TAGS: tuple[str, ...] = ("dc:creator", "author")


# Inside one of these attributes the digits are geometry (SVG viewBox, path data,
# points...), never a phone number: masking them would only damage the evidence.
_GEOMETRY_ATTR_RE = re.compile(
    r"""\b(?:d|viewbox|points|transform|values|keytimes|keysplines|stroke-dasharray|data-points)\s*=\s*["'][^"'<>]*$""",
    re.IGNORECASE,
)


def _is_ipv4(text: str) -> bool:
    """A dotted-quad IPv4 address (each part 0 to 255): evidence such as a DBL answer, never a phone."""
    parts = text.split(".")
    return len(parts) == 4 and all(p.isdigit() and len(p) <= 3 and int(p) <= 255 for p in parts)


def _mask_text_phone(m: re.Match[str], counts: dict[str, int]) -> str:
    raw = m.group(0)
    digits = sum(ch.isdigit() for ch in raw)
    if digits < 8 or _YEAR_RANGE_RE.fullmatch(raw.strip()) or _DATE_RE.fullmatch(raw.strip()):
        return raw
    if _is_ipv4(raw.strip()):
        return raw  # 127.0.1.102 in dbl.json is the EXT-23 evidence
    if _GEOMETRY_ATTR_RE.search(m.string[max(0, m.start() - 400) : m.start()]):
        return raw
    counts["numero"] = counts.get("numero", 0) + 1
    return "[numero]"


def _mask_tag_contents(text: str, tag: str, counts: dict[str, int]) -> str:
    """Replace the content of every <tag ...>...</tag> by "[autor]" (forward-only scan, linear)."""
    open_re = re.compile(rf"<{re.escape(tag)}(?=[\s>])[^>]*>", re.IGNORECASE)
    close_re = re.compile(rf"</{re.escape(tag)}\s*>", re.IGNORECASE)
    out: list[str] = []
    pos = 0
    while True:
        m = open_re.search(text, pos)
        if m is None:
            break
        c = close_re.search(text, m.end())
        if c is None:
            break
        out.append(text[pos : m.end()])
        out.append("[autor]")
        counts["autor"] = counts.get("autor", 0) + 1
        pos = c.start()
    out.append(text[pos:])
    return "".join(out)


def mask_personal_data(text: str, counts: dict[str, int] | None = None) -> str:
    """``text`` with e-mails, phone numbers, user names and authors masked (module docstring)."""
    counts = counts if counts is not None else {}

    def sub(rx: re.Pattern[str], repl, value: str, label: str) -> str:  # type: ignore[no-untyped-def]
        def fn(m: re.Match[str]) -> str:
            counts[label] = counts.get(label, 0) + 1
            return repl(m) if callable(repl) else repl

        return rx.sub(fn, value)

    t = sub(_EMAIL_RE, "[correo]", text, "correo")
    t = sub(_LINK_PHONE_RE, lambda m: m.group(1) + "[numero]", t, "numero")
    t = _TEXT_PHONE_RE.sub(lambda m: _mask_text_phone(m, counts), t)
    t = sub(_AUTHOR_PATH_RE, lambda m: m.group(1) + "[usuario]", t, "usuario")
    t = sub(_AUTHOR_QUERY_RE, lambda m: m.group(1) + "[usuario]", t, "usuario")
    for tag in _PERSON_TAGS:
        if "<" + tag in t.lower():
            t = _mask_tag_contents(t, tag, counts)
    return t


def _mask_json(obj: Any, counts: dict[str, int]) -> Any:
    if isinstance(obj, str):
        return mask_personal_data(obj, counts)
    if isinstance(obj, dict):
        return {k: _mask_json(v, counts) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_mask_json(v, counts) for v in obj]
    return obj


class ArtifactStore:
    """Writes evidence files and tracks which ones exist.

    ``directory`` None keeps everything in memory (unit tests). ``read_only``
    True (used by --rerender) loads the existing names and refuses writes.
    """

    def __init__(self, directory: Path | None, redactor: "Redactor", *, read_only: bool = False) -> None:
        self._dir = directory
        self._redactor = redactor
        self._read_only = read_only
        self._mem: dict[str, bytes] = {}
        self._written: dict[str, bool] = {}
        self._masked: dict[str, dict[str, Any]] = {}  # name -> {"sha256_original", "tapados"}
        if directory is not None and read_only:
            try:
                for p in sorted(directory.iterdir()):
                    if p.is_file() and NAME_RE.match(p.name):
                        self._written[p.name] = True
            except OSError:
                pass
        elif directory is not None:
            directory.mkdir(parents=True, exist_ok=True)

    def put_bytes(self, name: str, data: bytes) -> bool:
        """Write ``data`` (redacted) under ``name``. True on success; False on any OSError.

        Never overwrites an existing file of this run: a second put with the same
        name is a programming error (ValueError). Validates ``name`` with NAME_RE.
        """
        if self._read_only:
            raise ValueError("read-only artifact store: no writes in --rerender")
        if not isinstance(name, str) or not NAME_RE.match(name) or name in RESERVED_NAMES:
            raise ValueError(f"invalid artifact name: {name!r}")
        if name in self._written:
            raise ValueError(f"artifact written twice in one run: {name}")
        data = bytes(data)
        if name.endswith(_MASK_EXTENSIONS):
            data = self._mask_bytes(name, data)
        clean = self._redactor.scrub_bytes(data)
        if self._dir is None:
            self._mem[name] = clean
            self._written[name] = True
            return True
        try:
            with open(self._dir / name, "xb") as fh:  # "x": never overwrite evidence
                fh.write(clean)
        except OSError:
            self._written[name] = False
            return False
        self._written[name] = True
        return True

    def put_text(self, name: str, text: str) -> bool:
        """UTF-8 text variant of put_bytes (newline '\\n', no BOM)."""
        return self.put_bytes(name, text.encode("utf-8"))

    def put_json(self, name: str, obj: Any) -> bool:
        """JSON variant: json.dumps(obj, sort_keys=True, ensure_ascii=False, indent=2).

        Every string is masked with mask_personal_data first (numbers stay
        numbers, so the file is still valid JSON).
        """
        counts: dict[str, int] = {}
        original = json.dumps(obj, sort_keys=True, ensure_ascii=False, indent=2, default=str)
        masked = _mask_json(json.loads(original), counts) if name != MASKED else json.loads(original)
        if counts:
            self._masked[name] = {
                "sha256_original": hashlib.sha256(original.encode("utf-8")).hexdigest(),
                "tapados": dict(sorted(counts.items())),
            }
        text = json.dumps(self._redactor.scrub_json(masked), sort_keys=True, ensure_ascii=False, indent=2, default=str)
        return self.put_text(name, text + chr(10))

    def _mask_bytes(self, name: str, data: bytes) -> bytes:
        """mask_personal_data over an HTML/XML/text body (decoded as UTF-8, else latin-1, so bytes round-trip)."""
        try:
            text, encoding = data.decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            text, encoding = data.decode("latin-1"), "latin-1"
        counts: dict[str, int] = {}
        masked = mask_personal_data(text, counts)
        if not counts:
            return data
        self._masked[name] = {"sha256_original": hashlib.sha256(data).hexdigest(), "tapados": dict(sorted(counts.items()))}
        return masked.encode(encoding, errors="replace")

    def masking_report(self) -> dict[str, dict[str, Any]]:
        """Per masked file: the SHA-256 of the original and how many values of each kind were masked."""
        return {k: dict(v) for k, v in sorted(self._masked.items())}

    def written(self, name: str) -> bool:
        """True when ``name`` was written successfully in this run (or exists, in read-only mode)."""
        return bool(self._written.get(name, False))

    def written_map(self) -> dict[str, bool]:
        """Every name attempted, mapped to whether it was written."""
        return dict(self._written)

    def read_bytes(self, name: str) -> bytes | None:
        """Return a stored artifact (memory or disk), or None."""
        if name in self._mem:
            return self._mem[name]
        if self._dir is None or not isinstance(name, str) or not NAME_RE.match(name):
            return None
        try:
            return (self._dir / name).read_bytes()
        except OSError:
            return None


def headers_as_text(status: int | None, reason: str, headers: list[tuple[str, str]], url: str) -> str:
    """Render a status line and headers as the ``headers-*.txt`` evidence format.

    First line ``<url>``, second ``HTTP/1.1 <status> <reason>``, then one
    ``Name: value`` per header in received order (Set-Cookie values replaced by
    "[omitido]": cookies are not evidence and may carry identifiers).
    """
    status_text = str(status) if status is not None else "(sin respuesta)"
    lines = [url, f"HTTP/1.1 {status_text} {reason or ''}".rstrip()]
    for name, value in headers:
        if name.lower() == "set-cookie":
            value = "[omitido]"
        lines.append(f"{name}: {value}")
    return chr(10).join(lines) + chr(10)
