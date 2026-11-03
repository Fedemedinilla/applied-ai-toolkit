"""WordPress core version status via api.wordpress.org/core/stable-check/1.0/.

A public static JSON mapping version -> "latest" | "outdated" | "insecure"
(~960 entries, no dates). Fetched at most once per run, and only when the site
shows a WordPress version (after the site phase: it is not a site request).
Majors are keyed without ".0" ("6.0", not "6.0.0"). Only the entries relevant
to the run (the site's version, the "latest" one and the highest release of the
site's branch) go to wp-stable-check.json. The highest release of the branch is
read from the full list, so EXT-02 can tell "all the updates of 6.1" from "an
older 6.1".

The word "insecure" is data here; it never reaches client text:
checks turn it into a security count, never into a phrase.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from . import artifacts as art
from .requestlog import utc_now_iso
from .scope import Purpose, ScopeError

if TYPE_CHECKING:
    from .artifacts import ArtifactStore
    from .httpclient import HttpClient

TIMEOUT_SECONDS = 30.0
_VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
_STATUSES: frozenset[str] = frozenset({"latest", "outdated", "insecure"})


@dataclass
class WpVersionStatus:
    version: str  # normalized as looked up
    status: str | None  # "latest", "outdated", "insecure", or None (not in the list / error)
    latest: str | None  # the version marked "latest" in the same list
    fetched: bool  # the list was obtained in this run
    error: str | None = None
    # The highest release of the site's branch (major.minor) in the same list,
    # or None when the list was not obtained.
    branch_highest: str | None = None

    @property
    def highest_of_branch(self) -> bool | None:
        """True when ``version`` is the newest release of its branch, False when a newer one exists, None if unknown."""
        if self.branch_highest is None:
            return None
        try:
            return _version_key(self.version) >= _version_key(self.branch_highest)
        except ValueError:
            return None


def _version_key(version: str) -> tuple[int, int, int]:
    """'6.1' -> (6, 1, 0); '6.1.15' -> (6, 1, 15). ValueError if not dotted digits."""
    parts = [int(p) for p in normalize_version(version).split(".")]
    while len(parts) < 3:
        parts.append(0)
    return parts[0], parts[1], parts[2]


def branch_of(version: str) -> str:
    """'6.1.15' -> '6.1'; '6.1' -> '6.1'. ValueError if not dotted digits."""
    major, minor, _ = _version_key(version)
    return f"{major}.{minor}"


def highest_in_branch(table: dict[str, str], version: str) -> str | None:
    """The highest version of ``version``'s branch among the keys of the stable-check list, or None."""
    try:
        branch = _version_key(version)[:2]
    except ValueError:
        return None
    best: tuple[int, int, int] | None = None
    best_key: str | None = None
    for key in table:
        try:
            k = _version_key(key)
        except ValueError:
            continue
        if k[:2] == branch and (best is None or k > best):
            best, best_key = k, key
    return best_key


def normalize_version(version: str) -> str:
    """'6.0.0' -> '6.0'; '6.1.1' -> '6.1.1'; strips whitespace. ValueError if not dotted digits."""
    v = (version or "").strip()
    if not _VERSION_RE.match(v):
        raise ValueError("not a dotted version")
    parts = v.split(".")
    if len(parts) == 3 and parts[2] == "0":
        parts = parts[:2]
    return ".".join(parts)


# Bundled libraries under /wp-includes/ carry THEIR OWN version in ?ver=
# (jquery.min.js?ver=3.7.1, imagesloaded.min.js?ver=5.0.0...). Reading one of
# them as the WordPress version would put a false "hace 12 años" in the report, so
# they are never a source.
LIBRARY_ASSET_HINTS: tuple[str, ...] = (
    "jquery",
    "underscore",
    "backbone",
    "imagesloaded",
    "masonry",
    "hoverintent",
    "mediaelement",
    "regenerator",
    "polyfill",
    "react",
    "lodash",
    "moment",
    "clipboard",
    "thickbox",
    "swfobject",
    "plupload",
    "tinymce",
    "codemirror",
    "json2",
    "zxcvbn",
    "twemoji",
    "/vendor/",
)
_WP_INCLUDES_VER_RE = re.compile(r"/wp-includes/[^?#]*\?(?:[^#]*&)?ver=(\d+(?:\.\d+){1,2})(?:&|$)", re.IGNORECASE)


