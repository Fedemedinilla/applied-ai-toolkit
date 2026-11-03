"""The EVIDENCE GATE: no finding without the file that proves it.

A green needs evidence and so does a red: a false "no aparece imagen en
WhatsApp" destroys the credibility of the whole report. Rules, applied to every
Finding after evaluation and BEFORE the colour is derived:

1. Any APROBADO / APROBADO_CON_OBSERVACION / FALLA whose ``evidence`` list is
   empty, or names a file that was not written (artifacts_written), becomes
   NO_VERIFICADO with reason "la evidencia de esta medición no se pudo guardar".
2. For checks with ``html_derived`` (CheckSpec): a FALLA requires that the page
   it reads passed html_evidence_ok; otherwise NO_VERIFICADO with reason
   "la página respondió con algo que no es la portada" (or "verificación anti-bot
   del hosting" when the response was challenged).
   2b. A home whose body arrived incomplete (``truncated``: shorter than its
   Content-Length, or cut at the size cap) proves nothing in either direction:
   EVERY html_derived finding that is not
   already grey (green, observation or FALLA) becomes NO_VERIFICADO with
   reason "la página principal llegó incompleta". An absence ("no hay botón de
   WhatsApp", "no hay año") read on half a page is not a measurement.
3. ``evidence_ok`` = rules 1 and 2 passed.

html_evidence_ok checks: status 200; Content-Type text/html; body decoded
(no undecodable Content-Encoding); body complete (not truncated); contains
"<head"; decoded length >= MIN_HTML_BYTES; not challenged; final URL on the
canonical host; U+FFFD replacement characters <= MAX_REPLACEMENT_RATIO of the
text; not a WRAPPER (``home_wrapper``): a meta refresh
of at most WRAPPER_REFRESH_MAX_S seconds to another address, a JavaScript
redirect with little else, a <frameset>, a single full-page <iframe>, or an
SPA shell (under SPA_SHELL_MAX_TEXT characters of visible text and no
<a href> to the site). A wrapper is not the page the visitor sees, so an
absence read on it ("no hay botón de WhatsApp") is not a measurement; its
FALLAs become NO_VERIFICADO with REASON_WRAPPER.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import TYPE_CHECKING

from . import domains
from .model import CheckSpec, Finding, ReportPhrase, State

if TYPE_CHECKING:
    from .httpclient import Response
    from .observations import Observations

MIN_HTML_BYTES = 1024
MAX_REPLACEMENT_RATIO = 0.001

REASON_NO_EVIDENCE = "la evidencia de esta medición no se pudo guardar"
REASON_NOT_HOME = "la página respondió con algo que no es la portada"
REASON_CHALLENGE = "verificación anti-bot del hosting"
REASON_TRUNCATED = "la página principal llegó incompleta"
# Client text (report grey lines): what the wrapper is, never what to do about it.
REASON_WRAPPER = "la página principal no trae el contenido que ve el visitante (lo carga aparte o lleva a otra dirección)"

# Wrapper thresholds.
WRAPPER_REFRESH_MAX_S = 10  # a meta refresh up to this delay is a redirect, not a page
SPA_SHELL_MAX_TEXT = 150  # visible characters of an SPA shell or a single-iframe page
JS_REDIRECT_MAX_TEXT = 500  # "little else" next to a JavaScript redirect


@dataclass(frozen=True)
class HomeWrapper:
    """A home that is not the page the visitor sees."""

    kind: str  # "meta-refresh", "js-redirect", "frameset", "iframe", "spa-shell"
    target: str | None = None  # absolute URL it sends to or shows; None for an SPA shell
    delay: float | None = None  # seconds of a meta refresh
    text_chars: int = 0  # visible characters of the wrapper itself

    def problem(self) -> str:
        """English, for gate_note."""
        if self.kind == "meta-refresh":
            return f"home is a wrapper: meta refresh after {self.delay:g} s to {self.target}"
        if self.kind == "js-redirect":
            return f"home is a wrapper: JavaScript redirect to {self.target}"
        if self.kind in ("frameset", "iframe"):
            return f"home is a wrapper: {self.kind} showing {self.target}"
        return f"home is a wrapper: SPA shell ({self.text_chars} visible characters, no link to the site)"


@dataclass
class EvidenceCheck:
    ok: bool
    problems: list[str] = field(default_factory=list)  # English, for gate_note
    wrapper: HomeWrapper | None = None  # the home is a wrapper (one of the problems)


HTML_TYPES: frozenset[str] = frozenset({"text/html", "application/xhtml+xml"})
EVIDENCE_STATES: frozenset[State] = frozenset({State.APROBADO, State.APROBADO_CON_OBSERVACION, State.FALLA})

_HIDDEN_TAGS = frozenset({"script", "style", "noscript", "template", "title", "head", "noframes", "iframe", "object", "svg"})
_VOID_TAGS = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "frame"})
_REFRESH_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?(.*))?$", re.IGNORECASE | re.DOTALL)
_JS_REDIRECT_RE = re.compile(
    r"(?:\blocation\s*\.\s*(?:replace|assign)\s*\(\s*|\blocation(?:\s*\.\s*href)?\s*=\s*)([\"'])([^\"'\s]{1,500})\1"
)
_FULL_SIZE_RE = re.compile(r"^\s*100\s*(?:%|vh|vw)?\s*$", re.IGNORECASE)
_STYLE_HEIGHT_RE = re.compile(r"(?:^|;)\s*height\s*:\s*100\s*(?:%|vh)", re.IGNORECASE)
_STYLE_WIDTH_RE = re.compile(r"(?:^|;)\s*width\s*:\s*100\s*(?:%|vw)", re.IGNORECASE)


class _WrapperScan(HTMLParser):
    """One pass over the home: refresh, frames, iframes, inline scripts, links and visible text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.refresh: str | None = None
        self.frameset = False
        self.frame_srcs: list[str] = []
        self.iframes: list[dict[str, str]] = []
        self.scripts: list[str] = []
        self.hrefs: list[str] = []
        self.base: str | None = None
        self._text: list[str] = []
        self._hidden = 0
        self._in_script = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta" and a.get("http-equiv", "").strip().lower() == "refresh" and self.refresh is None:
            self.refresh = a.get("content", "")
        elif tag == "base" and self.base is None and a.get("href"):
            self.base = a["href"].strip()
        elif tag == "frameset":
            self.frameset = True
        elif tag == "frame" and a.get("src"):
            self.frame_srcs.append(a["src"].strip())
        elif tag == "iframe":
            self.iframes.append(a)
        elif tag == "a" and a.get("href"):
            self.hrefs.append(a["href"].strip())
        if tag == "script":
            self._in_script = "src" not in a
        if tag == "body":
            self._hidden = 0  # an unclosed <head> never hides the body
        elif tag in _HIDDEN_TAGS and tag not in _VOID_TAGS:
            self._hidden += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in _HIDDEN_TAGS and self._hidden:
            self._hidden -= 1
        if tag == "script":
            self._in_script = False

    def handle_data(self, data: str) -> None:
        if self._in_script:
            self.scripts.append(data)
        elif not self._hidden:
            self._text.append(data)

    def visible_chars(self) -> int:
        return len(" ".join(" ".join(self._text).split()))


