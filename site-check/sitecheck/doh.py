"""DNS over HTTPS (JSON) for the mail checks (EXT-05), with control.

Primary: https://dns.google/resolve?name=<n>&type=<t>. Fallback on HTTP error,
timeout or Status 2 (SERVFAIL): https://cloudflare-dns.com/dns-query with
``accept: application/dns-json``. Record which resolver answered. 10 s timeout,
one query per record type, no retry loops.

Normalization: strip trailing dots from names; filter Answer by
the numeric type asked (skip CNAME hops, type 5); TXT data may be unquoted
(Google) or quoted, possibly in several quoted segments (Cloudflare, long
records): join the segments and unescape \\" (RFC 7208 3.3). NODATA (Status 0
with no matching Answer) and NXDOMAIN (Status 3) are different states.

Control: the same queries for the control domain (SITE_CHECK_CONTROL_DOMAIN, see endpoints.py) must
return its SPF, DMARC and MX; if the control fails, EXT-05 is NO_VERIFICADO.

Organizational domain: a receiver that finds
no DMARC record at the sender's domain falls back to the ORGANIZATIONAL domain
of the real Public Suffix List (RFC 7489 6.6.3). This tool treats some zones as
public suffixes that the real PSL does not (LOCAL_ONLY_SUFFIXES: esc.edu.ar), so
for ejemplo.esc.edu.ar Gmail looks up _dmarc.esc.edu.ar. mail_dns then asks
that one extra TXT question (same resolvers, same scope guard and request log)
and keeps it in MailDns.org_domain / org_dmarc. For every other domain the
organizational domain is the domain itself and nothing more is asked.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

from . import domains
from .scope import Purpose, ScopeError

if TYPE_CHECKING:
    from .httpclient import HttpClient, Response

RTYPE_NUMBERS: dict[str, int] = {"A": 1, "CNAME": 5, "MX": 15, "TXT": 16, "AAAA": 28, "HTTPS": 65, "CAA": 257}

# MX host suffix -> provider; DKIM selectors documented by that provider only
# (never a dictionary of selectors).
MX_PROVIDERS: dict[str, str] = {
    "google.com": "google",
    "googlemail.com": "google",
    "outlook.com": "microsoft",
    "protection.outlook.com": "microsoft",
}
DKIM_SELECTORS: dict[str, tuple[str, ...]] = {
    "google": ("google",),
    "microsoft": ("selector1", "selector2"),
}

# Suffixes this tool treats as public (domains.PUBLIC_SUFFIXES) that the real
# Public Suffix List does not list: a receiver's DMARC fallback goes one label up.
LOCAL_ONLY_SUFFIXES: frozenset[str] = frozenset({"esc.edu.ar"})

TIMEOUT_SECONDS = 10.0
RESOLVER_GOOGLE = "dns.google"
RESOLVER_CLOUDFLARE = "cloudflare"
_GENERIC_RDATA_RE = re.compile(r"^\\#\s+(\d+)\s*([0-9A-Fa-f\s]*)$")


class DnsStatus(StrEnum):
    NOERROR = "NOERROR"  # with matching records
    NODATA = "NODATA"  # NOERROR without matching records
    NXDOMAIN = "NXDOMAIN"
    SERVFAIL = "SERVFAIL"
    ERROR = "ERROR"  # HTTP error, timeout, bad JSON on both resolvers


@dataclass
class DnsAnswer:
    name: str
    rtype: str
    status: DnsStatus
    records: list[str] = field(default_factory=list)  # normalized data strings
    resolver: str | None = None  # "dns.google" | "cloudflare"
    error: str | None = None


@dataclass
class MailDns:
    """Everything EXT-05 reads for one domain."""

    domain: str
    txt: DnsAnswer
    dmarc: DnsAnswer  # TXT at _dmarc.<domain>
    mx: DnsAnswer
    provider: str | None = None  # "google", "microsoft", "otro" or None without MX
    dkim: dict[str, DnsAnswer] = field(default_factory=dict)  # selector -> TXT at <sel>._domainkey.<domain>
    org_domain: str | None = None  # real-PSL organizational domain when it differs from ``domain``
    org_dmarc: DnsAnswer | None = None  # TXT at _dmarc.<org_domain>, asked only when org_domain is set


def organizational_domain(domain: str) -> str | None:
    """The real-PSL organizational domain of ``domain`` when it differs from it, else None.

    Uses the tool's embedded suffixes minus LOCAL_ONLY_SUFFIXES (the real PSL does
    not list them): ``ejemplo.esc.edu.ar`` -> ``esc.edu.ar``; ``colegio-ejemplo.edu.ar``
    -> None; ``colegio.test`` -> None. Pure, no network.
    """
    try:
        d = domains.normalize_host(domain)
    except ValueError:
        return None
    labels = d.split(".")
    suffixes = (domains.PUBLIC_SUFFIXES - LOCAL_ONLY_SUFFIXES) | domains.PLATFORM_SUFFIXES
    suffix_labels = 1  # no listed suffix: the TLD, like domains.registrable_domain
    for n in range(len(labels) - 1, 0, -1):  # longest first
        if ".".join(labels[-n:]) in suffixes:
            suffix_labels = n
            break
    if len(labels) <= suffix_labels:
        return None
    org = ".".join(labels[-(suffix_labels + 1):])
    return org if org != d else None


@dataclass
class DnsBundle:
    site: MailDns | None
    control: MailDns | None
    control_ok: bool = False  # control returned SPF, DMARC and MX


class DohClient:
    def __init__(self, http: "HttpClient", google_endpoint: str, cloudflare_endpoint: str) -> None:
        self._http = http
        self._google = google_endpoint
        self._cloudflare = cloudflare_endpoint

    def _ask(self, endpoint: str, name: str, rtype: str, resolver: str) -> DnsAnswer:
        url = endpoint + "?" + urlencode({"name": name, "type": rtype})
        try:
            resp: Response = self._http.api_request(
                "GET", url, purpose=Purpose.DOH, headers={"Accept": "application/dns-json"}, timeout=TIMEOUT_SECONDS
            )
        except ScopeError:
            raise
        except Exception as exc:  # a resolver failure is a state, never a crash
            return DnsAnswer(name, rtype, DnsStatus.ERROR, resolver=resolver, error=type(exc).__name__)
        if resp.error or resp.status != 200:
            return DnsAnswer(name, rtype, DnsStatus.ERROR, resolver=resolver, error=resp.error or f"http-{resp.status}")
        try:
            obj = json.loads(resp.text()[0])
        except ValueError:
            return DnsAnswer(name, rtype, DnsStatus.ERROR, resolver=resolver, error="not-json")
        if not isinstance(obj, dict):
            return DnsAnswer(name, rtype, DnsStatus.ERROR, resolver=resolver, error="not-json")
        return parse_doh_json(obj, name, rtype, resolver)

    def query(self, name: str, rtype: str) -> DnsAnswer:
        """One question, Google first then Cloudflare as described above."""
        n = name.strip().rstrip(".").lower()
        t = rtype.strip().upper()
        first = self._ask(self._google, n, t, RESOLVER_GOOGLE)
        if first.status not in (DnsStatus.ERROR, DnsStatus.SERVFAIL):
            return first
        second = self._ask(self._cloudflare, n, t, RESOLVER_CLOUDFLARE)
        if second.status is DnsStatus.ERROR:
            second.error = f"{RESOLVER_GOOGLE}: {first.error or first.status}; {RESOLVER_CLOUDFLARE}: {second.error}"
        return second

    def mail_dns(self, domain: str) -> MailDns:
        """TXT, _dmarc TXT and MX of ``domain``; then the DKIM selectors of the MX provider;
        then, only when the real-PSL organizational domain differs, its _dmarc TXT."""
        d = domain.strip().rstrip(".").lower()
        txt = self.query(d, "TXT")
        dmarc = self.query(f"_dmarc.{d}", "TXT")
        mx = self.query(d, "MX")
        provider = mx_provider(mx.records) if mx.status is DnsStatus.NOERROR else None
        result = MailDns(domain=d, txt=txt, dmarc=dmarc, mx=mx, provider=provider)
        for selector in DKIM_SELECTORS.get(provider or "", ()):
            result.dkim[selector] = self.query(f"{selector}._domainkey.{d}", "TXT")
        org = organizational_domain(d)
        if org is not None:
            result.org_domain = org
            result.org_dmarc = self.query(f"_dmarc.{org}", "TXT")
        return result


def _strip_dot(value: str) -> str:
    return value.strip().rstrip(".")


def _normalize_mx(data: str) -> str:
    parts = data.split()
    if len(parts) >= 2:
        return f"{parts[0]} {_strip_dot(parts[1]).lower()}"
    return _strip_dot(data).lower()


def _normalize_caa(data: str) -> str:
    """CAA in presentation form ('0 issue "letsencrypt.org"'); RFC 3597 generic hex is decoded."""
    m = _GENERIC_RDATA_RE.match(data.strip())
    if not m:
        return data.strip()
    try:
        raw = bytes.fromhex("".join(m.group(2).split()))
        flags, tag_len = raw[0], raw[1]
        tag = raw[2 : 2 + tag_len].decode("ascii", "replace")
        value = raw[2 + tag_len :].decode("utf-8", "replace")
    except (ValueError, IndexError):
        return data.strip()
    return f'{flags} {tag} "{value}"'


def parse_doh_json(obj: dict[str, Any], name: str, rtype: str, resolver: str) -> DnsAnswer:
    """Turn one DoH JSON answer (Google or Cloudflare shape) into a DnsAnswer."""
    n = name.strip().rstrip(".").lower()
    t = rtype.strip().upper()
    status = obj.get("Status") if isinstance(obj, dict) else None
    if isinstance(status, bool) or not isinstance(status, int):
        return DnsAnswer(n, t, DnsStatus.ERROR, resolver=resolver, error="no-status")
    if status == 3:
        return DnsAnswer(n, t, DnsStatus.NXDOMAIN, resolver=resolver)
    if status == 2:
        return DnsAnswer(n, t, DnsStatus.SERVFAIL, resolver=resolver)
    if status != 0:
        return DnsAnswer(n, t, DnsStatus.ERROR, resolver=resolver, error=f"rcode-{status}")
    wanted = RTYPE_NUMBERS.get(t)
    records: list[str] = []
    answers = obj.get("Answer")
    for a in answers if isinstance(answers, list) else []:
        if not isinstance(a, dict):
            continue
        a_type = a.get("type")
        if wanted is not None and a_type != wanted:
            continue  # CNAME hops and other types
        data = a.get("data")
        if not isinstance(data, str):
            continue
        if t == "TXT":
            records.append(normalize_txt(data))
        elif t == "MX":
            records.append(_normalize_mx(data))
        elif t == "CAA":
            records.append(_normalize_caa(data))
        elif t in ("CNAME", "NS", "PTR"):
            records.append(_strip_dot(data).lower())
        else:
            records.append(data.strip())
    if not records:
        return DnsAnswer(n, t, DnsStatus.NODATA, resolver=resolver)
    return DnsAnswer(n, t, DnsStatus.NOERROR, records=records, resolver=resolver)


def normalize_txt(data: str) -> str:
    """Join quoted TXT segments ('"v=spf1 a" " -all"' -> 'v=spf1 a -all'); unquoted data as-is."""
    s = data.strip()
    if not s.startswith('"'):
        return s
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] != '"':
            i += 1  # whitespace between segments
            continue
        i += 1
        while i < n and s[i] != '"':
            ch = s[i]
            if ch == "\\" and i + 1 < n:
                nxt = s[i + 1]
                if nxt.isdigit() and i + 3 < n and s[i + 1 : i + 4].isdigit():
                    out.append(chr(int(s[i + 1 : i + 4])))  # \DDD decimal escape
                    i += 4
                    continue
                out.append(nxt)
                i += 2
                continue
            out.append(ch)
            i += 1
        i += 1  # closing quote
    return "".join(out)


def mx_provider(mx_records: list[str]) -> str | None:
    """Provider from MX data like '10 aspmx.l.google.com.'; "otro" if unknown; None if no MX."""
    parsed: list[tuple[int, str]] = []
    for record in mx_records or []:
        parts = record.split()
        if not parts:
            continue
        if len(parts) >= 2 and parts[0].isdigit():
            pref, host = int(parts[0]), parts[1]
        else:
            pref, host = 65535, parts[-1]
        parsed.append((pref, _strip_dot(host).lower()))
    if not parsed:
        return None
    parsed.sort(key=lambda p: p[0])
    suffixes = sorted(MX_PROVIDERS, key=len, reverse=True)
    for _pref, host in parsed:
        for suffix in suffixes:
            if host == suffix or host.endswith("." + suffix):
                return MX_PROVIDERS[suffix]
        return "otro"  # the preferred exchanger decides
    return "otro"
