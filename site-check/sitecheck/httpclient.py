"""The HTTP client: one request at a time, paced, budgeted, scope-checked, logged.

Built on http.client (not urllib) so that every redirect hop is followed BY HAND
(each hop goes through ScopeGuard.check_redirect), timing is measured per hop, and
nothing is decompressed or followed behind our back. Rules:

* One request at a time, no threads. Between two SITE/CONTROL/EXTERNAL requests
  the client sleeps ``pace_seconds`` (3 s) plus a uniform jitter in
  [0, pace_jitter] (1 s). Jitter changes timing only, never outputs.
* SITE budget: at most ``site_budget`` (90) SITE+TLS requests per run. When spent,
  further site requests are not sent; they return a Response whose ``skipped``
  is "budget" and are logged as skipped-budget.
* One fixed honest User-Agent for everything, never
  changed after a block; Accept-Language es-AR; Accept-Encoding gzip and deflate,
  plus zstd when the interpreter can decode it (Python 3.14+); never br. No
  cookies sent or kept.
* TLS always verified with ssl.create_default_context; a verification error is
  a finding (EXT-07), never a reason to disable verification.
* Timeouts: connect 10 s, read 20 s (APIs pass their own, PSI 120 s). Bodies
  capped (5 MiB HTML/XML, 256 KiB images); a capped body is ``truncated``.
* Anti-bot: on a challenged SITE response, sleep
  ``challenge_wait`` (60 s), set the pause to ``challenge_pace`` (6 s), retry that
  URL once. A second challenge cuts the host: ``blocked`` becomes True, no more
  site requests in this run (they return skipped "blocked").
* The API key never enters a URL: api_request refuses (ValueError) a URL whose
  query contains ``key=`` or the key itself; the key travels only in the
  ``X-goog-api-key`` header passed by the PSI/CrUX clients.

TTFB (EXT-20) = time.perf_counter from before connect (DNS + TCP + TLS
included) until getresponse returns the status line and headers. Every request
uses a fresh connection (``Connection: close``).

Hardening:

* Total deadline per request: besides the per-read timeout, every read
  of the status line, headers and body checks one deadline (``total_deadline``,
  60 s for the site; longer for the APIs that pass a longer timeout). A server
  that drips one byte at a time ends with error "timeout".
* Address pinning: every SITE, CONTROL and EXTERNAL request
  resolves the host first and connects only to a PUBLIC address (never
  loopback, RFC 1918, 100.64/10, link-local, ULA, multicast or reserved), and
  then talks to THAT address (SNI and Host keep the name), so a DNS answer that
  changes between the check and the connection cannot reach the operator's network.
  A name without a public address ends with error "blocked-address".
* Redirects the SITE points to a denied path (wp-login.php...) are never
  requested and never raise: ``denied_redirect`` is set and the hop is
  logged as refused-scope. ``refused_next_url`` keeps where a chain that was
  not followed pointed (left_site or denied).
* A Location header with raw UTF-8 bytes is read as UTF-8, like browsers do; a body without a declared charset that is not valid UTF-8 is read as
  windows-1252; bytes after the last gzip member are ignored.
* THROTTLE: a 429, a 503 with Retry-After, a second 503 on a distinct
  URL, or a 403 with Retry-After or on a URL that answered 2xx earlier is a request
  to slow down. The client waits Retry-After once (at most
  ``throttle_wait_cap``, 120 s; 60 s when absent), retries that URL once with the
  slower pause, and cuts the host on the next signal. ``cut_cause`` says
  whether the cut came from a challenge or a throttle.
* ``relax_strict_tls(host)``: after the TLS probe proved that a browser
  accepts the certificate and only VERIFY_X509_STRICT rejects it, requests to
  that host use a context without that flag. Verification is never disabled.

Requests are never repeated:

* The same request is never sent twice in a run. Every SITE or EXTERNAL
  GET that got a response is kept per EXACT request (scheme, host, port, path
  and query as sent: ``/a`` and ``/a/`` differ). A later chain that reaches the
  same request, as its start or as a redirect hop, reuses that response: no
  pause, no budget, no new line in requests.log, and ``Response.reused`` when
  the final response came from there. The repeats the collection plan asks for are
  still sent: the home reloads (HOME_RELOAD, for EXT-19 and EXT-20), the
  control site (CONTROL, never kept) and the single retry after a challenge or
  a throttle. A kept response without its body never answers a request that
  needs the body.
* When a second 503 confirms a throttle, the first one is flagged too
  (``flagged-retroactively``), so it never counts as an error of the site.
* A body shorter than its Content-Length (connection closed early) is
  ``truncated`` and ``short_body``; without Transfer-Encoding only.

Test transport: with a LoopbackRoute, connections to hosts ending in
``suffix`` (".test") go to ``host:port`` over plain HTTP, sending the original
``Host`` header plus ``X-Site-Check-Test-Scheme: http|https`` so the fake site knows
which variant was asked. Any other non-loopback destination raises ScopeError
("test isolation"): a test can never reach a real site.
"""

from __future__ import annotations

import codecs
import datetime as dt
import email.utils
import hashlib
import http.client
import io
import ipaddress
import random
import re
import socket
import ssl
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from urllib.parse import parse_qsl, quote, urlsplit

from . import domains
from .challenge import DUPLICATE_MARKER, ChallengeEvent, Expect, Rule
from .requestlog import Outcome, RequestRecord, utc_now_iso
from .scope import Purpose, RedirectVerdict, RequestKind, ScopeError

try:  # Python 3.14+: Zstandard in the standard library
    from compression import zstd as _zstd
except ImportError:  # Python 3.11 to 3.13: zstd is simply not offered
    _zstd = None

if TYPE_CHECKING:
    from .challenge import ChallengeDetector
    from .credentials import Redactor
    from .requestlog import RequestLog
    from .scope import ScopeGuard

# The tool says who it is: a site owner who sees it in the logs can find what it
# does and that it only reads public pages.
USER_AGENT = "Mozilla/5.0 (compatible; site-check/1.0; +https://github.com/Fedemedinilla/applied-ai-toolkit)"
ACCEPT_LANGUAGE = "es-AR,es;q=0.9"
# Only what this interpreter can decode is offered: zstd needs Python 3.14.
ACCEPT_ENCODING = "gzip, deflate, zstd" if _zstd is not None else "gzip, deflate"
TEST_SCHEME_HEADER = "X-Site-Check-Test-Scheme"

MIB = 1024 * 1024
MAX_HTML_BYTES = 5 * MIB
MAX_IMAGE_BYTES = 256 * 1024
MAX_API_BYTES = 20 * MIB

