"""What a page links: the input of the scope guard's allow-list.

A small, independent html.parser pass that extracts ONLY what decides further
requests (anchors, og:image, feeds, hreflang alternates, canonical, assets). The
full measurement extraction (titles, headings, JSON-LD...) is htmlextract.py
; keeping this one separate means the legal boundary does not depend on
the measurement parser. Both resolve URLs with domains.resolve_url.

Also holds the two selection rules that decide requests: which page is the
"interna" when --inner-page is not given, and which home links VIS-09 checks.

Contact paths:

* The collector keeps the visible text of each anchor (``LinkSet.anchor_texts``)
  and the DOMAINS of its ``mailto:`` links (``LinkSet.mail_domains``). The
  collector queries those domains' MX and A/AAAA records over DoH for VIS-21.
  An address leaves this module only when its local part is an institutional
  role: that is the organisation's published contact (``LinkSet.role_locals``). Any other address
  (a person's) is never kept.
* select_interna prefers a contact page (path or anchor text with "contacto" or
  "contact"), then an admissions page ("admision", "admisiones", "inscripcion",
  "inscripciones"), so the mailto and WhatsApp links of that page are checked
  too. Every other rule of the interna (same site, not the home, the VIS-09 skip
  rules, robots.txt, no files) still applies to the preferred page.

Only the recipients of a mailto: (its address part and ``?to=``) feed VIS-21,
never ``?cc=`` or ``?bcc=``; and VIS-21 calls the interna a contact page only
when a text of its link or the last segment of its path starts with
"contact" (names_contact_page), not when the word is anywhere in it.
"""

from __future__ import annotations

import posixpath
import re
import unicodedata
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import TYPE_CHECKING
from urllib.parse import parse_qs, unquote, urlsplit

from . import domains
from .robots import is_allowed
from .scope import matches_deny_pattern

if TYPE_CHECKING:
    from .robots import RobotsTxt

LINK_CHECK_CAP = 60  # links VIS-09 follows at most; a school home measured during development linked 40

# VIS-09 skip rules, applied to the path of same-site links.
SKIP_PATH_PREFIXES: tuple[str, ...] = (
    "/wp-content/uploads/",
    "/wp-admin",
    "/wp-json",
    "/feed",
    "/author/",
)
SKIP_PATH_CONTAINS: tuple[str, ...] = ("wp-login.php", "xmlrpc.php")

