"""One TLS handshake per site host: expiry (EXT-07) and ALPN (EXT-18).

ssl.create_default_context (verifies chain and hostname; TLS 1.2 minimum;
VERIFY_X509_STRICT and PARTIAL_CHAIN on 3.13+), server_hostname for SNI,
set_alpn_protocols(["h2", "http/1.1"]). Records version,
selected_alpn_protocol, issuer organizationName, notBefore/notAfter and
days_left = floor((notAfter - now_utc) / 86400) via ssl.cert_time_to_seconds.

On ssl.SSLCertVerificationError: record verify_code and verify_message (10
expired, 9 not yet valid, 18/19 self-signed, 20/21 missing issuer, 62 hostname
mismatch). Retry once with ``verify_flags &= ~VERIFY_X509_STRICT`` to separate
strict-only failures (browsers accept them) from real ones. For the dates of an
invalid certificate, reconnect with CERT_NONE and parse
getpeercert(binary_form=True) with a minimal DER walker (validity only).

Windows caveat: verify_code 20 from Python on Windows does
not prove a broken chain (the local root store loads roots on demand). It is
``inconclusive`` unless get_unverified_chain has only the leaf. EXT-07 turns an
inconclusive result into NO_VERIFICADO, never into "invalid".

Not measurable with this OpenSSL: SSL Labs grade and TLS 1.0/1.1
acceptance. Written as "no medido" in the evidence.

Every handshake goes through ScopeGuard.check_tls and HttpClient.reserve_site_slot
(it is a request to the site: paced and budgeted), and is logged. In test mode
ServiceTlsProber asks the fake API server instead (GET <test_tls>?host=&port=).

Address pinning, like HttpClient's: the host is resolved
with the HttpClient's resolver, only addresses that pass
httpclient.public_address are kept, each is tried in turn, and the socket is
wrapped with server_hostname=host. A name with no public address is never
connected to (error "blocked-address").

Result fields: ``ok`` True means a browser would accept the certificate. A
failure that disappears without VERIFY_X509_STRICT keeps ``ok`` True, sets
``strict_only_failure`` and leaves the strict error in ``strict_message``;
``verify_code``/``verify_message`` describe only a failure that stands.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import socket
import ssl
import time
from collections.abc import Callable
from dataclasses import dataclass, fields
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

from . import domains, fmt
from .requestlog import Outcome, RequestRecord, utc_now_iso
from .scope import Purpose, RequestKind, ScopeError

if TYPE_CHECKING:
    from .httpclient import HttpClient
    from .requestlog import RequestLog
    from .scope import ScopeGuard

ALPN_PROTOCOLS: tuple[str, ...] = ("h2", "http/1.1")
TIMEOUT_SECONDS = 10.0
NOT_MEASURED = "no medido"  # SSL Labs grade and TLS 1.0/1.1 acceptance
WINDOWS_ISSUER_CODES: frozenset[int] = frozenset({20})


@dataclass
class TlsResult:
    host: str
    port: int = 443
    ok: bool = False  # handshake completed with a verified certificate
    tls_version: str | None = None
    alpn: str | None = None
    issuer_org: str | None = None
    not_before: str | None = None  # ISO 8601 UTC
    not_after: str | None = None  # ISO 8601 UTC
    days_left: int | None = None
    lifetime_days: int | None = None
    verify_code: int | None = None
    verify_message: str | None = None
    strict_only_failure: bool = False  # passed once VERIFY_X509_STRICT was removed
    inconclusive: bool = False  # Windows code-20 case
    chain_length: int | None = None
    handshake_ms: float | None = None
    error: str | None = None  # "refused", "timeout", "dns", "blocked-address", "verify", "skipped:<reason>"
    strict_message: str | None = None  # the VERIFY_X509_STRICT-only error, when strict_only_failure
    not_measured: str = NOT_MEASURED  # SSL Labs grade, TLS 1.0/1.1


def _parse_time(value: str) -> dt.datetime:
    """OpenSSL text ('Jan  1 06:40:15 2027 GMT') or ISO 8601, as an aware UTC datetime."""
    v = value.strip()
    try:
        return dt.datetime.fromtimestamp(ssl.cert_time_to_seconds(v), dt.UTC)
    except ValueError:
        pass
    parsed = dt.datetime.fromisoformat(v.replace("Z", "+00:00") if v.endswith("Z") else v)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def days_left(not_after: str, now_utc: dt.datetime) -> int:
    """floor((notAfter - now) / 86400 s). ``not_after`` in OpenSSL text ('Jan  1 06:40:15 2027 GMT') or ISO."""
    end = _parse_time(not_after)
    now = now_utc if now_utc.tzinfo is not None else now_utc.replace(tzinfo=dt.UTC)
    return math.floor((end - now).total_seconds() / 86400)


# --------------------------------------------------------------------------- DER


def _tlv(data: bytes, pos: int) -> tuple[int, int, int]:
    """Read one DER TLV at ``pos``: (tag, value_start, value_end)."""
    tag = data[pos]
    pos += 1
    first = data[pos]
    pos += 1
    if first < 0x80:
        length = first
    else:
        count = first & 0x7F
        if count == 0 or count > 4:
            raise ValueError("unsupported DER length")
        length = int.from_bytes(data[pos : pos + count], "big")
        pos += count
    end = pos + length
    if end > len(data):
        raise ValueError("truncated DER")
    return tag, pos, end


def _der_time(tag: int, raw: bytes) -> dt.datetime:
    text = raw.decode("ascii").rstrip("Z")
    if tag == 0x17:  # UTCTime YYMMDDHHMM[SS]Z
        year = int(text[:2])
        year += 1900 if year >= 50 else 2000
        rest = text[2:]
    elif tag == 0x18:  # GeneralizedTime YYYYMMDDHHMM[SS]Z
        year = int(text[:4])
        rest = text[4:]
    else:
        raise ValueError("not a time")
    month, day, hour, minute = int(rest[0:2]), int(rest[2:4]), int(rest[4:6]), int(rest[6:8])
    second = int(rest[8:10]) if len(rest) >= 10 else 0
    return dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.UTC)


def der_validity(der: bytes) -> tuple[dt.datetime, dt.datetime] | None:
    """(notBefore, notAfter) from a DER X.509 certificate; None when it cannot be walked."""
    try:
        tag, start, _end = _tlv(der, 0)  # Certificate SEQUENCE
        if tag != 0x30:
            return None
        tag, pos, tbs_end = _tlv(der, start)  # tbsCertificate SEQUENCE
        if tag != 0x30:
            return None
        tag, vstart, vend = _tlv(der, pos)
        if tag == 0xA0:  # [0] EXPLICIT version
            pos = vend
            tag, vstart, vend = _tlv(der, pos)
        if tag != 0x02:  # serialNumber INTEGER
            return None
        pos = vend
        for _ in range(2):  # signature AlgorithmIdentifier, issuer Name
            tag, vstart, vend = _tlv(der, pos)
            if tag != 0x30:
                return None
            pos = vend
        tag, vstart, vend = _tlv(der, pos)  # validity SEQUENCE
        if tag != 0x30 or vend > tbs_end:
            return None
        t1, s1, e1 = _tlv(der, vstart)
        t2, s2, e2 = _tlv(der, e1)
        return _der_time(t1, der[s1:e1]), _der_time(t2, der[s2:e2])
    except (ValueError, IndexError, UnicodeDecodeError):
        return None


# --------------------------------------------------------------------------- probes


def _issuer_org(cert: dict[str, Any]) -> str | None:
    for rdn in cert.get("issuer", ()) or ():
        for item in rdn:
            if len(item) == 2 and item[0] == "organizationName":
                return str(item[1])
    return None


def _iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.UTC).replace(microsecond=0).isoformat()


def _fill_dates(result: TlsResult, not_before: dt.datetime | None, not_after: dt.datetime | None, now: dt.datetime) -> None:
    if not_before is not None:
        result.not_before = _iso(not_before)
    if not_after is not None:
        result.not_after = _iso(not_after)
        result.days_left = math.floor((not_after - now).total_seconds() / 86400)
    if not_before is not None and not_after is not None:
        result.lifetime_days = math.floor((not_after - not_before).total_seconds() / 86400)


class _BlockedAddress(OSError):
    """The name resolved only to non-public addresses: nothing was connected to."""


class _NoAddress(OSError):
    """The name did not resolve."""


def _error_name(exc: BaseException) -> str:
    if isinstance(exc, _BlockedAddress):
        return "blocked-address"
    if isinstance(exc, (socket.gaierror, _NoAddress)):
        return "dns"
    if isinstance(exc, ConnectionRefusedError):
        return "refused"
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ssl.SSLError):
        return "tls-handshake"
    return "network"


class TlsProber:
    def __init__(
        self,
        guard: "ScopeGuard",
        http: "HttpClient",
        log: "RequestLog",
        *,
        now: Callable[[], dt.datetime] | None = None,
        timeout: float = TIMEOUT_SECONDS,
        resolver: Callable[[str, int], list[str]] | None = None,
        connector: Callable[..., socket.socket] | None = None,
    ) -> None:
        from .httpclient import system_resolver

        self._guard = guard
        self._http = http
        self._log = log
        self._now = now or fmt.now_utc
        self._timeout = timeout
        # The same resolver as the HTTP client's address pinning; tests inject both.
        self._resolver = resolver or getattr(http, "resolver", None) or system_resolver
        self._connector = connector or socket.create_connection

    def _open(self, host: str, port: int) -> socket.socket:
        """A TCP connection to a PUBLIC address of ``host`` (pinned like HttpClient's)."""
        from .httpclient import public_address

        try:
            addresses = self._resolver(host, port)
        except (OSError, UnicodeError) as exc:
            raise _NoAddress(str(exc)) from exc
        public = [a for a in addresses if public_address(a)]
        if not public:
            raise _BlockedAddress("no public address") if addresses else _NoAddress("no address")
        last: OSError | None = None
        for ip in public:
            try:
                return self._connector((ip, port), timeout=self._timeout)
            except OSError as exc:
                last = exc
        raise last if last is not None else _NoAddress("no address")

    def _record(self, host: str, port: int, outcome: str, ms: float | None, error: str | None) -> None:
        self._log.record(
            RequestRecord(
                seq=self._log.next_seq(),
                ts_utc=utc_now_iso(),
                kind=str(RequestKind.TLS),
                purpose=str(Purpose.TLS),
                method="TLS",
                url=f"tls://{host}:{port}",
                host=host,
                status=None,
                bytes_raw=0,
                ms=ms,
                ttfb_ms=None,
                sha256_prefix=None,
                hop=0,
                challenge=None,
                outcome=outcome,
                error=error,
            )
        )

    def _connect(self, host: str, port: int, ctx: ssl.SSLContext) -> tuple[ssl.SSLSocket, float]:
        """Reserve a site slot, connect and handshake; the caller closes the socket."""
        skip = self._http.reserve_site_slot(host, Purpose.TLS)
        if skip is not None:
            outcome = Outcome.SKIPPED_BLOCKED if skip == "blocked" else Outcome.SKIPPED_BUDGET
            self._record(host, port, outcome, None, None)
            raise _Skipped(skip)
        t0 = time.perf_counter()
        try:
            raw = self._open(host, port)
        except OSError as exc:
            self._record(host, port, Outcome.ERROR, round((time.perf_counter() - t0) * 1000, 1), _error_name(exc))
            raise
        try:
            tls = ctx.wrap_socket(raw, server_hostname=host)
        except BaseException as exc:
            raw.close()
            name = "verify" if isinstance(exc, ssl.SSLCertVerificationError) else _error_name(exc)
            self._record(host, port, Outcome.ERROR, round((time.perf_counter() - t0) * 1000, 1), name)
            raise
        ms = round((time.perf_counter() - t0) * 1000, 1)
        self._record(host, port, Outcome.OK, ms, None)
        return tls, ms

    @staticmethod
    def _context(strict: bool = True, verify: bool = True) -> ssl.SSLContext:
        ctx = ssl.create_default_context()
        ctx.set_alpn_protocols(list(ALPN_PROTOCOLS))
        if not strict:
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        return ctx

    @staticmethod
    def _chain_length(tls: ssl.SSLSocket, verified: bool) -> int | None:
        getter = getattr(tls, "get_verified_chain" if verified else "get_unverified_chain", None)
        if getter is None:
            return None
        try:
            chain = getter()
        except (ssl.SSLError, ValueError):
            return None
        return len(chain) if chain is not None else None

    def _describe_verified(self, result: TlsResult, tls: ssl.SSLSocket, ms: float) -> None:
        result.ok = True
        result.handshake_ms = ms
        result.tls_version = tls.version()
        result.alpn = tls.selected_alpn_protocol()
        cert = tls.getpeercert() or {}
        result.issuer_org = _issuer_org(cert)
        nb = cert.get("notBefore")
        na = cert.get("notAfter")
        _fill_dates(
            result,
            _parse_time(nb) if isinstance(nb, str) else None,
            _parse_time(na) if isinstance(na, str) else None,
            self._now(),
        )
        result.chain_length = self._chain_length(tls, verified=True)

    def probe(self, host: str, port: int = 443) -> TlsResult:
        """Handshake as described in the module docstring. Never raises except ScopeError."""
        h = domains.normalize_host(host)
        result = TlsResult(host=h, port=port)
        try:
            self._guard.check_tls(h, port)
        except ScopeError as exc:
            self._record(h, port, Outcome.REFUSED_SCOPE, None, str(exc))
            raise
        try:
            return self._probe(result, h, port)
        except _Skipped as skip:
            result.error = f"skipped:{skip.reason}"
            return result
        except ScopeError:
            raise
        except Exception as exc:  # never let a handshake stop the run
            result.error = result.error or _error_name(exc)
            return result

    def _probe(self, result: TlsResult, host: str, port: int) -> TlsResult:
        try:
            tls, ms = self._connect(host, port, self._context())
        except ssl.SSLCertVerificationError as exc:
            strict_error = exc
        except OSError as exc:
            result.error = _error_name(exc)
            return result
        else:
            with tls:
                self._describe_verified(result, tls, ms)
            return result

        # Verification failed. 1) Was it VERIFY_X509_STRICT only?
        try:
            tls, ms = self._connect(host, port, self._context(strict=False))
        except ssl.SSLCertVerificationError as exc:
            result.verify_code = exc.verify_code
            result.verify_message = exc.verify_message
        except (OSError, _Skipped) as exc:
            # The second opinion could not be taken: the strict failure stands.
            result.verify_code = strict_error.verify_code
            result.verify_message = strict_error.verify_message
            result.error = "verify" if isinstance(exc, _Skipped) else _error_name(exc)
        else:
            with tls:
                self._describe_verified(result, tls, ms)
            result.strict_only_failure = True
            result.strict_message = f"{strict_error.verify_code} {strict_error.verify_message}"
            return result

        # 2) A real failure: read the dates and the chain without verification.
        result.ok = False
        result.error = result.error or "verify"
        try:
            tls, ms = self._connect(host, port, self._context(verify=False))
        except (OSError, _Skipped):
            return result
        with tls:
            result.handshake_ms = ms
            result.tls_version = tls.version()
            result.alpn = tls.selected_alpn_protocol()
            der = tls.getpeercert(binary_form=True)
            validity = der_validity(der) if der else None
            if validity is not None:
                _fill_dates(result, validity[0], validity[1], self._now())
            result.chain_length = self._chain_length(tls, verified=False)
        if result.verify_code in WINDOWS_ISSUER_CODES:
            # Windows loads roots on demand: code 20 proves nothing unless only the leaf was sent.
            result.inconclusive = result.chain_length != 1
        return result


class _Skipped(Exception):
    """The site slot was refused (budget or blocked host)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


_RESULT_FIELDS = {f.name for f in fields(TlsResult)}


class ServiceTlsProber:
    """Test-only prober: GET <base>?host=&port= on the fake API server returns a TlsResult as JSON."""

    def __init__(self, guard: "ScopeGuard", http: "HttpClient", base_url: str) -> None:
        self._guard = guard
        self._http = http
        self._base = base_url

    def probe(self, host: str, port: int = 443) -> TlsResult:
        h = domains.normalize_host(host)
        self._guard.check_tls(h, port)  # the scope is enforced in test mode too
        skip = self._http.reserve_site_slot(h, Purpose.TLS)
        if skip is not None:
            return TlsResult(host=h, port=port, error=f"skipped:{skip}")
        url = self._base + "?" + urlencode({"host": h, "port": str(port)})
        resp = self._http.api_request("GET", url, purpose=Purpose.TEST_SERVICE, timeout=10.0)
        try:
            obj = json.loads(resp.text()[0]) if resp.status == 200 else None
        except ValueError:
            obj = None
        if not isinstance(obj, dict):
            return TlsResult(host=h, port=port, error="refused")
        values = {k: v for k, v in obj.items() if k in _RESULT_FIELDS}
        values["host"] = h
        values.setdefault("port", port)
        result = TlsResult(**values)
        now = fmt.now_utc()
        try:
            if result.not_after and result.days_left is None:
                result.days_left = days_left(result.not_after, now)
            if result.not_after and result.not_before and result.lifetime_days is None:
                span = _parse_time(result.not_after) - _parse_time(result.not_before)
                result.lifetime_days = math.floor(span.total_seconds() / 86400)
        except ValueError:
            pass
        return result