REDIRECT_STATUSES: frozenset[int] = frozenset({301, 302, 303, 307, 308})
PINNED_KINDS: frozenset[RequestKind] = frozenset({RequestKind.SITE, RequestKind.CONTROL, RequestKind.EXTERNAL})
PACED_KINDS: frozenset[RequestKind] = frozenset({RequestKind.SITE, RequestKind.CONTROL, RequestKind.EXTERNAL, RequestKind.TLS})
API_KEY_HEADER = "x-goog-api-key"
ACCEPT_HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
LOOPBACK_HOSTS: frozenset[str] = frozenset({"127.0.0.1", "::1", "localhost"})

_REPLACEMENT_CHAR = chr(0xFFFD)
_UTF8_BOM = b"\xef\xbb\xbf"
_CHARSET_RE = re.compile(r"""charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)""", re.IGNORECASE)
_META_CHARSET_RE = re.compile(r"""<meta[^>]+?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)""", re.IGNORECASE)
# WHATWG Encoding: these labels decode as windows-1252 in every browser.
_WINDOWS_1252_LABELS: frozenset[str] = frozenset({"iso-8859-1", "iso8859-1", "latin1", "latin-1", "us-ascii", "ascii", "l1"})
# Characters kept as-is when a path or query is put on the request line.
_PATH_SAFE = "/%:@!$&'()*+,;=-._~"
_QUERY_SAFE = "/?%:@!$&'()*+,;=-._~[]"

_DECODE_ERRORS: tuple[type[BaseException], ...] = (zlib.error, EOFError, ValueError) + (
    (_zstd.ZstdError,) if _zstd is not None else ()
)


@dataclass(frozen=True)
class LoopbackRoute:
    """Test-only transport: route ``*.test`` hosts to a local fake server."""

    host: str = "127.0.0.1"
    port: int = 0
    suffix: str = ".test"
    unresolvable: frozenset[str] = frozenset()  # hosts that must fail as "no resuelve"


@dataclass(frozen=True)
class ClientConfig:
    """Tunables. Production defaults; tests set the waits to 0 or inject a sleeper."""

    pace_seconds: float = 3.0
    pace_jitter: float = 1.0
    challenge_wait: float = 60.0
    challenge_pace: float = 6.0
    site_budget: int = 90
    connect_timeout: float = 10.0
    read_timeout: float = 20.0
    max_hops: int = 5
    user_agent: str = USER_AGENT
    loopback: LoopbackRoute | None = None
    total_deadline: float = 60.0  # whole request (status line, headers and body)
    throttle_wait_cap: float = 120.0  # longest Retry-After honoured


@dataclass
class RedirectHop:
    """One response that redirected (3xx with Location)."""

    url: str
    status: int
    location: str | None  # raw Location header
    next_url: str | None  # resolved absolute URL, None when not followed
    ttfb_ms: float | None
    headers: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Response:
    """What the client got for one logical request (after following redirects by hand).

    ``status`` is the status of the LAST response actually received (None when
    no response at all). ``body`` is the DECODED body (decompressed when the
    Content-Encoding is gzip/deflate/zstd), capped. ``redirects`` lists every 3xx
    hop before the final one. ``skipped`` is set ("budget", "blocked",
    "no-contact") when the request was not sent at all. ``challenge`` is set by
    the detector, possibly retroactively (rule b).

    A chain that ends at ``stop_at`` (EXT-17 variants stop at H) keeps its last
    3xx as the final response (``status`` 3xx, ``final_url`` the URL that
    redirected), lists that hop in ``redirects`` with ``next_url`` = H, and sets
    ``stopped_at`` to H, which was NOT requested again. A 3xx that was not
    followed (left_site, hops_exceeded) is the final response and is not listed
    in ``redirects``.
    """

    url: str  # requested URL
    final_url: str  # URL of the last response received (== url when no redirect)
    purpose: Purpose
    kind: RequestKind
    status: int | None = None
    reason: str = ""
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: bytes = b""
    raw_length: int = 0  # body bytes on the wire (compressed)
    decoded_length: int = 0
    content_encoding: str | None = None
    undecodable_encoding: str | None = None  # e.g. "br": kept raw, not decoded
    truncated: bool = False
    redirects: list[RedirectHop] = field(default_factory=list)
    left_site: bool = False  # a hop pointed outside the allowed hosts and was not followed
    hops_exceeded: bool = False
    ttfb_ms: float | None = None  # of the final response
    total_ms: float | None = None  # whole chain
    started_utc: str = ""
    error: str | None = None  # "dns", "refused", "timeout", "tls:<verify_code>", "protocol"
    skipped: str | None = None
    challenge: str | None = None
    sha256: str | None = None  # of the decoded body
    seqs: list[int] = field(default_factory=list)  # RequestLog seq of every hop
    stopped_at: str | None = None  # the stop_at URL a hop pointed to (not requested)
    body_read: bool = False  # the body was read (False for headers_only and redirects)
    denied_redirect: bool = False  # the site redirected to a denied path (wp-login...): not followed, not requested
    refused_next_url: str | None = None  # where a chain that was not followed pointed (left_site or denied)
    soft_404: bool = False  # an HTML "not found" (or the home) instead of robots/sitemap/feed/image
    short_body: bool = False  # fewer body bytes than the Content-Length said; also ``truncated``
    reused: bool = False  # the final response came from an identical earlier request of this run

    @property
    def throttled(self) -> bool:
        """True when the site asked to slow down (rule e: 429, 503 + Retry-After, a repeated 503, a qualifying 403)."""
        return bool(self.challenge) and str(self.challenge).startswith(Rule.THROTTLE.value + ":")

    def header(self, name: str) -> str | None:
        """First value of header ``name`` (case-insensitive), or None."""
        wanted = name.lower()
        for key, value in self.headers:
            if key.lower() == wanted:
                return value
        return None

    def header_all(self, name: str) -> list[str]:
        """Every value of header ``name`` (case-insensitive), in received order."""
        wanted = name.lower()
        return [value for key, value in self.headers if key.lower() == wanted]

    @property
    def content_type(self) -> str | None:
        """Media type of Content-Type, lowercased, without parameters."""
        value = self.header("Content-Type")
        if not value:
            return None
        media = value.split(";", 1)[0].strip().lower()
        return media or None

    @property
    def usable(self) -> bool:
        """True when a response arrived, was not skipped, not errored and not challenged."""
        return self.status is not None and self.skipped is None and self.error is None and not self.challenge

    def text(self) -> tuple[str, int]:
        """Decode ``body`` to str; return (text, number of U+FFFD replacement chars).

        Charset from Content-Type, else from a <meta charset> in the first 2 KiB,
        else UTF-8; errors="replace". The count feeds the evidence gate.
        """
        charset = _charset_of(self.body, self.header("Content-Type"))
        try:
            text = self.body.decode(charset, errors="replace")
        except (LookupError, UnicodeError):
            # charset=undefined or charset=idna raise UnicodeError even with
            # errors="replace": read it as UTF-8, never crash.
            text = self.body.decode("utf-8", errors="replace")
        return text, text.count(_REPLACEMENT_CHAR)


