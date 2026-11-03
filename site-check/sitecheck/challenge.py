"""Anti-bot challenge detection.

A response is a challenge when ANY of these holds:

(a) the body contains one of BODY_MARKERS (case-insensitive), or the response
    carries a header in HEADER_MARKERS;
(b) two or more DISTINCT URLs returned 200 with the same SHA-256 body and less
    than SMALL_BODY_LIMIT bytes (the "200 de unos 12 KB" signal). The first URL
    is flagged retroactively when the second one arrives;
(c) a resource expected as text/plain, XML or image (robots.txt, sitemap, feed,
    og:image) came back as text/html;
(d) status 403, 429 or 503 together with any marker of (a).

Copies of the home are NOT a challenge. Once
the collector knows the home (set_home), and the home is GENUINE (it links at
least one other page of the site):

* rule (b) never pairs two home-equivalent URLs (H, the input URL, the four
  EXT-17 variants) and never counts a body identical to the home's;
* rule (c) does not fire for a body identical to the home's (an SPA fallback or
  a soft 404 that serves index.html), nor for any HTML body without markers:
  the verdict is ``soft_404`` ("no existe"), not a challenge. A markerless
  challenge served for every URL is still caught by rule (b).

A home WITHOUT links (a markerless challenge page served for every URL looks
like that) keeps the strict rules, and a body identical to it on robots.txt, a
sitemap, the feed or og:image flags the home itself (``same_as_home``).

Rule (e), THROTTLE, is decided by the client from the status line: any
429, a 503 with Retry-After, or a second 403 on a distinct URL. Since the audit
of a 403 counts toward it only with a challenge marker, a
Retry-After header, or on a URL that answered 2xx earlier in the run: two
ordinary pages that answer 403 (directories without an index) are not the site
asking to slow down.

A challenged response is never used to decide a state: what depends on it is
NO_VERIFICADO, never FALLA nor APROBADO. The reaction (wait 60 s, double the pause,
retry once, then cut the host) lives in httpclient.HttpClient; this module only
classifies.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum

BODY_MARKERS: tuple[str, ...] = (
    "One moment, please",
    "Just a moment",
    "Attention Required",
    "cf-chl",
    "sgcaptcha",
    "Checking your browser",
    "imunify360",
    "Sucuri Website Firewall",
    "access to this site has been limited",
)

# Header name (lowercase) -> value substring (lowercase) that marks a challenge.
HEADER_MARKERS: dict[str, str] = {
    "cf-mitigated": "challenge",
}

SMALL_BODY_LIMIT = 20 * 1024
CHALLENGE_STATUSES: frozenset[int] = frozenset({403, 429, 503})

MARKER_SCAN_BYTES = 64 * 1024
DUPLICATE_MARKER = "duplicate-body"

_LOWER_MARKERS: tuple[tuple[str, str], ...] = tuple((m, m.lower()) for m in BODY_MARKERS)


class Expect(StrEnum):
    """What the caller expects a response to be; drives rule (c) and the evidence gate."""

    HTML = "html"
    TEXT = "text"  # robots.txt
    XML = "xml"  # sitemaps, RSS/Atom feeds
    IMAGE = "image"  # og:image
    JSON = "json"  # third-party APIs
    ANY = "any"  # link checks (status and headers only)


class Rule(StrEnum):
    BODY_MARKER = "a"
    DUPLICATE_BODY = "b"
    WRONG_TYPE = "c"
    STATUS_MARKER = "d"
    THROTTLE = "e"  # the site asked to slow down (429, 503 + Retry-After, repeated 403)


@dataclass(frozen=True)
class ChallengeVerdict:
    """Result of inspecting one response."""

    challenged: bool
    rule: Rule | None = None
    marker: str | None = None  # the marker text, header or "duplicate-body"
    soft_404: bool = False  # HTML "not found" (or the home itself) instead of the resource: not a challenge
    same_as_home: bool = False  # challenged because the body IS the (link-less) home: flag the home too

    def describe(self) -> str:
        """Short English tag for logs, e.g. 'a:One moment, please' or 'b:duplicate-body'."""
        if not self.challenged or self.rule is None:
            return ""
        return f"{self.rule.value}:{self.marker or ''}"


@dataclass(frozen=True)
class ChallengeEvent:
    """One detection, as stored in datos.json meta.challenge_events."""

    seq: int  # RequestLog sequence number of the challenged response
    url: str
    rule: Rule
    marker: str
    action: str  # "retry-after-wait" | "host-cut" | "flagged-retroactively"


def _is_html_document(body: bytes, media: str | None) -> bool:
    """True when ``body`` is an HTML page (by its start, or by its tags when labelled text/html)."""
    head = bytes(body[:1024]).lower()
    if head.startswith(b"\xef\xbb\xbf"):
        head = head[3:]
    head = head.lstrip()
    if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
        return True
    if media == "text/html":
        return any(tag in head for tag in (b"<html", b"<head", b"<body", b"<title"))
    return False


def _media_type(headers: list[tuple[str, str]]) -> str | None:
    for name, value in headers:
        if name.lower() == "content-type":
            media = value.split(";", 1)[0].strip().lower()
            return media or None
    return None


def _distinct_key(url: str) -> str:
    """URL identity for rule (b): the same page spelled twice is not two URLs."""
    from .domains import compare_key  # local import keeps this module dependency-light

    try:
        return compare_key(url)
    except ValueError:
        return url.strip()


class ChallengeDetector:
    """Stateful classifier: keeps the body hashes seen in the run for rule (b)."""

    def __init__(self) -> None:
        # sha256 of a small 200 body -> distinct URL keys in arrival order, and the
        # URL as first seen for each key (what the caller passed in).
        self._by_hash: dict[str, list[str]] = {}
        self._spelling: dict[str, str] = {}
        self._home_keys: frozenset[str] = frozenset()
        self._home_sha: str | None = None
        self._home_genuine = False

    def set_home(self, url_keys: Iterable[str], sha256: str | None, genuine: bool) -> None:
        """Tell the detector which URLs are the home and what its body is (module docstring)."""
        self._home_keys = frozenset(_distinct_key(u) for u in url_keys)
        self._home_sha = sha256
        self._home_genuine = bool(genuine)

    @property
    def home_sha256(self) -> str | None:
        return self._home_sha

    def inspect(
        self,
        url: str,
        status: int | None,
        headers: list[tuple[str, str]],
        body: bytes,
        expect: Expect,
    ) -> ChallengeVerdict:
        """Apply rules (a), (c) and (d) to one response. Does not change the detector state."""
        marker: str | None = None
        for name, value in headers:
            wanted = HEADER_MARKERS.get(name.lower())
            if wanted is not None and wanted in (value or "").lower():
                marker = f"{name.lower()}: {value.strip()}"
                break
        if marker is None and body:
            marker = body_has_marker(body)
        if marker is not None:
            rule = Rule.STATUS_MARKER if status in CHALLENGE_STATUSES else Rule.BODY_MARKER
            return ChallengeVerdict(True, rule, marker)

        # Rule (c). The body must really be an HTML document: a robots.txt that
        # is plain text but mislabelled text/html is a server misconfiguration
        # (robots.classify_response calls it INVALID), not a reason to cut the host.
        if expect in (Expect.TEXT, Expect.XML, Expect.IMAGE) and status == 200:
            if _is_html_document(body, _media_type(headers)):
                if self._home_sha is not None and hashlib.sha256(body).hexdigest() == self._home_sha:
                    if self._home_genuine:
                        return ChallengeVerdict(False, soft_404=True)
                    return ChallengeVerdict(True, Rule.WRONG_TYPE, "the home page instead of " + expect.value, same_as_home=True)
                if self._home_genuine or len(body) >= SMALL_BODY_LIMIT:
                    # The home was genuine and this answer carries no marker: a small
                    # "not found" page served with 200 is a soft 404, whatever its size.
                    # Rule (b) still catches markerless
                    # challenges served for every URL.
                    return ChallengeVerdict(False, soft_404=True)
                return ChallengeVerdict(True, Rule.WRONG_TYPE, f"text/html instead of {expect.value}")
        return ChallengeVerdict(False)

    def register_body(self, url: str, status: int | None, body: bytes) -> list[str]:
        """Record a 200 body for rule (b).

        Returns the list of URLs (this one AND the earlier ones) that now share a
        small identical body with at least one other distinct URL, so the caller
        can mark every one of them as challenged. Same-URL repeats (EXT-20 loads
        1 to 3 of the home) never count as distinct. Returns [] otherwise.
        """
        if status != 200 or not body or len(body) >= SMALL_BODY_LIMIT:
            return []
        digest = hashlib.sha256(body).hexdigest()
        if self._home_genuine and digest == self._home_sha:
            return []  # a copy of a real home (index.php, /inicio/): not a challenge
        key = _distinct_key(url)
        self._spelling.setdefault(key, url)
        keys = self._by_hash.setdefault(digest, [])
        if key not in keys:
            keys.append(key)
        if len(keys) < 2:
            return []
        if self._home_keys and all(k in self._home_keys for k in keys):
            return []  # http and https, with and without www: the same home (EXT-17 judges that)
        return [self._spelling[k] for k in keys]


def body_has_marker(body: bytes) -> str | None:
    """Return the first BODY_MARKERS entry found in ``body`` (case-insensitive), or None.

    Decodes leniently (latin-1 is enough for ASCII markers) and inspects at most
    the first 64 KiB.
    """
    if not body:
        return None
    text = bytes(body[:MARKER_SCAN_BYTES]).decode("latin-1").lower()
    for original, lowered in _LOWER_MARKERS:
        if lowered in text:
            return original
    return None
