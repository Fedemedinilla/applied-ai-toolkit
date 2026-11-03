"""Observations: everything the collector measured, the single input of the checks.

Raw responses are kept (Response objects) so the checks parse what they need
(htmlextract.extract_page on home/interna bodies). Nothing here is a verdict:
states are decided in checks/. A field that is None means "not obtained"; the
reason is in ``skipped`` or in the object's own ``error``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .challenge import ChallengeEvent
    from .dbl import DblResult
    from .doh import DnsAnswer, DnsBundle
    from .httpclient import Response
    from .imagesize import ImageInfo
    from .links import LinkSelection, LinkSet
    from .observatory import ObservatoryResult
    from .psi import FieldMetrics, PsiSeries
    from .rdap import RdapResult
    from .robots import RobotsState, RobotsTxt
    from .sitemapfeed import FeedDoc, SitemapDoc
    from .tlsprobe import TlsResult
    from .wpapi import WpVersionStatus


@dataclass
class PageFetch:
    """One HTML page fetched with its body (home, interna, form page, hreflang alternate)."""

    role: str  # "home", "interna", "formulario", "hreflang:<code>"
    url: str
    response: "Response | None" = None
    links: "LinkSet | None" = None  # links.discover_links on the body (None if unusable)
    body_artifact: str | None = None
    headers_artifact: str | None = None
    note: str | None = None  # e.g. "interna no enlazada desde la portada"


@dataclass
class VariantProbe:
    """EXT-17: one of the four scheme/host variants and its redirect chain."""

    start_url: str
    statuses: list[int] = field(default_factory=list)  # status of each response in the chain
    urls: list[str] = field(default_factory=list)  # URL of each response in the chain
    final_url: str | None = None
    final_status: int | None = None
    hops: int = 0  # redirects followed to reach final_url (or H)
    reached_canonical: bool = False  # the chain reached H (possibly via stop_at)
    left_site: bool = False
    error: str | None = None  # "no resuelve", "timeout", "refused", "tls", ...
    challenged: bool = False


@dataclass
class TtfbSample:
    url: str
    ttfb_ms: float | None
    status: int | None
    challenged: bool = False
    error: str | None = None


@dataclass
class TtfbSeries:
    """EXT-20: site and control samples, interleaved site, control, site, control, ..."""

    site: list[TtfbSample] = field(default_factory=list)
    control: list[TtfbSample] = field(default_factory=list)
    # The control URL is on the measured site (the self-check): no control samples
    # were taken, so the site is never compared with itself.
    control_is_site: bool = False


@dataclass
class RobotsFetch:
    url: str
    response: "Response | None" = None
    state: "RobotsState | None" = None
    parsed: "RobotsTxt | None" = None


@dataclass
class SitemapFetch:
    url: str
    declared: bool  # True: from robots.txt; False: one of the standard paths
    response: "Response | None" = None
    valid: bool = False  # sitemapfeed.looks_like_sitemap
    doc: "SitemapDoc | None" = None
    unreadable: bool = False  # a gzipped sitemap that could not be decompressed
    soft_404: bool = False  # an HTML "not found" page served with 200
    evidence_body: bytes | None = None  # what goes to the evidence (decompressed for a .xml.gz)
    child: "SitemapFetch | None" = None  # first child when this is an index


@dataclass
class FeedFetch:
    url: str
    response: "Response | None" = None
    doc: "FeedDoc | None" = None


@dataclass
class OgImageFetch:
    url: str
    response: "Response | None" = None  # body capped at 256 KiB
    image: "ImageInfo | None" = None
    error: str | None = None


@dataclass
class LinkProbe:
    """VIS-09: one home link checked with headers only, redirects by hand (<= 5, same site)."""

    url: str
    statuses: list[int] = field(default_factory=list)
    final_url: str | None = None
    final_status: int | None = None
    hops: int = 0
    left_site: bool = False
    challenged: bool = False
    error: str | None = None
    reused_from: str | None = None  # "interna", "hreflang:<code>"... when not requested again
    private: bool = False  # redirects to a login or admin page


@dataclass
class LinkSurvey:
    selection: "LinkSelection | None" = None
    probes: list[LinkProbe] = field(default_factory=list)


@dataclass
class SkippedRequest:
    purpose: str
    url: str
    # "budget", "blocked", "not-linked", "no-https", "no-contact"; also "off-site"
    # (declared sitemap or feed on another domain), "not-admitted" (refused by the
    # scope guard) and "robots-<RobotsState>" (no sitemap tried: robots.txt not valid).
    reason: str


@dataclass
class MailDomainCheck:
    """VIS-21: the DNS answers that say whether one mailto: domain can receive mail.

    Asked in the RFC 5321 order: MX first; A, then AAAA, only when the MX
    question found no record (NODATA), because a domain with no MX still
    receives mail at its A/AAAA address. The verdict is decided in
    checks/contact.py, never here. Only the domain is kept, plus the local part
    of an institutional role address (links.ROLE_LOCAL_PARTS: "admisiones" of
    admisiones@colegio.test) and the page it was first seen on; a person's
    address never.
    """

    domain: str  # ASCII form (punycode), lowercased
    pages: list[str] = field(default_factory=list)  # where it was published: "inicio", "interna"
    role_local: str | None = None  # the first institutional role local part on this domain, or None
    role_page: str | None = None  # "inicio" or "interna": where that role address was first seen
    mx: "DnsAnswer | None" = None
    a: "DnsAnswer | None" = None
    aaaa: "DnsAnswer | None" = None
    mx_from_site: bool = False  # the MX answer is the one of the site's own mail DNS (no new query)


@dataclass
class MailDomainSurvey:
    """VIS-21: the mailto: domains of the home and the interna, and what was asked about each."""

    checked: list[MailDomainCheck] = field(default_factory=list)
    free_mail: list[str] = field(default_factory=list)  # gmail.com and the like: never asked (domains.FREE_MAIL_DOMAINS)
    over_cap: list[str] = field(default_factory=list)  # beyond MAX_MAIL_DOMAINS: not asked
    # Why nothing was asked although there were domains: "shared-domain",
    # "no-control" (the control lookup of the mail DNS failed), "dns-error".
    not_queried: str | None = None
    # The interna's links were read (it exists, answered and is not truncated).
    interna_read: bool = False
    # What the home's anchor says the interna is (links.interna_kind): "contacto",
    # "admisiones" or None; the VIS-21 sentence says "la página de contacto" only for "contacto".
    interna_kind: str | None = None


@dataclass
class Observations:
    """The whole measurement of one run."""

    input_url: str
    registrable: str  # the SITE domain the run measures (domains.site_domain); D for D and www.D
    started_utc: str = ""
    finished_utc: str = ""
    key_present: bool = False

    # The domain of the organization or platform the site lives under
    # (domains.shared_parent), or None when the site owns its domain. Its mail
    # DNS, expiry and blocklist status are not the site's.
    shared_parent: str | None = None

    # PSI and field data (before any site request)
    psi: "PsiSeries | None" = None
    crux_field: "FieldMetrics | None" = None  # CrUX fallback, already merged into psi.field_data

    # DNS, RDAP, DBL (before any site request)
    dns: "DnsBundle | None" = None
    rdap: "RdapResult | None" = None
    dbl: "DblResult | None" = None

    # Site phase
    canonical_url: str | None = None  # H
    canonical_host: str | None = None
    other_host: str | None = None  # the apex/www counterpart of the canonical host
    home: PageFetch | None = None  # load 1
    home_reloads: list["Response"] = field(default_factory=list)  # loads 2 and 3
    ttfb: TtfbSeries = field(default_factory=TtfbSeries)
    variants: list[VariantProbe] = field(default_factory=list)
    tls: list["TlsResult"] = field(default_factory=list)  # canonical host first
    robots: RobotsFetch | None = None
    sitemaps: list[SitemapFetch] = field(default_factory=list)  # in the order tried
    feed: FeedFetch | None = None
    interna: PageFetch | None = None
    interna_source: str | None = None  # "cli" | "auto" | None
    form_page: PageFetch | None = None
    og_image: OgImageFetch | None = None
    hreflang_pages: list[PageFetch] = field(default_factory=list)
    links: LinkSurvey = field(default_factory=LinkSurvey)

    # After the site phase
    wp_status: "WpVersionStatus | None" = None
    observatory: "ObservatoryResult | None" = None
    # VIS-21: None when the step did not run (home not read, run cut short).
    mail_domains: MailDomainSurvey | None = None

    # Run health
    home_unreachable: bool = False  # exit 3: no usable home from the first request
    # Why the home was not read, when it was not: "tls-invalid"
    # (a browser shows a warning: EXT-07 measured, the run goes on), "tls-unverified",
    # "left-site" (moved to another domain), "private" (redirects to a login page).
    home_problem: str | None = None
    home_redirect_target: str | None = None  # where the home redirected (left-site / private)
    blocked: bool = False  # host cut after a repeated challenge
    block_cause: str | None = None  # "challenge" | "throttle" (HttpClient.cut_cause)
    budget_exhausted: bool = False
    final_host_no_contact: bool = False  # the canonical host is on the exclusion list
    challenge_events: list["ChallengeEvent"] = field(default_factory=list)
    skipped: list[SkippedRequest] = field(default_factory=list)
    artifacts_written: dict[str, bool] = field(default_factory=dict)
    site_requests: int = 0
    errors: list[str] = field(default_factory=list)  # unexpected errors, English, redacted

    def skipped_reason(self, purpose: str) -> str | None:
        """First skip reason recorded for ``purpose`` (scope.Purpose value), or None."""
        wanted = str(purpose)
        for s in self.skipped:
            if s.purpose == wanted:
                return s.reason
        return None