def _resolve(base: str, href: str | None) -> str | None:
    if not href:
        return None
    href = href.strip().strip("'\"").strip()
    if not href or href.lower().startswith(("javascript:", "data:", "about:", "#")):
        return None
    return domains.resolve_url(base, href)


def _is_full_size(attrs: dict[str, str]) -> bool:
    style = attrs.get("style", "")
    tall = bool(_FULL_SIZE_RE.match(attrs.get("height", ""))) or bool(_STYLE_HEIGHT_RE.search(style))
    wide = bool(_FULL_SIZE_RE.match(attrs.get("width", ""))) or bool(_STYLE_WIDTH_RE.search(style))
    return tall and wide


def home_wrapper(resp: "Response | None", canonical_host: str | None) -> HomeWrapper | None:
    """The kind of wrapper the home is, or None for a page with its own content.

    Rules, in this order:
    * meta refresh with a delay of at most WRAPPER_REFRESH_MAX_S seconds to
      another address (a refresh to itself or without a URL is a reload);
    * <frameset> (the first <frame src> is the target);
    * exactly one <iframe src> that is full size (width and height 100%) or
      has under SPA_SHELL_MAX_TEXT visible characters around it;
    * a JavaScript redirect (location.replace/assign, location(.href) = "...")
      in an inline script, with under JS_REDIRECT_MAX_TEXT visible characters;
    * an SPA shell: under SPA_SHELL_MAX_TEXT visible characters and no <a href>
      to the site.
    """
    if resp is None or not resp.body:
        return None
    try:
        text, _ = resp.text()
    except Exception:  # noqa: BLE001 - a body that cannot be decoded is judged elsewhere
        return None
    scan = _WrapperScan()
    try:
        scan.feed(text)
        scan.close()
    except Exception:  # noqa: BLE001 - html.parser is lenient; never let the gate raise
        return None
    page_url = resp.final_url or resp.url
    base = _resolve(page_url, scan.base) or page_url
    chars = scan.visible_chars()

    if scan.refresh is not None:
        m = _REFRESH_RE.match(scan.refresh)
        if m:
            delay = float(m.group(1))
            target = _resolve(base, (m.group(2) or "").strip())
            same_page = target is not None and domains.compare_key(target) == domains.compare_key(page_url)
            if delay <= WRAPPER_REFRESH_MAX_S and target and not same_page:
                return HomeWrapper("meta-refresh", target, delay, chars)
    if scan.frameset:
        target = next((t for t in (_resolve(base, s) for s in scan.frame_srcs) if t), None)
        return HomeWrapper("frameset", target, None, chars)
    framed = [a for a in scan.iframes if a.get("src")]
    if len(scan.iframes) == 1 and framed and (_is_full_size(framed[0]) or chars < SPA_SHELL_MAX_TEXT):
        return HomeWrapper("iframe", _resolve(base, framed[0]["src"]), None, chars)
    if chars < JS_REDIRECT_MAX_TEXT:
        for script in scan.scripts:
            m = _JS_REDIRECT_RE.search(script)
            if m:
                target = _resolve(base, m.group(2))
                if target and domains.compare_key(target) != domains.compare_key(page_url):
                    return HomeWrapper("js-redirect", target, None, chars)
    if chars < SPA_SHELL_MAX_TEXT:
        site = None
        if canonical_host:
            try:
                site = domains.site_domain(domains.normalize_host(canonical_host))
            except ValueError:
                site = None
        own_links = [h for h in scan.hrefs if (u := _resolve(base, h)) and site and domains.is_same_site(u, site)]
        if not own_links:
            return HomeWrapper("spa-shell", None, None, chars)
    return None