def _charset_of(body: bytes, content_type: str | None) -> str:
    if body.startswith(_UTF8_BOM):
        return "utf-8-sig"
    label = None
    if content_type:
        m = _CHARSET_RE.search(content_type)
        if m:
            label = m.group(1)
    if label is None:
        m = _META_CHARSET_RE.search(body[:2048].decode("latin-1"))
        if m:
            label = m.group(1)
    if not label:
        # No declared charset: valid UTF-8 stays UTF-8 (a body cut in the middle of
        # a character included); anything else is read as windows-1252, like a
        # browser set to es-AR does.
        try:
            codecs.getincrementaldecoder("utf-8")().decode(bytes(body), final=False)
        except UnicodeDecodeError:
            return "cp1252"
        return "utf-8"
    label = label.strip().lower()
    if label in _WINDOWS_1252_LABELS:
        return "cp1252"
    try:
        return codecs.lookup(label).name
    except LookupError:
        return "utf-8"


def _inflate(data: bytes, wbits: int, max_bytes: int, *, multi_member: bool = False) -> tuple[bytes, bool]:
    out = bytearray()
    d = zlib.decompressobj(wbits)
    remaining = data
    first = True
    while True:
        try:
            out += d.decompress(remaining, max_bytes + 1 - len(out))
        except zlib.error:
            if first:
                raise
            # Bytes after a complete member that are not another member (a CRLF or
            # padding a PHP script printed after ob_gzhandler): ignored, like
            # browsers and curl do.
            return bytes(out), False
        if len(out) > max_bytes:
            return bytes(out[:max_bytes]), True
        if multi_member and d.eof and d.unused_data:
            remaining = d.unused_data
            d = zlib.decompressobj(wbits)
            first = False
            continue
        return bytes(out), False


def _unzstd(data: bytes, max_bytes: int) -> tuple[bytes, bool]:
    assert _zstd is not None
    out = bytearray()
    remaining = data
    while remaining:
        d = _zstd.ZstdDecompressor()
        out += d.decompress(remaining, max_bytes + 1 - len(out))
        if len(out) > max_bytes:
            return bytes(out[:max_bytes]), True
        if d.eof and d.unused_data:
            remaining = d.unused_data
            continue
        break
    return bytes(out), False


def decode_body(raw: bytes, content_encoding: str | None, max_bytes: int) -> tuple[bytes, str | None, bool]:
    """Decompress ``raw`` according to Content-Encoding.

    Returns (decoded, undecodable_encoding, truncated). Supports identity, gzip,
    x-gzip, deflate (zlib-wrapped and raw), zstd (compression.zstd) and chains
    like "gzip, zstd". Unknown encodings (br) are returned raw with their name.
    Decompression output is capped at ``max_bytes`` (decompression bomb guard).
    """
    codings = [c.strip().lower() for c in (content_encoding or "").split(",") if c.strip()]
    data = raw
    truncated = False
    # Codings are listed in the order they were applied: undo them in reverse.
    for coding in reversed(codings):
        if coding == "identity":
            continue
        try:
            if coding in ("gzip", "x-gzip"):
                data, cut = _inflate(data, 16 + zlib.MAX_WBITS, max_bytes, multi_member=True)
            elif coding == "deflate":
                try:
                    data, cut = _inflate(data, zlib.MAX_WBITS, max_bytes)
                except zlib.error:
                    data, cut = _inflate(data, -zlib.MAX_WBITS, max_bytes)
            elif coding == "zstd" and _zstd is not None:
                data, cut = _unzstd(data, max_bytes)
            else:
                return raw, coding, False
        except _DECODE_ERRORS:
            return raw, coding, False
        truncated = truncated or cut
    if len(data) > max_bytes:
        data, truncated = data[:max_bytes], True
    return data, None, truncated


def body_sha256(body: bytes) -> str:
    """Hex SHA-256 of a decoded body."""
    return hashlib.sha256(body).hexdigest()


def public_address(ip: str) -> bool:
    """True for a global unicast address: never loopback, private, CGNAT, link-local, ULA or reserved."""
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def system_resolver(host: str, port: int) -> list[str]:
    """Addresses of ``host`` from the system resolver, in its preference order."""
    out: list[str] = []
    for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        ip = str(info[4][0])
        if ip not in out:
            out.append(ip)
    return out


def location_text(location: str) -> str:
    """A Location header as a browser reads it.

    http.client decodes header bytes as ISO-8859-1; a server that writes the
    path in raw UTF-8 ("/inscripción/") then arrives as "/inscripciÃ³n/". When
    the latin-1 bytes are valid UTF-8, the UTF-8 reading is the right one.
    """
    if not location or location.isascii():
        return location
    try:
        return location.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return location


class _DeadlineRaw(io.RawIOBase):
    """Socket reads that stop at a total deadline, whatever the per-read timeout allows."""

    def __init__(self, sock: socket.socket, deadline: float, per_read: float, clock: Callable[[], float], keep: io.IOBase) -> None:
        super().__init__()
        self._sock = sock
        self._deadline = deadline
        self._per_read = per_read
        self._clock = clock
        # The socket's own makefile reader, kept open while this one is: it holds
        # the reference that defers the real close of the socket until the body is read.
        self._keep = keep

    def readable(self) -> bool:
        return True

    def close(self) -> None:
        if not self.closed:
            try:
                self._keep.close()
            finally:
                super().close()

    def readinto(self, b) -> int:  # type: ignore[no-untyped-def]
        remaining = self._deadline - self._clock()
        if remaining <= 0:
            raise TimeoutError("total deadline of the request reached")
        self._sock.settimeout(max(0.001, min(self._per_read, remaining)))
        return self._sock.recv_into(b)


