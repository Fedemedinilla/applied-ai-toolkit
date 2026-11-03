"""Spamhaus DBL lookup through the SYSTEM resolver.

An A query for ``<registrable>.dbl.spamhaus.org.`` (trailing dot, so Windows does
not append search suffixes) with socket.gethostbyname_ex, never DoH (Spamhaus
refuses public resolvers). Mapping:

* NXDOMAIN (socket.gaierror EAI_NONAME / Windows WSAHOST_NOT_FOUND 11001) ->
  NOT_LISTED (EXT-23 half APROBADO);
* 127.0.1.x -> LISTED, category from CODE_TABLE (FALLA);
* 127.255.255.252/254/255 (and 127.255.255.250/251, DQS key errors) -> REFUSED:
  a failed lookup, NEVER a verdict (Gris with the manual link);
* any other error or address -> ERROR (Gris). An error is never "not listed".

Hack signal: 127.0.1.4, .5, .6 and 127.0.1.102-106.
Behind Cloudflare WARP or another public resolver every lookup returns
127.255.255.254: the expected outcome there is REFUSED, never "not listed".

Control ("medir con control"): before trusting an NXDOMAIN, the client also
asks the Spamhaus test point ``test.dbl.spamhaus.org.`` (RFC 5782 section 5),
which is always listed as 127.0.1.2. If the control does not come back listed,
an NXDOMAIN for the target is not trusted: the result is ERROR
("control-failed"), because a resolver that cannot see the zone answers
NXDOMAIN for everything. A listing or a refusal code is kept as is.

In test mode the resolver is replaced by ServiceResolver, which asks the fake
API server (GET <test_dbl>?name=...) instead of DNS.
"""

from __future__ import annotations

import json
import socket
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING
from urllib.parse import urlencode

from .requestlog import Outcome, RequestRecord, utc_now_iso
from .scope import Purpose, RequestKind, ScopeError

if TYPE_CHECKING:
    from .httpclient import HttpClient
    from .requestlog import RequestLog
    from .scope import ScopeGuard

DBL_ZONE = "dbl.spamhaus.org."
CONTROL_NAME = "test.dbl.spamhaus.org."  # RFC 5782 test point: always 127.0.1.2
CONTROL_EXPECTED = "127.0.1.2"

CODE_TABLE: dict[str, str] = {
    "127.0.1.2": "spam",
    "127.0.1.4": "phish",
    "127.0.1.5": "malware",
    "127.0.1.6": "botnet",
    "127.0.1.102": "abused-legit-spam",
    "127.0.1.103": "abused-redirector",
    "127.0.1.104": "abused-legit-phish",
    "127.0.1.105": "abused-legit-malware",
    "127.0.1.106": "abused-legit-botnet",
}
HACK_SIGNAL_CODES: frozenset[str] = frozenset(
    {"127.0.1.4", "127.0.1.5", "127.0.1.6", "127.0.1.102", "127.0.1.103", "127.0.1.104", "127.0.1.105", "127.0.1.106"}
)
REFUSED_CODES: frozenset[str] = frozenset(
    {"127.255.255.250", "127.255.255.251", "127.255.255.252", "127.255.255.254", "127.255.255.255"}
)
# 127.0.1.255 means "IP queries are not allowed": an error, not a listing.
_NOT_A_LISTING = "127.0.1.255"
# Resolver errors that mean NXDOMAIN (POSIX EAI_NONAME; Windows WSAHOST_NOT_FOUND).
_NXDOMAIN_ERRNOS: frozenset[int] = frozenset({socket.EAI_NONAME, 11001})


class DblVerdict(StrEnum):
    NOT_LISTED = "not-listed"
    LISTED = "listed"
    REFUSED = "refused"
    ERROR = "error"


class NxDomain(Exception):
    """The resolver answered NXDOMAIN."""


@dataclass
class DblResult:
    query_name: str
    verdict: DblVerdict
    codes: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    hack_signal: bool = False
    mail_listing: bool = False  # 127.0.1.2 present: a spam-domain listing, the one that hurts mail delivery
    error: str | None = None
    control_ok: bool | None = None  # the test point came back listed (None: not asked)


