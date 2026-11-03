"""The SCOPE GUARD: the passive scope enforced in the network layer.

Every outgoing connection of the tool (HTTP requests and EACH redirect hop, the
TLS handshake, the DBL DNS lookup, every API call) asks this guard first. Anything
outside the scope raises ScopeError, the run aborts with exit code 50
(SCOPE_VIOLATION) and nothing is sent. The guard is the legal boundary of the
tool (Argentine Penal Code, art. 153 bis, added by Ley 26.388: accessing a
system without authorization is a crime), so it is deliberately strict: an
undeclared sitemap is "no se vio", never guessed.

What is allowed on the target (registrable domain D):

* the 4 scheme/host variants of the home, path "/" (EXT-17), and the redirect
  hops the site itself issues, within D, at most 5 per chain;
* the canonical home H (final URL of the input URL) and its reloads;
* ``/robots.txt`` on the canonical origin (public by convention);
* the sitemaps declared in robots.txt (on D), the first child of a declared
  sitemap index, and the three STANDARD_SITEMAP_PATHS only if robots.txt
  declares none (allow_standard_sitemaps);
* the RSS/Atom feed only if the home links it with <link rel=alternate>;
* pages the home links with <a href> on D (interna, --form-page,
  hreflang alternates, VIS-09 link checks): admitted with admit_linked;
* og:image, on ANY host, for that single URL and its redirect hops;
* one TLS handshake per site host (canonical host and the other apex/www host).

Never, even when linked: DENY_PATTERNS (readme.html, /wp-json, ?author=,
/author/, xmlrpc.php, wp-login.php, /wp-admin, sensitive files, favicon.ico
unless linked, a 404 probe). Methods: GET only on the site and the control;
POST only to the CrUX and Observatory APIs.

Outside the target: exactly the hosts of endpoints.Endpoints (APIs), the control
URL (path "/" only), rdap.org's redirect to the authoritative RDAP server
(``/domain/<D>`` only), and ``<D>.dbl.spamhaus.org.`` for the DNS lookup. The
DBL lookup also admits the Spamhaus test point ``test.dbl.spamhaus.org.``
(RFC 5782 section 5), the control of that measurement.

In test mode (loopback transport) the guard additionally refuses any host that is
not under ``.test`` or a loopback API base.

* D is the SITE domain (domains.site_domain): the input host without "www."
  when the site lives under someone else's domain, so a school under
  universidad-ejemplo.edu.ar or a blog under blogspot.com.ar never opens the scope to its
  siblings. A public or platform suffix is refused as a scope.
* Site requests use the default ports only (80/443), and og:image never goes
  to an IP literal or localhost, nor redirects there; the HTTP client
  also refuses names that resolve to non-public addresses.
* A redirect the SITE issues to a denied path (wp-login.php, /wp-admin...) is
  refused without raising: redirect_verdict says DENIED, the hop is never
  requested and the run goes on. ScopeError stays for the
  requests the tool itself builds, hop > MAX_HOPS and the test backstop.
* The deny list also covers /wp-admin?..., ?rest_route=, wp-sitemap-users-N.xml
  and author-sitemap.xml; refusal texts never carry control
  characters from the site.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit

from . import domains

if TYPE_CHECKING:
    from .endpoints import Endpoints


class ScopeError(Exception):
    """A connection outside the passive scope was attempted (a bug). Exit code 50."""


class Purpose(StrEnum):
    """Why a connection is made. Logged with every request; drives the guard."""

    HOME = "home"  # input URL and its redirect chain (home load 1)
    HOME_RELOAD = "home-reload"  # home loads 2 and 3 (EXT-20 / EXT-19)
    VARIANT = "variant"  # the EXT-17 variants and their hops
    CONTROL = "control"  # TTFB control (SITE_CHECK_CONTROL_DOMAIN)
    TLS = "tls"  # EXT-07 / EXT-18 handshake
    ROBOTS = "robots"
    SITEMAP = "sitemap"  # declared in robots.txt
    SITEMAP_STANDARD = "sitemap-standard"  # only when robots.txt declares none
    SITEMAP_CHILD = "sitemap-child"  # first child of a sitemap index
    FEED = "feed"
    INTERNA = "interna"
    FORM_PAGE = "form-page"  # --form-page
    OG_IMAGE = "og-image"
    HREFLANG = "hreflang"
    LINK_CHECK = "link-check"  # VIS-09
    PSI = "api-psi"
    CRUX = "api-crux"
    DOH = "api-doh"
    RDAP = "api-rdap"
    WP = "api-wp"
    OBSERVATORY = "api-observatory"
    DBL = "dns-dbl"
    TEST_SERVICE = "test-service"  # loopback fakes of the TLS and DBL probes


class RequestKind(StrEnum):
    """Accounting class returned by ScopeGuard.check."""

    SITE = "site"  # counts against the 90-request budget, paced, challenge-checked
    CONTROL = "control"  # paced, logged, not in the site budget
    EXTERNAL = "external"  # og:image on another host: paced, logged, not in budget
    API = "api"  # sequential, logged, never paced nor challenge-checked
    DNS = "dns"  # the DBL lookup
    TLS = "tls"  # handshake to a site host: counts in the site budget


STANDARD_SITEMAP_PATHS: tuple[str, ...] = ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml")

# Backstop deny list, matched (case-insensitive) against path + query of EVERY
# site URL and redirect hop, even when the site links them.
DENY_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"readme\.html",
        r"license\.txt",
        r"/wp-json(/|$|\?)",
        r"[?&]author=",
        r"/author/",
        r"xmlrpc\.php",
        r"wp-login\.php",
        r"/wp-admin(/|$|\?)",
        r"[?&]rest_route=",  # the query form of /wp-json (the EXT-03 user list)
        r"wp-sitemap-users-",  # WordPress core sitemap of user names
        r"author-sitemap\.xml",  # Yoast sitemap of user names
        r"wp-config",
        r"(^|/)\.env",
        r"(^|/)\.git(/|$)",
        r"debug\.log",
        r"\.(sql|zip|bak|old|7z|rar)(\?|$)",  # not .gz: sitemaps may be gzipped
        r"phpinfo\.php",
        r"(^|/)info\.php",
        r"/favicon\.ico",  # allowed only when the page links it (admit_linked)
    )
)

MAX_HOPS = 5

FAVICON_PATTERN = r"/favicon\.ico"
DBL_ZONE = "dbl.spamhaus.org"
DBL_CONTROL_NAME = "test.dbl.spamhaus.org"  # RFC 5782 test point, always listed (127.0.1.2)
TEST_SUFFIX = ".test"
LOOPBACK_HOSTS: frozenset[str] = frozenset({"127.0.0.1", "::1", "localhost"})

# Purposes whose URLs are pages the home links (admit_linked).
LINKED_PURPOSES: frozenset[Purpose] = frozenset({Purpose.INTERNA, Purpose.FORM_PAGE, Purpose.HREFLANG, Purpose.LINK_CHECK})
API_PURPOSES: frozenset[Purpose] = frozenset(
    {Purpose.PSI, Purpose.CRUX, Purpose.DOH, Purpose.RDAP, Purpose.WP, Purpose.OBSERVATORY, Purpose.TEST_SERVICE}
)
# Purposes that address the target site (GET only, deny patterns, on D).
SITE_PURPOSES: frozenset[Purpose] = frozenset(
    {
        Purpose.HOME,
        Purpose.HOME_RELOAD,
        Purpose.VARIANT,
        Purpose.ROBOTS,
        Purpose.SITEMAP,
        Purpose.SITEMAP_STANDARD,
        Purpose.SITEMAP_CHILD,
        Purpose.FEED,
        Purpose.INTERNA,
        Purpose.FORM_PAGE,
        Purpose.HREFLANG,
        Purpose.LINK_CHECK,
        Purpose.OG_IMAGE,
    }
)

_EMAIL_RE = re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}")  # lookbehind: linear
_LONG_DIGITS_RE = re.compile(r"\d{9,}")
# C0 and C1 control characters and DEL (terminal escape sequences come from the
# site through a Location header or a link) plus the Unicode format
# characters (bidi overrides, zero-width).
_CONTROL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]")

# Ports a site request may use: the defaults of http and https only.
SITE_PORTS: frozenset[int] = frozenset({80, 443})


def strip_controls(text: str) -> str:
    """``text`` without control or format characters (each one becomes "?")."""
    return _CONTROL_RE.sub("?", text)


def _audit_url(url: str) -> str:
    """A URL as written to datos.json or a message: e-mails, phone-like numbers and control characters masked."""
    return _LONG_DIGITS_RE.sub("[numero]", _EMAIL_RE.sub("[correo]", strip_controls(str(url))))


class RedirectVerdict(StrEnum):
    """What to do with one redirect hop (check_redirect is ``verdict is FOLLOW``)."""

    FOLLOW = "follow"
    LEAVE = "leave"  # outside the allowed hosts: the chain ends here (left_site)
    DENIED = "denied"  # the SITE pointed to a denied path (wp-login, /wp-admin...): never requested


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


@dataclass
class Admission:
    """Why a URL is allowed; listed in datos.json meta.scope for auditability."""

    url: str
    purpose: Purpose
    source: str  # "variant", "robots.txt", "home <a href>", "home <link rel=alternate>", ...


@dataclass
class _Target:
    """A parsed absolute URL, normalized for the guard's comparisons."""

    url: str
    scheme: str
    host: str
    port: int
    path: str
    query: str

    @property
    def path_and_query(self) -> str:
        return self.path + ("?" + self.query if self.query else "")

    @property
    def origin(self) -> tuple[str, str, int]:
        return (self.scheme, self.host, self.port)