def _deadline_response_class(deadline: float, per_read: float, clock: Callable[[], float]) -> type[http.client.HTTPResponse]:
    class _DeadlineResponse(http.client.HTTPResponse):
        def __init__(self, sock, *args, **kwargs):  # type: ignore[no-untyped-def]
            super().__init__(sock, *args, **kwargs)
            self.fp = io.BufferedReader(_DeadlineRaw(sock, deadline, per_read, clock, keep=self.fp))

    return _DeadlineResponse


@dataclass
class _Exchange:
    """One HTTP request/response on the wire (a single hop)."""

    status: int | None = None
    reason: str = ""
    headers: list[tuple[str, str]] = field(default_factory=list)
    raw: bytes = b""
    body_read: bool = False
    truncated: bool = False
    ttfb_ms: float | None = None
    ms: float | None = None
    error: str | None = None
    short_body: bool = False


@dataclass
class _Memo:
    """A response already received in this run for one exact request."""

    exchange: _Exchange
    seq: int  # the requests.log line of the request that was really sent
    max_bytes: int  # the body cap it was read with

    def serves(self, wants_body: Callable[[int, list[tuple[str, str]]], bool], max_bytes: int) -> bool:
        """True when this response can answer a new request with ``max_bytes`` without sending it."""
        ex = self.exchange
        if ex.status is None or not wants_body(ex.status, ex.headers):
            return True
        if not ex.body_read or len(ex.raw) > max_bytes:
            return False
        return not (ex.truncated and not ex.short_body and max_bytes > self.max_bytes)


def _exact_key(url: str) -> str:
    """The exact request: scheme, host, port, then path and query as they go on the request line."""
    try:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        host = domains.normalize_host(parts.hostname or "")
        port = parts.port or domains.DEFAULT_PORTS.get(scheme)
    except ValueError:
        return url
    return f"{scheme}://{host}:{port}{_request_target(parts.path, parts.query)}"


def _declared_length(headers: list[tuple[str, str]]) -> int | None:
    """The Content-Length the server declared, or None (absent, invalid, conflicting, or chunked)."""
    if any(k.lower() == "transfer-encoding" for k, _ in headers):
        return None
    values = {v.strip() for k, v in headers if k.lower() == "content-length"}
    if len(values) != 1:
        return None
    value = values.pop()
    return int(value) if value.isdigit() else None


def _safe_host(url: str) -> str:
    try:
        return domains.host_of(url)
    except ValueError:
        return ""


def _request_target(path: str, query: str) -> str:
    target = quote(path or "/", safe=_PATH_SAFE)
    if query:
        target += "?" + quote(query, safe=_QUERY_SAFE)
    return target


def _key(url: str) -> str:
    try:
        return domains.compare_key(url)
    except ValueError:
        return url


def _has_key_param(url: str) -> bool:
    try:
        query = urlsplit(url).query
    except ValueError:
        return True
    return any(name.strip().lower() == "key" for name, _ in parse_qsl(query, keep_blank_values=True))


def _split_tag(tag: str) -> tuple[Rule, str]:
    rule_letter, _, marker = tag.partition(":")
    try:
        rule = Rule(rule_letter)
    except ValueError:
        rule = Rule.BODY_MARKER
    return rule, marker


def _ms(seconds: float) -> float:
    return round(seconds * 1000.0, 1)