def classify(addresses: list[str] | None, *, nxdomain: bool = False, error: str | None = None) -> DblResult:
    """Pure mapping from a lookup outcome to a DblResult (rules in the module docstring).

    ``query_name`` is left empty for the caller to fill.
    """
    if nxdomain:
        return DblResult("", DblVerdict.NOT_LISTED)
    if error:
        return DblResult("", DblVerdict.ERROR, error=error)
    codes: list[str] = []
    for a in addresses or []:
        a = str(a).strip()
        if a and a not in codes:
            codes.append(a)
    if not codes:
        return DblResult("", DblVerdict.ERROR, error="no-address")
    if any(c in REFUSED_CODES or c.startswith("127.255.255.") for c in codes):
        return DblResult("", DblVerdict.REFUSED, codes=codes, error="lookup refused by Spamhaus")
    listed = [c for c in codes if c.startswith("127.0.1.") and c != _NOT_A_LISTING]
    if listed and len(listed) == len(codes):
        return DblResult(
            "",
            DblVerdict.LISTED,
            codes=listed,
            categories=[CODE_TABLE.get(c, "unknown") for c in listed],
            hack_signal=any(c in HACK_SIGNAL_CODES for c in listed),
            mail_listing="127.0.1.2" in listed,
        )
    return DblResult("", DblVerdict.ERROR, codes=codes, error="unexpected-address")


def system_resolver(name: str) -> list[str]:
    """socket.gethostbyname_ex(name)[2]; raises NxDomain on NXDOMAIN, OSError otherwise."""
    try:
        return list(socket.gethostbyname_ex(name)[2])
    except socket.gaierror as exc:
        if exc.errno in _NXDOMAIN_ERRNOS:
            raise NxDomain(name) from exc
        raise OSError(f"resolver error {exc.errno}") from exc


class ServiceResolver:
    """Test-only resolver backed by the fake API server: GET <base>?name=<name>.

    The fake answers {"nxdomain": true} or {"addresses": ["127.0.1.2"]}.
    """

    def __init__(self, http: "HttpClient", base_url: str) -> None:
        self._http = http
        self._base = base_url

    def __call__(self, name: str) -> list[str]:
        resp = self._http.api_request("GET", self._base + "?" + urlencode({"name": name}), purpose=Purpose.TEST_SERVICE, timeout=10.0)
        if resp.error or resp.status != 200:
            raise OSError(f"fake resolver {resp.error or resp.status}")
        try:
            obj = json.loads(resp.text()[0])
        except ValueError as exc:
            raise OSError("fake resolver: not JSON") from exc
        if isinstance(obj, dict) and obj.get("nxdomain"):
            raise NxDomain(name)
        if isinstance(obj, dict) and isinstance(obj.get("addresses"), list):
            return [str(a) for a in obj["addresses"]]
        raise OSError("fake resolver: unexpected answer")


class DblClient:
    def __init__(
        self,
        guard: "ScopeGuard",
        log: "RequestLog",
        resolver: Callable[[str], list[str]] = system_resolver,
    ) -> None:
        self._guard = guard
        self._log = log
        self._resolver = resolver

    def _resolve(self, name: str) -> DblResult:
        """Guard-check, log and classify one name."""
        try:
            self._guard.check_dns(name)
        except ScopeError as exc:
            self._record(name, Outcome.REFUSED_SCOPE, None, str(exc))
            raise
        t0 = time.perf_counter()
        try:
            addresses = self._resolver(name)
        except NxDomain:
            result = classify(None, nxdomain=True)
            self._record(name, Outcome.OK, t0, None)
        except ScopeError:
            raise
        except OSError as exc:
            result = classify(None, error=str(exc)[:120] or "resolver-error")
            self._record(name, Outcome.ERROR, t0, result.error)
        except Exception as exc:  # never let a lookup stop the run
            result = classify(None, error=type(exc).__name__)
            self._record(name, Outcome.ERROR, t0, result.error)
        else:
            result = classify(addresses)
            self._record(name, Outcome.OK, t0, None)
        result.query_name = name
        return result

    def _record(self, name: str, outcome: str, t0: float | None, error: str | None) -> None:
        ms = round((time.perf_counter() - t0) * 1000.0, 1) if t0 is not None else None
        self._log.record(
            RequestRecord(
                seq=self._log.next_seq(),
                ts_utc=utc_now_iso(),
                kind=str(RequestKind.DNS),
                purpose=str(Purpose.DBL),
                method="DNS",
                url=f"dns:{name}",
                host=name.rstrip(".").lower(),
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

    def lookup(self, registrable: str) -> DblResult:
        """Guard-check and log ``<registrable>.dbl.spamhaus.org.``, resolve, classify."""
        name = f"{registrable.strip().rstrip('.').lower()}.{DBL_ZONE}"
        result = self._resolve(name)
        if result.verdict is DblVerdict.NOT_LISTED:
            control = self._resolve(CONTROL_NAME)
            result.control_ok = control.verdict is DblVerdict.LISTED and CONTROL_EXPECTED in control.codes
            if not result.control_ok:
                failed = DblResult(
                    name,
                    DblVerdict.REFUSED if control.verdict is DblVerdict.REFUSED else DblVerdict.ERROR,
                    codes=control.codes,
                    error="control-failed",
                    control_ok=False,
                )
                return failed
        return result