def _parse(url: str) -> _Target:
    """Parse an absolute http(s) URL or raise ScopeError."""
    if not isinstance(url, str):
        raise ScopeError("scope: URL is not a string")
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not parts.hostname:
        raise ScopeError(f"scope: not an absolute http(s) URL: {_audit_url(url)}")
    try:
        host = domains.normalize_host(parts.hostname)
        port = parts.port or domains.DEFAULT_PORTS[scheme]
    except ValueError as exc:
        raise ScopeError(f"scope: invalid host or port in {_audit_url(url)}") from exc
    return _Target(url=url, scheme=scheme, host=host, port=port, path=parts.path or "/", query=parts.query)


def _try_parse(url: str) -> _Target | None:
    try:
        return _parse(url)
    except ScopeError:
        return None


@dataclass
class ScopeGuard:
    """Allow-list of the run. Grows only through the admit_* methods.

    Construct with the registrable domain D, the input URL and the Endpoints.
    ``test_loopback`` restricts site hosts to ``.test`` names; ``observatory``
    admits the Observatory API only when --observatory was given.
    """

    registrable: str
    input_url: str
    endpoints: "Endpoints"
    test_loopback: bool = False
    observatory: bool = False
    admissions: list[Admission] = field(default_factory=list)
    refusals: list[dict[str, str]] = field(default_factory=list)  # {"url", "purpose", "reason"}

    def __post_init__(self) -> None:
        self.registrable = domains.normalize_host(self.registrable)
        if self.registrable in domains.PUBLIC_SUFFIXES or self.registrable in domains.PLATFORM_SUFFIXES:
            # A scope on blogspot.com.ar would admit every other blog of the platform.
            raise ValueError(f"the scope cannot be a public suffix: {self.registrable}")
        self._canonical: _Target | None = None
        self._linked: dict[Purpose, set[str]] = {p: set() for p in LINKED_PURPOSES}
        self._declared_sitemaps: set[str] = set()
        self._standard_sitemaps = False
        self._sitemap_child: str | None = None
        self._feed: str | None = None
        self._og_image: str | None = None
        self._og_image_host: str | None = None
        self._variant_keys = {domains.compare_key(v) for v in domains.site_variants(self.registrable)}
        self._input_key = domains.compare_key(self.input_url)

    # ------------------------------------------------------------------ helpers
    def _refuse(self, url: str, purpose: Purpose | str, reason: str) -> ScopeError:
        self.refusals.append({"url": _audit_url(str(url)), "purpose": str(purpose), "reason": reason})
        return ScopeError(f"scope: {reason}: {str(purpose)} {_audit_url(str(url))}")

    def _admit(self, url: str, purpose: Purpose, source: str) -> None:
        self.admissions.append(Admission(url=url, purpose=purpose, source=source))

    def _on_site(self, host: str) -> bool:
        d = self.registrable
        return host == d or host.endswith("." + d)

    def _isolation_ok(self, t: _Target) -> bool:
        """Test mode: only .test hosts (routed to the fake site) and loopback API bases."""
        if not self.test_loopback:
            return True
        return t.host.endswith(TEST_SUFFIX) or t.host in LOOPBACK_HOSTS

    def _deny(self, t: _Target) -> str | None:
        return matches_deny_pattern(t.path_and_query)

    @staticmethod
    def _port_ok(t: _Target) -> bool:
        """Site requests use the default ports only: never a port the page chose."""
        return t.port in SITE_PORTS

    def _note(self, url: str, purpose: Purpose | str, reason: str) -> None:
        self.refusals.append({"url": _audit_url(str(url)), "purpose": str(purpose), "reason": reason})

    def _canonical_origin(self, t: _Target) -> bool:
        return self._canonical is not None and t.origin == self._canonical.origin

    def _endpoint_match(self, t: _Target, endpoint: str | None, *, exact_path: bool) -> bool:
        if not endpoint:
            return False
        e = _try_parse(endpoint)
        if e is None or e.origin != t.origin:
            return False
        if exact_path:
            return t.path == e.path
        return t.path.startswith(e.path)

    def _rdap_paths(self) -> set[str]:
        out = set()
        for base in (self.endpoints.rdap_bootstrap, self.endpoints.rdap_ar):
            e = _try_parse(base)
            if e is not None:
                out.add((e.origin, (e.path + self.registrable).lower()))
        return out

    # ------------------------------------------------------------------ admissions
    def set_canonical(self, final_url: str) -> None:
        """Record H, the final URL of the input chain. Must be on D, else ScopeError."""
        t = _parse(final_url)
        if not self._on_site(t.host):
            raise self._refuse(final_url, Purpose.HOME, "canonical URL outside the registrable domain")
        if not self._isolation_ok(t):
            raise self._refuse(final_url, Purpose.HOME, "test isolation")
        self._canonical = t
        self._admit(final_url, Purpose.HOME, "final URL of the input chain")

    @property
    def canonical_url(self) -> str | None:
        """H once set_canonical was called."""
        return self._canonical.url if self._canonical else None

    def admit_linked(self, urls: Iterable[str], *, purpose: Purpose, source: str) -> list[str]:
        """Admit URLs that a fetched page links, for ``purpose``.

        Keeps only http(s) URLs on D that do not match DENY_PATTERNS (except
        /favicon.ico when linked). Returns the admitted URLs, in input order,
        deduplicated by domains.compare_key. Never raises for a refused URL: it
        simply is not admitted (and is listed with the reason in describe).
        """
        purpose = Purpose(purpose)
        if purpose not in LINKED_PURPOSES:
            raise ValueError(f"admit_linked does not take purpose {purpose}")
        admitted: list[str] = []
        seen: set[str] = set()
        for url in urls:
            t = _try_parse(url)
            if t is None:
                self.refusals.append({"url": _audit_url(str(url)), "purpose": str(purpose), "reason": "not http(s)"})
                continue
            key = domains.compare_key(url)
            if key in seen:
                continue
            seen.add(key)
            if not self._on_site(t.host):
                self.refusals.append({"url": _audit_url(url), "purpose": str(purpose), "reason": "off-site"})
                continue
            if not self._isolation_ok(t):
                self.refusals.append({"url": _audit_url(url), "purpose": str(purpose), "reason": "test isolation"})
                continue
            if not self._port_ok(t):
                self._note(url, purpose, f"port {t.port}")
                continue
            deny = self._deny(t)
            if deny is not None and deny != FAVICON_PATTERN:
                self.refusals.append({"url": _audit_url(url), "purpose": str(purpose), "reason": f"deny-pattern {deny}"})
                continue
            self._linked[purpose].add(key)
            self._admit(url, purpose, source)
            admitted.append(url)
        return admitted

    def admit_declared_sitemaps(self, urls: Iterable[str]) -> list[str]:
        """Admit the ``Sitemap:`` URLs of robots.txt that are on D."""
        admitted: list[str] = []
        for url in urls:
            t = _try_parse(url)
            if t is None or not self._on_site(t.host):
                self.refusals.append({"url": _audit_url(str(url)), "purpose": str(Purpose.SITEMAP), "reason": "off-site"})
                continue
            if not self._isolation_ok(t):
                self.refusals.append({"url": _audit_url(url), "purpose": str(Purpose.SITEMAP), "reason": "test isolation"})
                continue
            if not self._port_ok(t):
                self._note(url, Purpose.SITEMAP, f"port {t.port}")
                continue
            deny = self._deny(t)
            if deny is not None:
                self.refusals.append({"url": _audit_url(url), "purpose": str(Purpose.SITEMAP), "reason": f"deny-pattern {deny}"})
                continue
            key = domains.compare_key(url)
            if key in self._declared_sitemaps:
                continue
            self._declared_sitemaps.add(key)
            self._admit(url, Purpose.SITEMAP, "robots.txt Sitemap:")
            admitted.append(url)
        return admitted

    def allow_standard_sitemaps(self) -> None:
        """Admit STANDARD_SITEMAP_PATHS on the canonical origin.

        Only legal after robots.txt was fetched, was valid and declared no
        sitemap; the collector is responsible for calling it only then.
        """
        if self._canonical is None:
            raise ScopeError("scope: standard sitemaps need the canonical origin first")
        self._standard_sitemaps = True
        origin = f"{self._canonical.scheme}://{urlsplit(self._canonical.url).netloc}"
        for path in STANDARD_SITEMAP_PATHS:
            self._admit(origin + path, Purpose.SITEMAP_STANDARD, "robots.txt without Sitemap:")

    def admit_sitemap_child(self, url: str) -> bool:
        """Admit the FIRST child of an admitted sitemap index (one per run). True if admitted."""
        if self._sitemap_child is not None:
            self.refusals.append({"url": _audit_url(url), "purpose": str(Purpose.SITEMAP_CHILD), "reason": "only the first child"})
            return False
        if not self._declared_sitemaps and not self._standard_sitemaps:
            self.refusals.append({"url": _audit_url(url), "purpose": str(Purpose.SITEMAP_CHILD), "reason": "no sitemap admitted"})
            return False
        t = _try_parse(url)
        if t is None or not self._on_site(t.host) or not self._isolation_ok(t) or not self._port_ok(t) or self._deny(t) is not None:
            self.refusals.append({"url": _audit_url(str(url)), "purpose": str(Purpose.SITEMAP_CHILD), "reason": "off-site or denied"})
            return False
        self._sitemap_child = domains.compare_key(url)
        self._admit(url, Purpose.SITEMAP_CHILD, "first <loc> of the sitemap index")
        return True

    def admit_feed(self, url: str) -> bool:
        """Admit the feed linked from the home with <link rel=alternate> (on D, one per run)."""
        if self._feed is not None:
            self.refusals.append({"url": _audit_url(url), "purpose": str(Purpose.FEED), "reason": "one feed per run"})
            return False
        t = _try_parse(url)
        if t is None or not self._on_site(t.host) or not self._isolation_ok(t) or not self._port_ok(t) or self._deny(t) is not None:
            self.refusals.append({"url": _audit_url(str(url)), "purpose": str(Purpose.FEED), "reason": "off-site or denied"})
            return False
        self._feed = domains.compare_key(url)
        self._admit(url, Purpose.FEED, "home <link rel=alternate>")
        return True

    def admit_og_image(self, url: str) -> bool:
        """Admit the og:image URL on any host NAME (one per run).

        Refused: an IP literal and any port other than 80/443.
        The page decides this URL, so it must never aim the tool at an address
        of the operator's network; the HTTP client also refuses a NAME that resolves
        to a non-public address (httpclient.public_address).
        """
        if self._og_image is not None:
            self.refusals.append({"url": _audit_url(url), "purpose": str(Purpose.OG_IMAGE), "reason": "one og:image per run"})
            return False
        t = _try_parse(url)
        if t is None:
            self.refusals.append({"url": _audit_url(str(url)), "purpose": str(Purpose.OG_IMAGE), "reason": "not http(s)"})
            return False
        if _is_ip_literal(t.host) or t.host == "localhost":
            self._note(url, Purpose.OG_IMAGE, "IP address or localhost")
            return False
        if not self._port_ok(t):
            self._note(url, Purpose.OG_IMAGE, f"port {t.port}")
            return False
        if self._on_site(t.host) and self._deny(t) is not None:
            self.refusals.append({"url": _audit_url(url), "purpose": str(Purpose.OG_IMAGE), "reason": "deny-pattern"})
            return False
        self._og_image = domains.compare_key(url)
        self._og_image_host = t.host
        self._admit(url, Purpose.OG_IMAGE, "home <meta property=og:image>")
        return True

    # ------------------------------------------------------------------ checks
    def check(self, method: str, url: str, purpose: Purpose) -> RequestKind:
        """Authorize one request before it is sent; return its RequestKind.

        Raises ScopeError when the method, host, path or purpose is not allowed.
        The message names the URL with secrets removed (the caller passes a URL
        that never contains the key anyway).
        """
        method = (method or "").upper()
        try:
            purpose = Purpose(purpose)
        except ValueError as exc:
            raise self._refuse(url, str(purpose), "unknown purpose") from exc
        t = _try_parse(url)
        if t is None:
            raise self._refuse(url, purpose, "not an absolute http(s) URL")
        if not self._isolation_ok(t):
            raise self._refuse(url, purpose, "test isolation")

        if purpose in API_PURPOSES:
            return self._check_api(method, t, purpose)
        if purpose is Purpose.CONTROL:
            if method != "GET":
                raise self._refuse(url, purpose, f"method {method} not allowed")
            control = _try_parse(self.endpoints.control_url)
            if control is None or t.origin != control.origin or t.path != "/" or t.query:
                raise self._refuse(url, purpose, "control URL allows path / only")
            return RequestKind.CONTROL
        if purpose not in SITE_PURPOSES:
            raise self._refuse(url, purpose, "purpose not allowed for HTTP")
        if method != "GET":
            raise self._refuse(url, purpose, f"method {method} not allowed on the site")

        key = domains.compare_key(url)
        if not self._port_ok(t):
            raise self._refuse(url, purpose, f"port {t.port} not allowed on the site")
        if purpose is Purpose.OG_IMAGE:
            if self._og_image is None or key != self._og_image:
                raise self._refuse(url, purpose, "og:image not admitted")
            if _is_ip_literal(t.host) or t.host == "localhost":
                raise self._refuse(url, purpose, "og:image on an IP address")
            if self._on_site(t.host):
                if self._deny(t) is not None:
                    raise self._refuse(url, purpose, "deny-pattern")
                return RequestKind.SITE
            return RequestKind.EXTERNAL

        if not self._on_site(t.host):
            raise self._refuse(url, purpose, "outside the registrable domain")
        deny = self._deny(t)
        if deny is not None:
            linked_favicon = deny == FAVICON_PATTERN and purpose in LINKED_PURPOSES and key in self._linked[purpose]
            if not linked_favicon:
                raise self._refuse(url, purpose, f"deny-pattern {deny}")

        if purpose is Purpose.HOME:
            if key == self._input_key or (self._canonical is not None and key == domains.compare_key(self._canonical.url)):
                return RequestKind.SITE
            raise self._refuse(url, purpose, "not the input URL")
        if purpose is Purpose.HOME_RELOAD:
            if self._canonical is not None and key == domains.compare_key(self._canonical.url):
                return RequestKind.SITE
            raise self._refuse(url, purpose, "not the canonical home")
        if purpose is Purpose.VARIANT:
            if key in self._variant_keys or (self._canonical is not None and key == domains.compare_key(self._canonical.url)):
                return RequestKind.SITE
            raise self._refuse(url, purpose, "not one of the four variants")
        if purpose is Purpose.ROBOTS:
            if self._canonical_origin(t) and t.path == "/robots.txt" and not t.query:
                return RequestKind.SITE
            raise self._refuse(url, purpose, "robots.txt only on the canonical origin")
        if purpose is Purpose.SITEMAP:
            if key in self._declared_sitemaps:
                return RequestKind.SITE
            raise self._refuse(url, purpose, "sitemap not declared in robots.txt")
        if purpose is Purpose.SITEMAP_STANDARD:
            if self._standard_sitemaps and self._canonical_origin(t) and t.path in STANDARD_SITEMAP_PATHS and not t.query:
                return RequestKind.SITE
            raise self._refuse(url, purpose, "standard sitemap paths not allowed")
        if purpose is Purpose.SITEMAP_CHILD:
            if self._sitemap_child is not None and key == self._sitemap_child:
                return RequestKind.SITE
            raise self._refuse(url, purpose, "not the first child of the sitemap index")
        if purpose is Purpose.FEED:
            if self._feed is not None and key == self._feed:
                return RequestKind.SITE
            raise self._refuse(url, purpose, "feed not linked from the home")
        if purpose in LINKED_PURPOSES:
            if key in self._linked[purpose]:
                return RequestKind.SITE
            raise self._refuse(url, purpose, "not linked from the home")
        raise self._refuse(url, purpose, "purpose not allowed")

    def _check_api(self, method: str, t: _Target, purpose: Purpose) -> RequestKind:
        e = self.endpoints
        url = t.url
        if purpose is Purpose.PSI:
            ok = method == "GET" and self._endpoint_match(t, e.psi, exact_path=True)
        elif purpose is Purpose.CRUX:
            ok = method == "POST" and self._endpoint_match(t, e.crux, exact_path=True) and not t.query
        elif purpose is Purpose.DOH:
            ok = method == "GET" and (
                self._endpoint_match(t, e.doh_google, exact_path=True) or self._endpoint_match(t, e.doh_cloudflare, exact_path=True)
            )
        elif purpose is Purpose.RDAP:
            ok = method == "GET" and (t.origin, t.path.lower()) in self._rdap_paths() and not t.query
        elif purpose is Purpose.WP:
            ok = method == "GET" and self._endpoint_match(t, e.wp_stable_check, exact_path=True) and not t.query
        elif purpose is Purpose.OBSERVATORY:
            if not self.observatory:
                raise self._refuse(url, purpose, "Observatory is off unless --observatory is given")
            ok = method == "POST" and self._endpoint_match(t, e.observatory, exact_path=True)
        elif purpose is Purpose.TEST_SERVICE:
            ok = method == "GET" and (
                self._endpoint_match(t, e.test_tls, exact_path=True) or self._endpoint_match(t, e.test_dbl, exact_path=True)
            )
        else:  # pragma: no cover - API_PURPOSES is exhaustive
            ok = False
        if not ok:
            raise self._refuse(url, purpose, f"not an allowed {purpose} endpoint or method {method}")
        return RequestKind.API

    def check_redirect(self, from_url: str, to_url: str, purpose: Purpose, hop: int) -> bool:
        """Decide whether to follow one redirect hop: ``redirect_verdict(...) is FOLLOW``.

        True: follow (same site for site purposes; any public host name for
        OG_IMAGE; the authoritative RDAP server for RDAP). False: do not follow,
        the chain ends here (the reason is in redirect_verdict and describe).
        """
        return self.redirect_verdict(from_url, to_url, purpose, hop) is RedirectVerdict.FOLLOW

    def redirect_verdict(self, from_url: str, to_url: str, purpose: Purpose, hop: int) -> RedirectVerdict:
        """FOLLOW, LEAVE (outside the allowed hosts) or DENIED (a denied path) for one hop.

        The hop is issued by the SITE, not by the tool: a Location that points to
        wp-login.php, /wp-admin or another deny pattern is refused (never
        requested, listed in describe) but it is not a bug of the tool, so it
        never raises. ScopeError is kept for
        hop > MAX_HOPS and the test-isolation backstop.
        """
        purpose = Purpose(purpose)
        if hop > MAX_HOPS:
            raise self._refuse(to_url, purpose, f"more than {MAX_HOPS} redirect hops")
        t = _try_parse(to_url)
        if t is None:
            return RedirectVerdict.LEAVE

        if purpose is Purpose.RDAP:
            # rdap.org answers 302 to the authoritative server: same /domain/<D> only.
            if t.query or not t.path.lower().endswith("/domain/" + self.registrable):
                return RedirectVerdict.LEAVE
            if self.test_loopback and t.host not in LOOPBACK_HOSTS:
                raise self._refuse(to_url, purpose, "test isolation")
            if not self.test_loopback and t.scheme != "https":
                return RedirectVerdict.LEAVE
            self._admit(to_url, purpose, "rdap.org redirect")
            return RedirectVerdict.FOLLOW
        if purpose in API_PURPOSES or purpose is Purpose.CONTROL:
            return RedirectVerdict.LEAVE  # APIs and the control are never followed elsewhere

        if purpose is Purpose.OG_IMAGE:
            if _is_ip_literal(t.host) or t.host == "localhost" or not self._port_ok(t):
                self._note(to_url, purpose, "og:image hop to an IP address or a non-default port")
                return RedirectVerdict.LEAVE
            if not self._isolation_ok(t):
                raise self._refuse(to_url, purpose, "test isolation")
            if self._on_site(t.host) and self._deny(t) is not None:
                self._note(to_url, purpose, "deny-pattern on an og:image hop")
                return RedirectVerdict.DENIED
            return RedirectVerdict.FOLLOW

        if not self._on_site(t.host):
            return RedirectVerdict.LEAVE
        deny = self._deny(t)
        if deny is not None:
            self._note(to_url, purpose, f"redirect to deny-pattern {deny} (not requested)")
            return RedirectVerdict.DENIED
        if not self._port_ok(t):
            self._note(to_url, purpose, f"redirect to port {t.port}")
            return RedirectVerdict.LEAVE
        if not self._isolation_ok(t):
            raise self._refuse(to_url, purpose, "test isolation")
        return RedirectVerdict.FOLLOW

    def check_tls(self, host: str, port: int = 443) -> RequestKind:
        """Authorize a TLS handshake: only the canonical host and the other apex/www host of D."""
        try:
            h = domains.normalize_host(host)
        except ValueError as exc:
            raise self._refuse(f"tls://{host}:{port}", Purpose.TLS, "invalid host") from exc
        allowed = {self.registrable, "www." + self.registrable}
        if self._canonical is not None:
            allowed.add(self._canonical.host)
        if port != 443 or h not in allowed:
            raise self._refuse(f"tls://{h}:{port}", Purpose.TLS, "TLS only to the canonical and apex/www hosts on 443")
        if self.test_loopback and not h.endswith(TEST_SUFFIX):
            raise self._refuse(f"tls://{h}:{port}", Purpose.TLS, "test isolation")
        return RequestKind.TLS

    def check_dns(self, name: str) -> RequestKind:
        """Authorize a system-resolver lookup: only ``<D>.dbl.spamhaus.org.``.

        The Spamhaus test point ``test.dbl.spamhaus.org.`` is also admitted: it is
        the control of the lookup (a resolver that does not list it is not trusted).
        """
        n = (name or "").strip().rstrip(".").lower()
        if n in (f"{self.registrable}.{DBL_ZONE}", DBL_CONTROL_NAME):
            return RequestKind.DNS
        raise self._refuse(f"dns:{name}", Purpose.DBL, "only the DBL name of the registrable domain")

    def is_site_url(self, url: str) -> bool:
        """True when ``url`` is on D (apex, www or any subdomain)."""
        t = _try_parse(url)
        return t is not None and self._on_site(t.host)

    def describe(self) -> dict:
        """JSON-ready summary for datos.json meta.scope: admissions and refusals with reasons."""
        return {
            "dominio": self.registrable,
            "url_entrada": _audit_url(self.input_url),
            "url_canonica": _audit_url(self._canonical.url) if self._canonical else None,
            "sitemaps_estandar": self._standard_sitemaps,
            "observatory": self.observatory,
            "admitidas": [
                {"url": _audit_url(a.url), "proposito": str(a.purpose), "origen": a.source} for a in self.admissions
            ],
            "rechazadas": [
                {"url": r["url"], "proposito": r["purpose"], "motivo": r["reason"]} for r in self.refusals
            ],
        }


def matches_deny_pattern(path_and_query: str) -> str | None:
    """Return the first DENY_PATTERNS pattern string that matches, or None."""
    candidates = [path_and_query]
    decoded = unquote(path_and_query)
    if decoded != path_and_query:
        candidates.append(decoded)
    for pattern in DENY_PATTERNS:
        if any(pattern.search(c) for c in candidates):
            return pattern.pattern
    return None
