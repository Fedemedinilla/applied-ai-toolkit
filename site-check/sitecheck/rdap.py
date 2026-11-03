"""Domain expiry through RDAP. Never WHOIS scraping.

Generic TLDs: GET https://rdap.org/domain/<D> with ``Accept:
application/rdap+json``; rdap.org answers 302 to the authoritative server
(e.g. rdap.verisign.com), followed by hand through the guard. ``.ar``: GET
https://rdap.nic.ar/domain/<D> directly. ``.edu.ar`` is managed by ARIU, not
NIC Argentina: expect 404 or no data.

Accept only a JSON response that has an event with eventAction "expiration";
anything else (404, 429, timeout, HTML, no such event) is a result with
``expiration`` None and a reason, which EXT-13 turns into Gris "medir a mano".

Personal data: NEVER store entities, vcardArray,
remarks or any holder data. scrub_rdap keeps only ldhName, status, events
(eventAction, eventDate) and secureDNS.delegationSigned before anything is
written to rdap.json or datos.json.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from . import artifacts as art
from . import domains
from .scope import Purpose, ScopeError

if TYPE_CHECKING:
    from .artifacts import ArtifactStore
    from .endpoints import Endpoints
    from .httpclient import HttpClient

AR_SUFFIX = ".ar"
KEEP_KEYS: frozenset[str] = frozenset({"ldhName", "status", "events", "secureDNS", "objectClassName"})
TIMEOUT_SECONDS = 20.0


@dataclass
class RdapResult:
    domain: str
    tld: str  # last label, or "edu.ar"-style suffix for .ar zones
    server: str | None = None  # host that answered
    http_status: int | None = None
    expiration: str | None = None  # ISO 8601 UTC from the expiration event
    days_left: int | None = None
    status: list[str] = field(default_factory=list)  # e.g. ["client transfer prohibited"]
    delegation_signed: bool | None = None
    error: str | None = None  # "no-service", "http-404", "timeout", "no-expiration-event", "not-json"


def _tld_of(registrable: str) -> str:
    labels = registrable.lower().split(".")
    last_two = ".".join(labels[-2:])
    if last_two in domains.PUBLIC_SUFFIXES:
        return last_two
    return labels[-1]


class RdapClient:
    def __init__(self, http: "HttpClient", endpoints: "Endpoints", artifacts: "ArtifactStore") -> None:
        self._http = http
        self._endpoints = endpoints
        self._artifacts = artifacts

    def lookup(self, registrable: str, now_utc: dt.datetime) -> RdapResult:
        """Query RDAP for ``registrable``, store the scrubbed JSON as rdap.json, parse it."""
        d = registrable.strip().rstrip(".").lower()
        url = rdap_url(d, self._endpoints)
        result = RdapResult(domain=d, tld=_tld_of(d))
        obj: Any = None
        try:
            resp = self._http.api_request(
                "GET",
                url,
                purpose=Purpose.RDAP,
                headers={"Accept": "application/rdap+json, application/json"},
                timeout=TIMEOUT_SECONDS,
                follow_redirects=True,
            )
        except ScopeError:
            raise
        except Exception as exc:  # an RDAP failure is a grey row, never a crash
            result.error = type(exc).__name__
            resp = None
        if resp is not None:
            result.server = domains.host_of(resp.final_url) if resp.final_url else None
            result.http_status = resp.status
            if resp.error:
                result.error = "timeout" if resp.error == "timeout" else resp.error
            elif resp.left_site or resp.status in (301, 302, 303, 307, 308):
                result.error = "redirect-not-followed"
            elif resp.status != 200:
                result.error = f"http-{resp.status}"
            else:
                try:
                    obj = json.loads(resp.text()[0])
                except ValueError:
                    obj = None
                if not isinstance(obj, dict):
                    obj = None
                    result.error = "not-json"
                else:
                    parsed = parse_rdap(obj, d, now_utc)
                    result.expiration = parsed.expiration
                    result.days_left = parsed.days_left
                    result.status = parsed.status
                    result.delegation_signed = parsed.delegation_signed
                    result.error = parsed.error
        self._artifacts.put_json(
            art.RDAP,
            {
                "consulta": {
                    "dominio": d,
                    "servidor": result.server,
                    "estado_http": result.http_status,
                    "error": result.error,
                },
                "respuesta": scrub_rdap(obj) if obj is not None else None,
            },
        )
        return result


def rdap_url(registrable: str, endpoints: "Endpoints") -> str:
    """rdap_ar + D for names under .ar, else rdap_bootstrap + D."""
    d = registrable.strip().rstrip(".").lower()
    base = endpoints.rdap_ar if d.endswith(AR_SUFFIX) else endpoints.rdap_bootstrap
    return base + d


def scrub_rdap(obj: dict[str, Any]) -> dict[str, Any]:
    """Return a copy with only KEEP_KEYS (events reduced to eventAction/eventDate). No entities ever."""
    out: dict[str, Any] = {}
    if not isinstance(obj, dict):
        return out
    for key in ("objectClassName", "ldhName"):
        if isinstance(obj.get(key), str):
            out[key] = obj[key]
    status = obj.get("status")
    if isinstance(status, list):
        out["status"] = [s for s in status if isinstance(s, str)]
    events = obj.get("events")
    if isinstance(events, list):
        out["events"] = [
            {"eventAction": e.get("eventAction"), "eventDate": e.get("eventDate")}
            for e in events
            if isinstance(e, dict) and isinstance(e.get("eventAction"), str)
        ]
    secure = obj.get("secureDNS")
    if isinstance(secure, dict) and isinstance(secure.get("delegationSigned"), bool):
        out["secureDNS"] = {"delegationSigned": secure["delegationSigned"]}
    return out


def _parse_date(value: str) -> dt.datetime | None:
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(v)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def parse_rdap(obj: dict[str, Any], registrable: str, now_utc: dt.datetime) -> RdapResult:
    """Extract expiration (ignoring 'last update of RDAP database'), status and DNSSEC flag."""
    d = registrable.strip().rstrip(".").lower()
    result = RdapResult(domain=d, tld=_tld_of(d))
    if not isinstance(obj, dict):
        result.error = "not-json"
        return result
    status = obj.get("status")
    if isinstance(status, list):
        result.status = [s for s in status if isinstance(s, str)]
    secure = obj.get("secureDNS")
    if isinstance(secure, dict) and isinstance(secure.get("delegationSigned"), bool):
        result.delegation_signed = secure["delegationSigned"]
    expiration: dt.datetime | None = None
    found_event = False
    events = obj.get("events")
    for e in events if isinstance(events, list) else []:
        if not isinstance(e, dict) or str(e.get("eventAction", "")).strip().lower() != "expiration":
            continue
        found_event = True
        date = e.get("eventDate")
        expiration = _parse_date(date) if isinstance(date, str) else None
        break
    if not found_event:
        result.error = "no-expiration-event"
        return result
    if expiration is None:
        result.error = "bad-expiration-date"
        return result
    now = now_utc if now_utc.tzinfo is not None else now_utc.replace(tzinfo=dt.UTC)
    result.expiration = expiration.isoformat()
    result.days_left = math.floor((expiration - now).total_seconds() / 86400)
    return result