def html_evidence_ok(resp: "Response | None", canonical_host: str | None) -> EvidenceCheck:
    """Sanity of an HTML response used as evidence (criteria in the module docstring)."""
    problems: list[str] = []
    if resp is None:
        return EvidenceCheck(False, ["no response"])
    if resp.skipped:
        return EvidenceCheck(False, [f"request skipped ({resp.skipped})"])
    if resp.error:
        problems.append(f"network error ({resp.error})")
    if resp.challenge:
        problems.append(f"challenged ({resp.challenge})")
    if resp.status != 200:
        problems.append(f"status {resp.status}")
    ctype = resp.content_type
    if ctype not in HTML_TYPES:
        problems.append(f"content type {ctype}")
    if resp.undecodable_encoding:
        problems.append(f"undecodable content encoding {resp.undecodable_encoding}")
    if resp.truncated:
        why = "shorter than its Content-Length" if getattr(resp, "short_body", False) else "cut at the size cap"
        problems.append(f"body truncated ({why})")
    if len(resp.body) < MIN_HTML_BYTES:
        problems.append(f"body of {len(resp.body)} bytes, under {MIN_HTML_BYTES}")
    if resp.body:
        text, n_replaced = resp.text()
        if "<head" not in text.lower():
            problems.append("no <head")
        if text and n_replaced / len(text) > MAX_REPLACEMENT_RATIO:
            problems.append(f"{n_replaced} replacement characters")
    if not canonical_host:
        problems.append("canonical host unknown")
    else:
        try:
            final_host = domains.host_of(resp.final_url or resp.url)
            if final_host != domains.normalize_host(canonical_host):
                problems.append(f"final host {final_host} is not the canonical host")
        except ValueError:
            problems.append("final URL without a host")
    wrapper = home_wrapper(resp, canonical_host) if (resp.body and ctype in HTML_TYPES) else None
    if wrapper is not None:
        problems.append(wrapper.problem())
    return EvidenceCheck(not problems, problems, wrapper)


def _downgrade(finding: Finding, reason: str, note: str) -> None:
    finding.state = State.NO_VERIFICADO
    finding.reason = reason
    finding.phrase_report = ReportPhrase(found=reason)
    finding.colour_exception = None
    finding.evidence_ok = False
    finding.gate_note = f"{finding.gate_note}; {note}" if finding.gate_note else note


def apply_gate(
    findings: list[Finding],
    specs: Mapping[str, CheckSpec],
    obs: "Observations",
    artifacts_written: Mapping[str, bool],
) -> list[Finding]:
    """Apply rules 1 to 3 in place to every finding and return the list."""
    home_check: EvidenceCheck | None = None  # computed once, only when a check needs it
    home_resp = obs.home.response if obs.home is not None else None
    home_truncated = bool(home_resp is not None and home_resp.truncated)
    for f in findings:
        spec = specs.get(f.id)
        if f.state not in EVIDENCE_STATES:
            f.evidence_ok = False
            continue
        missing = [name for name in f.evidence if not artifacts_written.get(name, False)]
        if not f.evidence or missing:
            what = "no evidence listed" if not f.evidence else f"evidence not written: {', '.join(missing)}"
            _downgrade(f, REASON_NO_EVIDENCE, what)
            continue
        if spec is not None and spec.html_derived and home_truncated:
            # Rule 2b: half a page proves neither a presence nor an absence.
            _downgrade(f, REASON_TRUNCATED, "home HTML truncated: " + ("shorter than its Content-Length" if home_resp.short_body else "cut at the size cap"))
            f.hack_signal = False
            continue
        if spec is not None and spec.html_derived and f.state == State.FALLA:
            if home_check is None:
                home_check = html_evidence_ok(home_resp, obs.canonical_host)
            if not home_check.ok:
                challenged = bool(obs.blocked or (home_resp is not None and home_resp.challenge))
                _downgrade(
                    f,
                    REASON_CHALLENGE if challenged else (REASON_WRAPPER if home_check.wrapper else REASON_NOT_HOME),
                    "home HTML not usable as evidence: " + "; ".join(home_check.problems),
                )
                # A page that is not the real home cannot prove a compromise either.
                f.hack_signal = False
                continue
        f.evidence_ok = True
    return findings