class HttpClient:
    """The only way the tool speaks HTTP. See the module docstring for the rules."""

    def __init__(
        self,
        guard: "ScopeGuard",
        log: "RequestLog",
        detector: "ChallengeDetector",
        redactor: "Redactor",
        config: ClientConfig | None = None,
        *,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.perf_counter,
        rng: random.Random | None = None,
        resolver: Callable[[str, int], list[str]] | None = None,
    ) -> None:
        self._guard = guard
        self._log = log
        self._detector = detector
        self._redactor = redactor
        self._cfg = config or ClientConfig()
        self._sleep = sleeper
        self._clock = clock
        self._rng = rng or random.Random()
        self._pace = self._cfg.pace_seconds
        self._paced_sent = 0
        self._site_count = 0
        self._blocked = False
        self._challenges_seen = 0
        self._events: list[ChallengeEvent] = []
        self._bodies: dict[str, list[Response]] = {}  # compare_key -> responses registered for rule (b)
        self._tls_context: ssl.SSLContext | None = None
        self._relaxed_context: ssl.SSLContext | None = None
        self._relaxed_hosts: set[str] = set()  # hosts where a browser accepts what VERIFY_X509_STRICT rejects
        self._chainless_hosts: set[str] = set()  # hosts that send the leaf without its intermediate (codes 20/21)
        self._chainless_context: ssl.SSLContext | None = None
        self._resolver = resolver or system_resolver
        self._throttles_seen = 0
        # Distinct URLs that answered 503 without Retry-After, with the first response
        # of each: when the second one confirms the throttle, the earlier one
        # is flagged too. A pair of 403s no longer counts.
        self._unavailable_keys: dict[str, Response] = {}
        # SITE URLs (compare keys) that answered 2xx in this run: a later 403 on one
        # of them is the site slowing the tool down.
        self._ok_keys: set[str] = set()
        # Every response received in this run, per exact request.
        self._memo: dict[tuple[str, str], _Memo] = {}
        self._cut_cause: str | None = None  # "challenge" | "throttle"

    # ------------------------------------------------------------------ public
    @property
    def resolver(self) -> Callable[[str, int], list[str]]:
        """The resolver of the address pinning; the TLS probe pins with the same one."""
        return self._resolver

    def fetch(
        self,
        url: str,
        *,
        purpose: Purpose,
        expect: Expect = Expect.ANY,
        follow_redirects: bool = True,
        stop_at: str | None = None,
        headers_only: bool = False,
        max_bytes: int = MAX_HTML_BYTES,
    ) -> Response:
        """GET a site, control or og:image URL.

        Asks guard.check (raises ScopeError, never caught here), applies pacing,
        budget and the blocked flag, sends, logs every hop, follows redirects by
        hand while guard.check_redirect allows and hop <= max_hops. ``stop_at``
        (a domains.compare_key) ends a chain WITHOUT requesting that URL again
        when a hop points to it (EXT-17 variants stop at H, which was already
        fetched). ``headers_only`` reads the status and headers and closes
        without reading the body (VIS-09 link checks). Runs challenge detection
        on SITE responses and handles the wait/retry/cut sequence. Never raises
        for HTTP statuses or network errors: they end up in Response.status /
        Response.error.
        """
        purpose = Purpose(purpose)
        try:
            kind = self._guard.check("GET", url, purpose)
        except ScopeError as exc:
            self._record_refused(url, purpose, "GET", 0, str(exc))
            raise
        accept = ACCEPT_HTML if expect in (Expect.HTML, Expect.ANY) else "*/*"
        args = dict(
            purpose=purpose,
            kind=kind,
            method="GET",
            expect=expect,
            follow=follow_redirects,
            stop_at=stop_at,
            headers_only=headers_only,
            max_bytes=max_bytes,
            extra_headers={"Accept": accept},
            body=None,
            connect_timeout=self._cfg.connect_timeout,
            read_timeout=self._cfg.read_timeout,
            paced=kind in PACED_KINDS,
            budgeted=kind is RequestKind.SITE,
            inspect=kind in (RequestKind.SITE, RequestKind.EXTERNAL),
            # The home reloads are repeats the collection plan asks for (EXT-19, EXT-20).
            fresh=purpose is Purpose.HOME_RELOAD,
        )
        resp = self._chain(url, **args)
        if resp.reused:
            # Nothing was sent: the original request already had its wait, retry or cut.
            return resp
        if kind is RequestKind.SITE and resp.challenge:
            resp = self._react_to_challenge(url, resp, args)
        elif kind is RequestKind.SITE:
            signal = self._throttle_signal(resp)
            if signal is not None:
                resp = self._react_to_throttle(url, resp, args, *signal)
        if kind is RequestKind.SITE and resp.status is not None and 200 <= resp.status < 300 and not resp.challenge:
            self._ok_keys.add(_key(resp.final_url or resp.url))
        return resp

    def set_home_reference(self, url_keys: list[str], sha256: str | None, genuine: bool) -> None:
        """Tell the challenge detector which URLs are the home and what its body is."""
        self._detector.set_home(url_keys, sha256, genuine)

    def relax_strict_tls(self, host: str) -> None:
        """Use a context without VERIFY_X509_STRICT for ``host``.

        Only after the TLS probe showed that a browser accepts the certificate
        (strict_only_failure). Chain and name are still verified.
        """
        self._relaxed_hosts.add(domains.normalize_host(host))

    def accept_incomplete_chain(self, host: str) -> None:
        """Read ``host`` without verifying its chain.

        Only after the TLS probe answered verify code 20 or 21 (the server sends
        the leaf without its intermediate; browsers usually complete the chain
        themselves): the site phase reads the public pages as a browser would.
        The addresses are still pinned to public ones, and EXT-07 reports the
        missing part of the chain from the probe's own result.
        """
        self._chainless_hosts.add(domains.normalize_host(host))

    @property
    def cut_cause(self) -> str | None:
        """Why the host was cut: "challenge" or "throttle" (None while not blocked)."""
        return self._cut_cause

    def api_request(
        self,
        method: str,
        url: str,
        *,
        purpose: Purpose,
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
        timeout: float = 30.0,
        follow_redirects: bool = False,
        max_bytes: int = MAX_API_BYTES,
    ) -> Response:
        """Call a third-party API (PSI, CrUX, DoH, RDAP, WordPress, Observatory, test fakes).

        Guard-checked and logged like any request, but never paced, never
        budgeted and never challenge-checked. Refuses (ValueError) a URL that
        contains ``key=`` in its query or any secret known to the Redactor.
        ``headers`` may carry X-goog-api-key; it is never logged. Redirects are
        followed by hand only when ``follow_redirects`` (RDAP via rdap.org).
        """
        purpose = Purpose(purpose)
        method = (method or "GET").upper()
        if _has_key_param(url) or self._redactor.contains_secret(url):
            # The message never repeats the URL: it would carry the key.
            raise ValueError("refused: an API key must travel in the X-goog-api-key header, never in a URL")
        try:
            kind = self._guard.check(method, url, purpose)
        except ScopeError as exc:
            self._record_refused(url, purpose, method, 0, str(exc))
            raise
        extra = {"Accept": "application/json, */*;q=0.5"}
        for name, value in (headers or {}).items():
            extra = {k: v for k, v in extra.items() if k.lower() != name.lower()}
            extra[name] = value
        if body is not None and not any(k.lower() == "content-type" for k in extra):
            extra["Content-Type"] = "application/json"
        return self._chain(
            url,
            purpose=purpose,
            kind=kind,
            method=method,
            expect=Expect.JSON,
            follow=follow_redirects,
            stop_at=None,
            headers_only=False,
            max_bytes=max_bytes,
            extra_headers=extra,
            body=body,
            connect_timeout=min(self._cfg.connect_timeout, timeout),
            read_timeout=timeout,
            paced=False,
            budgeted=False,
            inspect=False,
        )

    def reserve_site_slot(self, host: str, purpose: Purpose) -> str | None:
        """Account for a non-HTTP site connection (the TLS handshake).

        Applies the pause, the budget and the blocked flag exactly like fetch.
        Returns None when the caller may connect, or the skip reason ("budget",
        "blocked").
        """
        skip = self._site_gate()
        if skip is not None:
            return skip
        self._pace_wait()
        self._site_count += 1
        return None

    def mark_challenged(self, responses: list[Response], marker: str) -> None:
        """Flag earlier responses as challenged (rule b, detected late) and record the event."""
        for r in responses:
            if r.challenge:
                continue
            r.challenge = f"{Rule.DUPLICATE_BODY.value}:{marker}"
            self._events.append(
                ChallengeEvent(
                    seq=r.seqs[-1] if r.seqs else 0,
                    url=r.final_url,
                    rule=Rule.DUPLICATE_BODY,
                    marker=marker,
                    action="flagged-retroactively",
                )
            )

    @property
    def blocked(self) -> bool:
        """True once the host was cut after a repeated challenge."""
        return self._blocked

    @property
    def site_requests(self) -> int:
        """SITE + TLS requests sent so far (the budget counter)."""
        return self._site_count

    @property
    def challenge_events(self) -> list[ChallengeEvent]:
        """Every challenge detection of the run, in order."""
        return list(self._events)

    @property
    def budget_exhausted(self) -> bool:
        """True once the SITE budget is spent."""
        return self._site_count >= self._cfg.site_budget

    # ------------------------------------------------------------------ internals
    def _site_gate(self) -> str | None:
        if self._blocked:
            return "blocked"
        if self._site_count >= self._cfg.site_budget:
            return "budget"
        return None

    def _pace_wait(self) -> None:
        if self._paced_sent > 0:
            wait = self._pace
            if self._cfg.pace_jitter > 0:
                wait += self._rng.uniform(0.0, self._cfg.pace_jitter)
            if wait > 0:
                self._sleep(wait)
        self._paced_sent += 1

    def _ssl_context(self, host: str | None = None) -> ssl.SSLContext:
        if host is not None and host in self._chainless_hosts:
            if self._chainless_context is None:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                ctx.set_alpn_protocols(["http/1.1"])
                self._chainless_context = ctx
            return self._chainless_context
        if host is not None and host in self._relaxed_hosts:
            if self._relaxed_context is None:
                ctx = ssl.create_default_context()
                ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
                ctx.set_alpn_protocols(["http/1.1"])
                self._relaxed_context = ctx
            return self._relaxed_context
        if self._tls_context is None:
            ctx = ssl.create_default_context()
            ctx.set_alpn_protocols(["http/1.1"])  # http.client speaks HTTP/1.1 only
            self._tls_context = ctx
        return self._tls_context

    def _record(
        self,
        seq: int,
        ts: str,
        kind: RequestKind | str,
        purpose: Purpose | str,
        method: str,
        url: str,
        *,
        hop: int,
        outcome: str,
        status: int | None = None,
        bytes_raw: int = 0,
        ms: float | None = None,
        ttfb_ms: float | None = None,
        sha256: str | None = None,
        challenge: str | None = None,
        error: str | None = None,
    ) -> None:
        self._log.record(
            RequestRecord(
                seq=seq,
                ts_utc=ts,
                kind=str(kind),
                purpose=str(purpose),
                method=method,
                url=url,
                host=_safe_host(url),
                status=status,
                bytes_raw=bytes_raw,
                ms=ms,
                ttfb_ms=ttfb_ms,
                sha256_prefix=sha256[:16] if sha256 else None,
                hop=hop,
                challenge=challenge or None,
                outcome=outcome,
                error=error,
            )
        )

    def _record_refused(self, url: str, purpose: Purpose, method: str, hop: int, message: str) -> None:
        if str(purpose).startswith("api-") or purpose is Purpose.TEST_SERVICE:
            kind: RequestKind = RequestKind.API
        elif purpose is Purpose.CONTROL:
            kind = RequestKind.CONTROL
        elif self._guard.is_site_url(url):
            kind = RequestKind.SITE
        else:
            kind = RequestKind.EXTERNAL
        self._record(
            self._log.next_seq(), utc_now_iso(), kind, purpose, method, url, hop=hop, outcome=Outcome.REFUSED_SCOPE, error=message
        )

    def _react_to_challenge(self, url: str, resp: Response, args: dict) -> Response:
        rule, marker = _split_tag(resp.challenge or "")
        seq = resp.seqs[-1] if resp.seqs else 0
        if self._challenges_seen == 0 and not self._blocked:
            self._challenges_seen += 1
            self._events.append(ChallengeEvent(seq=seq, url=resp.final_url, rule=rule, marker=marker, action="retry-after-wait"))
            if self._cfg.challenge_wait > 0:
                self._sleep(self._cfg.challenge_wait)
            self._pace = self._cfg.challenge_pace
            retry = self._chain(url, **{**args, "fresh": True})
            if retry.challenge:
                self._challenges_seen += 1
                self._cut(retry)
            return retry
        self._challenges_seen += 1
        self._cut(resp)
        return resp

    @staticmethod
    def _retry_after(resp: Response) -> float | None:
        value = (resp.header("Retry-After") or "").strip()
        if not value:
            return None
        if value.isdigit():
            return float(int(value))
        try:
            moment = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if moment is None:
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=dt.UTC)
        return max(0.0, (moment - dt.datetime.now(dt.UTC)).total_seconds())

    def _throttle_signal(self, resp: Response) -> tuple[str, float | None] | None:
        """(marker, Retry-After seconds) when the site asked to slow down, else None."""
        if resp.status == 429:
            return "http-429", self._retry_after(resp)
        if resp.status == 503 and resp.header("Retry-After") is not None:
            return "http-503", self._retry_after(resp)
        if resp.status == 403:
            # Two ordinary pages that answer 403 (directories
            # without an index) are not the site asking to slow down. A 403 is the
            # signal only with a Retry-After header or on a URL that answered 2xx
            # earlier in the run (a 403 with a challenge marker is rule (d)).
            key = _key(resp.final_url or resp.url)
            if resp.header("Retry-After") is not None or key in self._ok_keys:
                return "http-403", self._retry_after(resp)
            return None
        if resp.status == 503:
            # A WAF page is never read on a headers-only link check: a second 503
            # on a distinct URL is the signal.
            seen = self._unavailable_keys
            seen.setdefault(_key(resp.final_url or resp.url), resp)
            if len(seen) >= 2:
                marker = f"http-{resp.status}"
                # The earlier 503 was part of the same request to slow down: it is
                # never a page of the site that answered with an error.
                self._flag_throttled([r for r in seen.values() if r is not resp], marker)
                return marker, self._retry_after(resp)
        return None

    def _flag_throttled(self, responses: list[Response], marker: str) -> None:
        """Flag earlier responses as throttled (rule e, confirmed late) and record the event."""
        for r in responses:
            if r.challenge:
                continue
            r.challenge = f"{Rule.THROTTLE.value}:{marker}"
            self._events.append(
                ChallengeEvent(
                    seq=r.seqs[-1] if r.seqs else 0,
                    url=r.final_url,
                    rule=Rule.THROTTLE,
                    marker=marker,
                    action="flagged-retroactively",
                )
            )

    def _react_to_throttle(self, url: str, resp: Response, args: dict, marker: str, retry_after: float | None) -> Response:
        resp.challenge = f"{Rule.THROTTLE.value}:{marker}"
        seq = resp.seqs[-1] if resp.seqs else 0
        if self._throttles_seen == 0 and not self._blocked:
            self._throttles_seen += 1
            self._events.append(ChallengeEvent(seq=seq, url=resp.final_url, rule=Rule.THROTTLE, marker=marker, action="retry-after-wait"))
            wait = self._cfg.challenge_wait if retry_after is None else retry_after
            wait = min(wait, self._cfg.throttle_wait_cap)
            if wait > 0:
                self._sleep(wait)
            self._pace = max(self._pace, self._cfg.challenge_pace)
            retry = self._chain(url, **{**args, "fresh": True})
            if retry.challenge:
                self._challenges_seen += 1
                self._cut(retry, cause="challenge")
                return retry
            again = self._throttle_signal(retry)
            if again is not None:
                retry.challenge = f"{Rule.THROTTLE.value}:{again[0]}"
                self._throttles_seen += 1
                self._cut(retry, cause="throttle")
            return retry
        self._throttles_seen += 1
        self._cut(resp, cause="throttle")
        return resp

    def _cut(self, resp: Response, cause: str = "challenge") -> None:
        self._blocked = True
        if self._cut_cause is None:
            self._cut_cause = cause
        rule, marker = _split_tag(resp.challenge or "")
        self._events.append(
            ChallengeEvent(seq=resp.seqs[-1] if resp.seqs else 0, url=resp.final_url, rule=rule, marker=marker, action="host-cut")
        )

    def _register_body(self, resp: Response, url: str) -> None:
        """Rule (b): identical small 200 bodies on distinct URLs."""
        self._bodies.setdefault(_key(url), []).append(resp)
        flagged = self._detector.register_body(url, resp.status, resp.body)
        if not flagged:
            return
        earlier = [r for u in flagged for r in self._bodies.get(_key(u), []) if r is not resp]
        self.mark_challenged(earlier, DUPLICATE_MARKER)
        resp.challenge = f"{Rule.DUPLICATE_BODY.value}:{DUPLICATE_MARKER}"

    def _chain(
        self,
        url: str,
        *,
        purpose: Purpose,
        kind: RequestKind,
        method: str,
        expect: Expect,
        follow: bool,
        stop_at: str | None,
        headers_only: bool,
        max_bytes: int,
        extra_headers: dict[str, str] | None,
        body: bytes | None,
        connect_timeout: float,
        read_timeout: float,
        paced: bool,
        budgeted: bool,
        inspect: bool,
        fresh: bool = False,
    ) -> Response:
        resp = Response(url=url, final_url=url, purpose=purpose, kind=kind, started_utc=utc_now_iso())
        headers = dict(extra_headers or {})
        current = url
        hop = 0
        total = 0.0

        def wants_body(status: int, hdrs: list[tuple[str, str]]) -> bool:
            if headers_only:
                return False
            if follow and status in REDIRECT_STATUSES and any(k.lower() == "location" for k, _ in hdrs):
                return False
            return True

        while True:
            ts = utc_now_iso()
            # A request already answered in this run is never sent again.
            memo_key = (method, _exact_key(current)) if (inspect and method == "GET") else None
            cached = self._memo.get(memo_key) if (memo_key is not None and not fresh) else None
            if cached is not None and not cached.serves(wants_body, max_bytes):
                cached = None
            reused = cached is not None
            if cached is not None:
                ex = cached.exchange
                seq = cached.seq
                resp.seqs.append(seq)
            else:
                if budgeted:
                    skip = self._site_gate()
                    if skip is not None:
                        resp.skipped = skip
                        seq = self._log.next_seq()
                        resp.seqs.append(seq)
                        outcome = Outcome.SKIPPED_BLOCKED if skip == "blocked" else Outcome.SKIPPED_BUDGET
                        self._record(seq, ts, kind, purpose, method, current, hop=hop, outcome=outcome)
                        break
                if paced:
                    self._pace_wait()
                if budgeted:
                    self._site_count += 1
                seq = self._log.next_seq()
                resp.seqs.append(seq)

                total_deadline = self._cfg.total_deadline if paced else max(self._cfg.total_deadline, connect_timeout + read_timeout + 30.0)
                try:
                    ex = self._exchange(
                        method, current, headers, body, connect_timeout, read_timeout, max_bytes, wants_body,
                        pin=kind in PINNED_KINDS, total_deadline=total_deadline,
                    )
                except ScopeError as exc:  # the transport's own test-isolation backstop
                    self._record(seq, ts, kind, purpose, method, current, hop=hop, outcome=Outcome.REFUSED_SCOPE, error=str(exc))
                    raise
                total += ex.ms or 0.0
                if memo_key is not None and ex.status is not None and ex.error is None:
                    self._memo[memo_key] = _Memo(ex, seq, max_bytes)
            resp.final_url = current
            if ex.error is not None:
                resp.error = ex.error
                self._record(seq, ts, kind, purpose, method, current, hop=hop, outcome=Outcome.ERROR, ms=ex.ms, error=ex.error)
                break

            resp.status, resp.reason, resp.headers, resp.ttfb_ms = ex.status, ex.reason, ex.headers, ex.ttfb_ms
            location = next((v for k, v in ex.headers if k.lower() == "location"), None)
            if follow and ex.status in REDIRECT_STATUSES and location:
                if not reused:
                    self._record(
                        seq, ts, kind, purpose, method, current, hop=hop, outcome=Outcome.OK, status=ex.status, ms=ex.ms, ttfb_ms=ex.ttfb_ms
                    )
                next_url = domains.resolve_url(current, location_text(location))
                hop_rec = RedirectHop(url=current, status=ex.status, location=location, next_url=None, ttfb_ms=ex.ttfb_ms, headers=list(ex.headers))
                if next_url is None:
                    resp.left_site = True
                    break
                if stop_at is not None and _key(next_url) == stop_at:
                    hop_rec.next_url = next_url
                    resp.redirects.append(hop_rec)
                    resp.stopped_at = next_url
                    break
                if hop + 1 > self._cfg.max_hops:
                    resp.hops_exceeded = True
                    break
                try:
                    verdict = self._guard.redirect_verdict(current, next_url, purpose, hop + 1)
                except ScopeError as exc:
                    self._record_refused(next_url, purpose, method, hop + 1, str(exc))
                    raise
                if verdict is not RedirectVerdict.FOLLOW:
                    resp.refused_next_url = next_url
                    if verdict is RedirectVerdict.DENIED:
                        # The site pointed to a denied path: logged, never requested, never fatal.
                        resp.denied_redirect = True
                        if not reused:  # logged once, when the hop was really received
                            self._record_refused(next_url, purpose, method, hop + 1, "redirect to a denied path (not requested)")
                    else:
                        resp.left_site = True
                    break
                hop_rec.next_url = next_url
                resp.redirects.append(hop_rec)
                if _safe_host(next_url) != _safe_host(current):
                    # Never forward the API key to another host.
                    headers = {k: v for k, v in headers.items() if k.lower() != API_KEY_HEADER}
                if ex.status == 303 or (ex.status in (301, 302) and method == "POST"):
                    method, body = "GET", None
                current = next_url
                hop += 1
                continue

            # The final response of the chain.
            content_encoding = next((v for k, v in ex.headers if k.lower() == "content-encoding"), None)
            resp.content_encoding = content_encoding.strip().lower() if content_encoding else None
            resp.body_read = ex.body_read
            resp.reused = reused
            if ex.body_read:
                decoded, undecodable, cut = decode_body(ex.raw, content_encoding, max_bytes) if ex.raw else (b"", None, False)
                resp.body = decoded
                resp.undecodable_encoding = undecodable
                resp.truncated = ex.truncated or cut
                resp.short_body = ex.short_body
                resp.raw_length = len(ex.raw)
                resp.decoded_length = len(decoded)
                resp.sha256 = body_sha256(decoded)
            if inspect:
                verdict = self._detector.inspect(current, ex.status, ex.headers, resp.body, expect)
                if verdict.challenged:
                    resp.challenge = verdict.describe()
                    if verdict.same_as_home:
                        # The link-less "home" is served for robots.txt too: it was a challenge all along.
                        home_sha = self._detector.home_sha256
                        earlier = [r for rs in self._bodies.values() for r in rs if r.sha256 == home_sha and r is not resp]
                        self.mark_challenged(earlier, DUPLICATE_MARKER)
                elif verdict.soft_404:
                    resp.soft_404 = True
                elif kind is RequestKind.SITE and ex.body_read and ex.status == 200:
                    self._register_body(resp, current)
            if not reused:
                self._record(
                    seq,
                    ts,
                    kind,
                    purpose,
                    method,
                    current,
                    hop=hop,
                    outcome=Outcome.OK,
                    status=ex.status,
                    bytes_raw=len(ex.raw),
                    ms=ex.ms,
                    ttfb_ms=ex.ttfb_ms,
                    sha256=resp.sha256,
                    challenge=resp.challenge,
                )
            break
        resp.total_ms = round(total, 1)
        return resp

    def _exchange(
        self,
        method: str,
        url: str,
        extra_headers: dict[str, str],
        body: bytes | None,
        connect_timeout: float,
        read_timeout: float,
        max_bytes: int,
        wants_body: Callable[[int, list[tuple[str, str]]], bool],
        *,
        pin: bool = False,
        total_deadline: float | None = None,
    ) -> _Exchange:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        host = domains.normalize_host(parts.hostname or "")
        port = parts.port or domains.DEFAULT_PORTS[scheme]
        host_in_header = f"[{host}]" if ":" in host else host
        host_header = host_in_header if port == domains.DEFAULT_PORTS[scheme] else f"{host_in_header}:{port}"
        headers = {
            "Host": host_header,
            "User-Agent": self._cfg.user_agent,
            "Accept-Language": ACCEPT_LANGUAGE,
            "Accept-Encoding": ACCEPT_ENCODING,
            "Accept": "*/*",
            "Connection": "close",
        }
        for name, value in extra_headers.items():
            headers = {k: v for k, v in headers.items() if k.lower() != name.lower()}
            headers[name] = value
        target = _request_target(parts.path, parts.query)

        t0 = self._clock()  # TTFB includes the name lookup, as before pinning

        def elapsed() -> float:
            return _ms(self._clock() - t0)

        route = self._cfg.loopback
        conn: http.client.HTTPConnection
        if route is not None:
            if host.endswith(route.suffix):
                if host in route.unresolvable:
                    return _Exchange(error="dns", ms=0.0)
                conn = http.client.HTTPConnection(route.host, route.port, timeout=connect_timeout)
                headers[TEST_SCHEME_HEADER] = scheme
            elif host in LOOPBACK_HOSTS and scheme == "http":
                conn = http.client.HTTPConnection(host, port, timeout=connect_timeout)
            else:
                raise ScopeError(f"test isolation: {host} is neither a .test host nor a loopback API")
        else:
            public: list[str] = []
            if pin:
                # Resolve first, refuse any non-public address, then
                # connect only to the checked addresses (SNI and Host keep the name).
                try:
                    addresses = self._resolver(host, port)
                except (OSError, UnicodeError):
                    return _Exchange(error="dns", ms=elapsed())
                public = [a for a in addresses if public_address(a)]
                if not public:
                    return _Exchange(error="blocked-address" if addresses else "dns", ms=elapsed())
            if scheme == "https":
                conn = http.client.HTTPSConnection(host, port, timeout=connect_timeout, context=self._ssl_context(host))
            else:
                conn = http.client.HTTPConnection(host, port, timeout=connect_timeout)
            if public:
                checked = list(public)

                def _connect_pinned(address, timeout=connect_timeout, source_address=None):  # type: ignore[no-untyped-def]
                    # Like socket.create_connection, each address in turn, but only the checked ones.
                    last: OSError | None = None
                    for ip in checked:
                        try:
                            return socket.create_connection((ip, address[1]), timeout, source_address)
                        except OSError as exc:
                            last = exc
                    raise last if last is not None else OSError("no address")

                conn._create_connection = _connect_pinned  # type: ignore[attr-defined]

        deadline = t0 + (total_deadline if total_deadline is not None else self._cfg.total_deadline)
        conn.response_class = _deadline_response_class(deadline, read_timeout, self._clock)  # type: ignore[misc]

        try:
            conn.connect()
            if conn.sock is not None:
                conn.sock.settimeout(read_timeout)
            conn.request(method, target, body=body, headers=headers)
            r = conn.getresponse()
            ttfb = elapsed()
            hdrs = [(str(k), str(v)) for k, v in r.getheaders()]
            ex = _Exchange(status=r.status, reason=r.reason or "", headers=hdrs, ttfb_ms=ttfb)
            if wants_body(r.status, hdrs):
                try:
                    raw = r.read(max_bytes + 1)
                except http.client.IncompleteRead as exc:
                    raw, ex.truncated = bytes(exc.partial), True
                if len(raw) > max_bytes:
                    raw, ex.truncated = raw[:max_bytes], True
                else:
                    # A connection closed before the declared length (http.client's
                    # read(amt) returns the partial body without an error).
                    declared = _declared_length(hdrs)
                    if declared is not None and len(raw) < declared:
                        ex.truncated = ex.short_body = True
                ex.raw, ex.body_read = raw, True
            ex.ms = elapsed()
            return ex
        except ssl.SSLCertVerificationError as exc:
            return _Exchange(error=f"tls:{exc.verify_code}", ms=elapsed())
        except ssl.SSLError:
            return _Exchange(error="tls", ms=elapsed())
        except socket.gaierror:
            return _Exchange(error="dns", ms=elapsed())
        except ConnectionRefusedError:
            return _Exchange(error="refused", ms=elapsed())
        except TimeoutError:
            return _Exchange(error="timeout", ms=elapsed())
        except http.client.HTTPException:
            return _Exchange(error="protocol", ms=elapsed())
        except ConnectionError:
            return _Exchange(error="reset", ms=elapsed())
        except ValueError:
            return _Exchange(error="invalid-url", ms=elapsed())
        except OSError:
            return _Exchange(error="network", ms=elapsed())
        finally:
            conn.close()