FEED_TYPES: frozenset[str] = frozenset({"application/rss+xml", "application/atom+xml"})
PAGE_EXTENSIONS: frozenset[str] = frozenset({"", ".html", ".htm", ".php"})
ICON_RELS: frozenset[str] = frozenset({"icon", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon"})
OG_IMAGE_PROPERTIES: tuple[str, ...] = ("og:image", "og:image:url")
OG_IMAGE_SECURE = "og:image:secure_url"

# The interna preference, in tiers: a contact page first, then an
# admissions page. Matched, accent- and case-insensitive, as substrings of the
# percent-decoded path or of the anchor's visible text ("contact" also finds
# "contacto" and "contactenos"; "admision", "admisiones"; "inscripcion",
# "inscripciones").
CONTACT_PAGE_WORDS: tuple[str, ...] = ("contacto", "contact")
ADMISSION_PAGE_WORDS: tuple[str, ...] = ("admision", "admisiones", "inscripcion", "inscripciones")
INTERNA_PREFERENCE: tuple[tuple[str, ...], ...] = (CONTACT_PAGE_WORDS, ADMISSION_PAGE_WORDS)
# The kind of each tier, for the VIS-21 sentence ("la página de contacto").
INTERNA_KINDS: tuple[str, ...] = ("contacto", "admisiones")
# The VIS-21 sentence names a page "de contacto" only when a text of its link or
# the last segment of its path STARTS with this (names_contact_page); the
# preference above still finds the word anywhere.
CONTACT_NAME_PREFIX = "contact"

# Local parts that name a role of the institution, not a person. Only
# an address whose WHOLE local part is one of these (case and accents ignored:
# "Secretaría" is "secretaria") is kept, as the institution's published contact.
ROLE_LOCAL_PARTS: tuple[str, ...] = (
    "info",
    "informes",
    "secretaria",
    "administracion",
    "admision",
    "admisiones",
    "inscripcion",
    "inscripciones",
    "contacto",
    "comunicacion",
    "comunicaciones",
    "prensa",
    "direccion",
    "rectoria",
    "colegio",
    "escuela",
    "instituto",
    "institucional",
    "consultas",
)
_SPACE_RE = re.compile(r"\s+")


@dataclass
class LinkSet:
    """Request-relevant links of one page, all absolute http(s) URLs, document order, deduplicated."""

    page_url: str
    base_href: str | None = None
    anchors: list[str] = field(default_factory=list)  # <a href>, resolved, fragment dropped
    og_images: list[str] = field(default_factory=list)  # og:image then og:image:secure_url, distinct
    feeds: list[str] = field(default_factory=list)  # rel=alternate RSS/Atom, comments feeds excluded
    hreflang: list[tuple[str, str]] = field(default_factory=list)  # (code as written, url)
    canonicals: list[str] = field(default_factory=list)
    stylesheets: list[str] = field(default_factory=list)
    scripts: list[str] = field(default_factory=list)
    icons: list[str] = field(default_factory=list)  # <link rel=icon> (makes /favicon.ico admissible)
    # the texts of the anchors of each resolved URL (the visible text
    # and, as a separate text, the aria-label, title or alt), joined with " | ", for the interna
    # preference; and the domains of the mailto: links (ASCII form, document
    # order, deduplicated), for VIS-21. Never a person's address: role_locals
    # maps a domain to the first institutional role local part published on it
    # ("admisiones" for admisiones@colegio.test), and nothing else.
    anchor_texts: dict[str, str] = field(default_factory=dict)
    mail_domains: list[str] = field(default_factory=list)
    role_locals: dict[str, str] = field(default_factory=dict)


@dataclass
class LinkSelection:
    """The VIS-09 plan: what will be checked and what was skipped, with reasons."""

    selected: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (url, reason in English)
    total_candidates: int = 0  # same-site links before the cap
    capped: bool = False


class _Collector(HTMLParser):
    """Collects raw attribute values; resolution happens after parsing (<base> applies to all)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.template_depth = 0
        self.base: str | None = None
        self.anchors: list[str] = []
        self.anchor_text: list[list[str]] = []  # visible text parts, parallel to ``anchors``
        self.open_anchor: int | None = None  # index into ``anchors`` while inside an <a>
        self.mailtos: list[str] = []  # raw mailto: hrefs (only domains and role local parts leave this module)
        self.og_image: list[str] = []
        self.og_secure: list[str] = []
        self.feeds: list[tuple[str, str | None]] = []
        self.hreflang: list[tuple[str, str]] = []
        self.canonicals: list[str] = []
        self.stylesheets: list[str] = []
        self.scripts: list[str] = []
        self.icons: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "template":
            self.template_depth += 1
            return
        if self.template_depth:
            return
        a = {k.lower(): (v if v is not None else "") for k, v in attrs}
        if tag == "base":
            if self.base is None and a.get("href", "").strip():
                self.base = a["href"]
        elif tag in ("a", "area"):
            if tag == "a":
                self.open_anchor = None  # HTML does not nest anchors: a new <a> closes the open one
            if "href" in a:
                if a["href"].strip().lower().startswith("mailto:"):
                    self.mailtos.append(a["href"])
                label = (a.get("aria-label") or a.get("title") or a.get("alt") or "").strip()
                self.anchors.append(a["href"])
                self.anchor_text.append([label])  # item 0: the label; then the text, as delivered
                if tag == "a":
                    self.open_anchor = len(self.anchors) - 1
        elif tag == "meta":
            prop = (a.get("property") or a.get("name") or "").strip().lower()
            content = a.get("content", "")
            if content.strip():
                if prop in OG_IMAGE_PROPERTIES:
                    self.og_image.append(content)
                elif prop == OG_IMAGE_SECURE:
                    self.og_secure.append(content)
        elif tag == "link":
            rels = set(a.get("rel", "").lower().split())
            href = a.get("href", "")
            if not href.strip():
                return
            if "alternate" in rels:
                if a.get("hreflang", "").strip():
                    self.hreflang.append((a["hreflang"].strip(), href))
                elif a.get("type", "").strip().lower() in FEED_TYPES:
                    self.feeds.append((href, a.get("title")))
            if "canonical" in rels:
                self.canonicals.append(href)
            if "stylesheet" in rels:
                self.stylesheets.append(href)
            if rels & ICON_RELS or rels == {"shortcut", "icon"}:
                self.icons.append(href)
        elif tag == "script":
            if a.get("src", "").strip():
                self.scripts.append(a["src"])

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "template":  # a self-closed <template/> opens nothing
            return
        self.handle_starttag(tag, attrs)
        if tag == "a":
            self.open_anchor = None

    def handle_endtag(self, tag: str) -> None:
        if tag == "template" and self.template_depth:
            self.template_depth -= 1
        elif tag == "a":
            self.open_anchor = None

    def handle_data(self, data: str) -> None:
        if self.open_anchor is not None and not self.template_depth:
            self.anchor_text[self.open_anchor].append(data)


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def discover_links(html: str, page_url: str) -> LinkSet:
    """Parse ``html`` (one feed + close, never incremental: gh-153030) and return its LinkSet.

    Honors <base href>. Attribute order and case do not matter. Anchors inside
    <template> are ignored; anchors inside <noscript> are kept. og:image is read
    from <meta property=...> or <meta name=...>. Feeds: <link rel~=alternate>
    with type application/rss+xml or application/atom+xml, excluding comments
    feeds (is_comments_feed).
    """
    c = _Collector()
    try:
        c.feed(html)
        c.close()
    except Exception:  # html.parser is tolerant; never let a page stop the run
        pass
    base = page_url
    base_href = None
    if c.base is not None:
        resolved = domains.resolve_url(page_url, c.base)
        if resolved is not None:
            base, base_href = resolved, resolved

    def resolve_all(values: list[str]) -> list[str]:
        return _dedupe([u for u in (domains.resolve_url(base, v) for v in values) if u is not None])

    feeds: list[str] = []
    for href, title in c.feeds:
        url = domains.resolve_url(base, href)
        if url is not None and not is_comments_feed(url, title) and url not in feeds:
            feeds.append(url)
    hreflang: list[tuple[str, str]] = []
    seen_hreflang: set[tuple[str, str]] = set()
    for code, href in c.hreflang:
        url = domains.resolve_url(base, href)
        if url is not None and (code, url) not in seen_hreflang:
            seen_hreflang.add((code, url))
            hreflang.append((code, url))
    texts: dict[str, list[str]] = {}
    for href, parts in zip(c.anchors, c.anchor_text):
        url = domains.resolve_url(base, href)
        if url is None:
            continue
        # The label (aria-label, title, alt) and the visible text are separate texts of
        # the link, so names_contact_page reads
        # where each one starts; the substring preference reads them the same as before.
        for text in (_SPACE_RE.sub(" ", parts[0]).strip(), _SPACE_RE.sub(" ", "".join(parts[1:])).strip()):
            if text and text not in texts.setdefault(url, []):
                texts[url].append(text)
    mail_domains: list[str] = []
    role_locals: dict[str, str] = {}
    for href in c.mailtos:
        for d, role in mailto_addresses(href):
            if d not in mail_domains:
                mail_domains.append(d)
            if role is not None:
                role_locals.setdefault(d, role)
    return LinkSet(
        page_url=page_url,
        base_href=base_href,
        anchors=resolve_all(c.anchors),
        og_images=resolve_all(c.og_image + c.og_secure),
        feeds=feeds,
        hreflang=hreflang,
        canonicals=resolve_all(c.canonicals),
        stylesheets=resolve_all(c.stylesheets),
        scripts=resolve_all(c.scripts),
        icons=resolve_all(c.icons),
        anchor_texts={u: " | ".join(t) for u, t in texts.items() if t},
        mail_domains=mail_domains,
        role_locals=role_locals,
    )


_MAILTO_SPLIT_RE = re.compile(r"[,;]")
# The only mailto: header whose addresses are recipients for VIS-21 (cc and bcc are copies).
MAILTO_RECIPIENT_FIELD = "to"


def role_local(local: str) -> str | None:
    """``local`` lowercased (NFC) when it is an institutional role (ROLE_LOCAL_PARTS), else None.

    The whole local part must be the role word: "info" and "Secretaría" are
    roles, "info.juan", "secretaria2" and "maria" are not.
    """
    text = unicodedata.normalize("NFC", (local or "").strip()).lower()
    if not text or _fold(text) not in _ROLE_FOLDED:
        return None
    return text


def mailto_domains(href: str) -> list[str]:
    """The domains of the recipients of one ``mailto:`` href, ASCII form, in order (never the addresses).

    ``mailto:info@colegio.test,admin@otro.test?subject=Hola`` gives
    ``["colegio.test", "otro.test"]``; ``?to=`` addresses count too (RFC 6068
    adds them to the same recipients). ``?cc=`` and ``?bcc=`` addresses never
    count: a copy to a designer or an
    agency is not the contact the page offers, and VIS-21 would blame the
    school for it. Percent-encoding is decoded and IDN labels become punycode
    (domains.normalize_host). A part without "@", or whose domain is not a
    valid host name with at least two labels, is skipped. Pure, no network.
    """
    out: list[str] = []
    for d, _role in mailto_addresses(href):
        if d not in out:
            out.append(d)
    return out


def mailto_addresses(href: str) -> list[tuple[str, str | None]]:
    """(domain, role local part or None) of each recipient of one ``mailto:`` href, in order.

    The recipients are the address part and ``?to=`` (never ``?cc=`` or
    ``?bcc=``, mailto_domains). The domain is read as in mailto_domains; the
    local part is returned only when it is an institutional role (role_local),
    never a person's.
    """
    raw = (href or "").strip()
    if not raw.lower().startswith("mailto:"):
        return []
    rest = raw[len("mailto:"):]
    path, _, query = rest.partition("?")
    parts = _MAILTO_SPLIT_RE.split(unquote(path))
    try:
        params = parse_qs(query, keep_blank_values=False)
    except ValueError:
        params = {}
    # Header names are case-insensitive (RFC 6068): "?To=" is "?to=".
    for key, values in params.items():
        if key.strip().lower() == MAILTO_RECIPIENT_FIELD:
            for value in values:
                parts += _MAILTO_SPLIT_RE.split(value)
    out: list[tuple[str, str | None]] = []
    for part in parts:
        address = part.strip()
        if "<" in address:  # "Secretaría <secretaria@colegio.test>": the address is inside the brackets
            address = address.rsplit("<", 1)[1]
        address = address.strip().strip("<>").strip()
        if "@" not in address:
            continue
        local, host = address.rsplit("@", 1)
        host = host.strip().strip(">").strip()
        try:
            d = domains.normalize_host(host)
        except ValueError:
            continue
        labels = d.split(".")
        if len(labels) < 2 or not all(_DNS_LABEL_RE.match(label) for label in labels):
            continue
        out.append((d, role_local(local)))
    return out


_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _fold(text: str) -> str:
    """Lowercase, accents stripped, whitespace collapsed (the interna preference compares words this way)."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _SPACE_RE.sub(" ", stripped.lower()).strip()


_ROLE_FOLDED: frozenset[str] = frozenset(_fold(w) for w in ROLE_LOCAL_PARTS)


def names_contact_page(url: str, links: LinkSet) -> bool:
    """True when the home calls ``url`` a contact page, by the strict reading.

    A text of a link to it (visible text, or its aria-label or title), folded
    and trimmed, starts with CONTACT_NAME_PREFIX, or the last non-empty
    segment of its decoded path does. "Contacto", "Contáctenos" and
    "/es/contacto.html" are contact pages; "Campamento: contacto con la
    naturaleza" and "/campamento/" are not.
    """
    texts = links.anchor_texts.get(url, "").split(" | ")
    if any(_fold(text).startswith(CONTACT_NAME_PREFIX) for text in texts):
        return True
    segments = [s for s in unquote(urlsplit(url).path or "").split("/") if s.strip()]
    return bool(segments) and _fold(segments[-1]).startswith(CONTACT_NAME_PREFIX)


def interna_kind(url: str, links: LinkSet) -> str | None:
    """What the home's anchor says ``url`` is: "contacto", "admisiones" (INTERNA_KINDS), or None.

    "contacto" only by the strict reading of names_contact_page (the VIS-21
    sentence then says "la página de contacto"); "admisiones" by the reading of
    the interna preference (path or anchor text, accents and case ignored);
    None otherwise, a page that only has "contacto" somewhere in its text
    included.
    """
    if names_contact_page(url, links):
        return INTERNA_KINDS[0]
    words = INTERNA_PREFERENCE[1]
    path = _fold(unquote(urlsplit(url).path or ""))
    text = _fold(links.anchor_texts.get(url, ""))
    return INTERNA_KINDS[1] if any(w in path or w in text for w in words) else None


def _preference_tier(url: str, links: LinkSet) -> int | None:
    """0 for a contact page, 1 for an admissions page (path or anchor text), None otherwise."""
    path = _fold(unquote(urlsplit(url).path or ""))
    text = _fold(links.anchor_texts.get(url, ""))
    for tier, words in enumerate(INTERNA_PREFERENCE):
        if any(w in path or w in text for w in words):
            return tier
    return None


def is_comments_feed(url: str, title: str | None) -> bool:
    """True for WordPress comments feeds (path ends in /comments/feed/ or title mentions comentarios/comments)."""
    path = urlsplit(url).path.lower().rstrip("/")
    if path.endswith("/comments/feed") or path.endswith("/comments/feed/atom") or path.endswith("/comments/feed/rss2"):
        return True
    t = (title or "").lower()
    return "comentarios" in t or "comments" in t


def _skip_reason(url: str, robots: "RobotsTxt | None") -> str | None:
    """The VIS-09 skip rule a same-site URL breaks, or None."""
    parts = urlsplit(url)
    path = parts.path or "/"
    lower = path.lower()
    for prefix in SKIP_PATH_PREFIXES:
        if lower.startswith(prefix):
            return f"skip-prefix {prefix}"
    for piece in SKIP_PATH_CONTAINS:
        if piece in lower:
            return f"skip-contains {piece}"
    query = parts.query
    if "author=" in query.lower():
        return "author"
    if query:
        return "query"
    deny = matches_deny_pattern(path)
    if deny is not None:
        return f"deny-pattern {deny}"
    if robots is not None and not is_allowed(robots, path, "*"):
        return "robots"
    return None


HOME_PATHS: frozenset[str] = frozenset({"/", "/index.php", "/index.html", "/index.htm"})


def _is_home(url: str, links: LinkSet, registrable: str) -> bool:
    if domains.compare_key(url) == domains.compare_key(links.page_url):
        return True
    parts = urlsplit(url)
    # "Inicio" links to /index.php or /index.html are the home too: never the interna.
    return domains.is_apex_or_www(url, registrable) and (parts.path or "/").lower() in HOME_PATHS and not parts.query


def links_other_pages(links: LinkSet, registrable: str) -> bool:
    """True when the page links at least one OTHER page of the site."""
    return any(domains.is_same_site(u, registrable) and not _is_home(u, links, registrable) for u in links.anchors)


def select_interna(links: LinkSet, registrable: str, robots: "RobotsTxt | None") -> str | None:
    """Pick the internal page when --inner-page is not given.

    Eligible: an anchor on the apex or www host of ``registrable``, whose path is
    not "/", that passes every VIS-09 skip rule (select_link_checks) and is not a
    file (extension other than .html/.htm/.php). the first
    eligible contact page wins (INTERNA_PREFERENCE tier 0, path or anchor text),
    then the first eligible admissions page (tier 1), then, as before, the first
    eligible anchor in document order. None when there is none.
    """
    eligible: list[str] = []
    for url in links.anchors:
        if not domains.is_apex_or_www(url, registrable):
            continue
        if _is_home(url, links, registrable):
            continue
        if _skip_reason(url, robots) is not None:
            continue
        last = posixpath.basename(urlsplit(url).path.rstrip("/")) if not urlsplit(url).path.endswith("/") else ""
        ext = posixpath.splitext(last)[1].lower()
        if ext not in PAGE_EXTENSIONS:
            continue
        eligible.append(url)
    for tier in range(len(INTERNA_PREFERENCE)):
        preferred = next((u for u in eligible if _preference_tier(u, links) == tier), None)
        if preferred is not None:
            return preferred
    return eligible[0] if eligible else None


def select_link_checks(
    links: LinkSet,
    registrable: str,
    robots: "RobotsTxt | None",
    cap: int = LINK_CHECK_CAP,
) -> LinkSelection:
    """Choose the home links VIS-09 checks.

    Keep anchors on the apex and www hosts of ``registrable``; deduplicate by
    domains.compare_key; skip SKIP_PATH_PREFIXES, SKIP_PATH_CONTAINS, ``?author=``,
    any URL with a query string, and paths that robots.txt disallows for "*".
    Keep the first ``cap`` in document order; the rest go to ``skipped`` with
    reason "cap". The home itself is not a candidate.
    """
    sel = LinkSelection()
    seen: set[str] = set()
    candidates: list[str] = []
    for url in links.anchors:
        if not domains.is_apex_or_www(url, registrable):
            continue  # off-site links are not candidates (and are never listed)
        key = domains.compare_key(url)
        if key in seen:
            continue
        seen.add(key)
        if _is_home(url, links, registrable):
            continue
        reason = _skip_reason(url, robots)
        if reason is not None:
            sel.skipped.append((url, reason))
            continue
        candidates.append(url)
    sel.total_candidates = len(candidates)
    limit = max(0, cap)
    sel.selected = candidates[:limit]
    for url in candidates[limit:]:
        sel.skipped.append((url, "cap"))
    sel.capped = len(candidates) > limit
    return sel
