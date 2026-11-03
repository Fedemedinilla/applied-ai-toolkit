"""Wiring: builds every network object of a run from a RunConfig.

The pipeline calls build_services once per run (never in --rerender). Tests build
a Services by hand with fakes, or call build_services with a test-mode RunConfig
(loopback site + fake API server). This is the single place where test mode
changes behaviour: loopback transport, Endpoints.for_test, zero waits, the
ServiceTlsProber / ServiceResolver fakes and the fake key.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from . import domains
from .artifacts import ArtifactStore
from .challenge import ChallengeDetector
from .credentials import Redactor, load_api_key
from .crux import CruxClient
from .dbl import DblClient, ServiceResolver, system_resolver
from .doh import DohClient
from .endpoints import Endpoints
from .httpclient import ClientConfig, HttpClient, LoopbackRoute
from .observatory import ObservatoryClient
from .psi import RETRY_WAIT_SECONDS, PsiClient
from .rdap import RdapClient
from .requestlog import RequestLog
from .scope import ScopeGuard
from .tlsprobe import ServiceTlsProber, TlsProber
from .wpapi import WpStableCheckClient

if TYPE_CHECKING:
    from .config import RunConfig
    from .credentials import ApiKey

REQUESTS_LOG_NAME = "requests.log"  # same name as outputs.REQUESTS_LOG; NET does not import OUT
LOOPBACK_HOSTS: frozenset[str] = frozenset({"127.0.0.1", "::1", "localhost"})
# Used when a test-mode config omits one hook: a loopback port where nothing
# answers, so the request fails locally instead of reaching any real host.
UNUSED_LOOPBACK = "127.0.0.1:9"


@dataclass
class Services:
    """Every network-facing object of one run, sharing one guard, log and store."""

    endpoints: "Endpoints"
    key: "ApiKey"
    redactor: "Redactor"
    guard: "ScopeGuard"
    log: "RequestLog"
    artifacts: "ArtifactStore"
    http: "HttpClient"
    psi: "PsiClient"
    crux: "CruxClient"
    doh: "DohClient"
    rdap: "RdapClient"
    dbl: "DblClient"
    tls: "TlsProber | ServiceTlsProber"
    wp: "WpStableCheckClient"
    observatory: "ObservatoryClient | None"
    sleeper: Callable[[float], None] = time.sleep


def _parse_loopback(value: str) -> LoopbackRoute:
    """'127.0.0.1:PORT' (or '[::1]:PORT') -> LoopbackRoute; ValueError otherwise."""
    parts = urlsplit("//" + value.strip())
    host = (parts.hostname or "").lower()
    if host not in LOOPBACK_HOSTS:
        raise ValueError("--test-loopback must be a loopback address")
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError("--test-loopback needs a valid port") from exc
    if not port:
        raise ValueError("--test-loopback needs a port")
    return LoopbackRoute(host="127.0.0.1" if host == "localhost" else host, port=port)


def build_services(
    config: "RunConfig",
    evidence_dir: Path | None,
    *,
    sleeper: Callable[[float], None] = time.sleep,
) -> Services:
    """Build the services for ``config``, writing evidence and requests.log under ``evidence_dir``.

    Production: Endpoints, real key (credentials.load_api_key), real TLS and
    DBL probes, ClientConfig defaults. Test mode: validates that the target host
    ends in ".test" and that both hooks are loopback (ValueError otherwise),
    Endpoints.for_test(config.test_services), LoopbackRoute from
    config.test_loopback, ClientConfig with pace_seconds=0, pace_jitter=0,
    challenge_wait=0, the fake key, ServiceTlsProber and ServiceResolver.
    ``observatory`` is None unless config.observatory.
    """
    input_host = domains.host_of(config.url)
    # The scope of the run is the SITE domain: D for D and www.D, the input host
    # itself when the site lives under someone else's domain.
    registrable = domains.site_domain(input_host)
    test = config.test_mode
    # --max-requests can only LOWER the budget and --pause can only make the pause
    # LONGER (config.py): clamp again here so no option makes the tool more aggressive.
    defaults = ClientConfig()
    budget = int(getattr(config, "site_budget", defaults.site_budget) or defaults.site_budget)
    site_budget = max(1, min(defaults.site_budget, budget))
    pace = float(getattr(config, "pace_seconds", defaults.pace_seconds) or defaults.pace_seconds)
    pace_seconds = max(defaults.pace_seconds, pace)

    if test:
        if not input_host.endswith(".test"):
            raise ValueError("test hooks need a target under .test (RFC 6761)")
        route = _parse_loopback(config.test_loopback or UNUSED_LOOPBACK)
        endpoints = Endpoints.for_test(config.test_services or ("http://" + UNUSED_LOOPBACK))
        key = load_api_key(test_mode=True)  # never the real key in test mode
        client_config = ClientConfig(
            pace_seconds=0.0,
            pace_jitter=0.0,
            challenge_wait=0.0,
            challenge_pace=0.0,
            throttle_wait_cap=0.0,
            site_budget=site_budget,
            loopback=route,
        )
        retry_wait = 0.0
    else:
        endpoints = Endpoints()
        if not endpoints.control_domain:
            # The CLI checks this first; a direct caller gets the same refusal.
            raise ValueError("a real run needs SITE_CHECK_CONTROL_DOMAIN (a site the operator owns)")
        key = load_api_key(test_mode=False)
        client_config = ClientConfig(
            pace_seconds=pace_seconds,
            challenge_pace=max(defaults.challenge_pace, 2 * pace_seconds),
            site_budget=site_budget,
        )
        retry_wait = RETRY_WAIT_SECONDS

    redactor = Redactor([key.value])
    guard = ScopeGuard(registrable, config.url, endpoints, test_loopback=test, observatory=config.observatory)
    if evidence_dir is not None:
        evidence_dir.mkdir(parents=True, exist_ok=True)
    log = RequestLog(evidence_dir / REQUESTS_LOG_NAME if evidence_dir is not None else None, redactor)
    artifacts = ArtifactStore(evidence_dir, redactor)
    http = HttpClient(guard, log, ChallengeDetector(), redactor, client_config, sleeper=sleeper)

    if test:
        assert endpoints.test_tls is not None and endpoints.test_dbl is not None
        tls: TlsProber | ServiceTlsProber = ServiceTlsProber(guard, http, endpoints.test_tls)
        dbl = DblClient(guard, log, resolver=ServiceResolver(http, endpoints.test_dbl))
    else:
        tls = TlsProber(guard, http, log)
        dbl = DblClient(guard, log, resolver=system_resolver)

    return Services(
        endpoints=endpoints,
        key=key,
        redactor=redactor,
        guard=guard,
        log=log,
        artifacts=artifacts,
        http=http,
        psi=PsiClient(http, endpoints.psi, key, artifacts, registrable, sleeper=sleeper, retry_wait=retry_wait),
        crux=CruxClient(http, endpoints.crux, key, artifacts),
        doh=DohClient(http, endpoints.doh_google, endpoints.doh_cloudflare),
        rdap=RdapClient(http, endpoints, artifacts),
        dbl=dbl,
        tls=tls,
        wp=WpStableCheckClient(http, endpoints.wp_stable_check, artifacts),
        observatory=ObservatoryClient(http, endpoints.observatory, artifacts) if config.observatory else None,
        sleeper=sleeper,
    )