def core_version_from_assets(urls: list[str]) -> str | None:
    """The WordPress version shown by ?ver= on core /wp-includes/ assets, or None.

    Library assets (LIBRARY_ASSET_HINTS) are skipped. When the remaining assets
    disagree, the most frequent version wins (ties: the first seen).
    """
    counts: dict[str, int] = {}
    order: list[str] = []
    for url in urls:
        low = (url or "").lower()
        if "/wp-includes/" not in low:
            continue
        path = low.split("?", 1)[0]
        if any(hint in path for hint in LIBRARY_ASSET_HINTS):
            continue
        m = _WP_INCLUDES_VER_RE.search(url)
        if not m:
            continue
        v = m.group(1)
        if v not in counts:
            order.append(v)
        counts[v] = counts.get(v, 0) + 1
    if not order:
        return None
    return max(order, key=lambda v: (counts[v], -order.index(v)))


class WpStableCheckClient:
    def __init__(self, http: "HttpClient", endpoint: str, artifacts: "ArtifactStore") -> None:
        self._http = http
        self._endpoint = endpoint
        self._artifacts = artifacts
        self._table: dict[str, str] | None = None
        self._fetch_error: str | None = None
        self._fetched_at: str | None = None
        self._tried = False
        self._stored = False

    def _load(self) -> None:
        if self._tried:
            return
        self._tried = True
        self._fetched_at = utc_now_iso()
        try:
            resp = self._http.api_request("GET", self._endpoint, purpose=Purpose.WP, timeout=TIMEOUT_SECONDS)
        except ScopeError:
            raise
        except Exception as exc:
            self._fetch_error = type(exc).__name__
            return
        if resp.error or resp.status != 200:
            self._fetch_error = resp.error or f"http-{resp.status}"
            return
        try:
            obj: Any = json.loads(resp.text()[0])
        except ValueError:
            self._fetch_error = "not-json"
            return
        if not isinstance(obj, dict):
            self._fetch_error = "not-json"
            return
        self._table = {str(k): str(v) for k, v in obj.items() if isinstance(v, str)}

    def status_of(self, version: str) -> WpVersionStatus:
        """Fetch the list (once), look ``version`` up, store the relevant entries."""
        try:
            v = normalize_version(version)
        except ValueError:
            return WpVersionStatus(version=(version or "").strip(), status=None, latest=None, fetched=False, error="bad-version")
        self._load()
        if self._table is None:
            result = WpVersionStatus(version=v, status=None, latest=None, fetched=False, error=self._fetch_error)
        else:
            latest = next((k for k, s in self._table.items() if s == "latest"), None)
            status = self._table.get(v)
            result = WpVersionStatus(
                version=v,
                status=status if status in _STATUSES else None,
                latest=latest,
                fetched=True,
                error=None if status in _STATUSES else "not-in-list",
                branch_highest=highest_in_branch(self._table, v),
            )
        if not self._stored:
            self._stored = True
            entries = {}
            if self._table is not None:
                entries = {k: self._table[k] for k in {v, result.latest, result.branch_highest} if k and k in self._table}
            self._artifacts.put_json(
                art.WP_STABLE,
                {
                    "consultado_utc": self._fetched_at,
                    "version_sitio": v,
                    "entradas": entries,
                    "ultima": result.latest,
                    "mas_alta_de_la_rama": result.branch_highest,
                    "error": result.error,
                },
            )
        return result
