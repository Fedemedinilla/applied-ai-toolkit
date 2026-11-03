"""Sitemaps and RSS/Atom feeds, read WITHOUT an XML parser.

Untrusted XML is read with regular expressions only: ``<loc>``, ``<lastmod>``,
``<urlset``, ``<sitemapindex``, RSS ``<item>``/``<pubDate>``/``<generator>``/
``<title>``/``<description>`` and Atom ``<entry>``/``<updated>``. Any document
containing ``<!DOCTYPE`` or ``<!ENTITY`` is refused before reading (sitemaps and
feeds never need them). Bodies are already capped at 5 MiB by the client.
CDATA sections are unwrapped; XML entities (&amp; &lt; &gt; &quot; &apos; and
numeric) are unescaped with html.unescape.

Hostile input: elements are found with a forward-only
scanner (find the opening tag, then the NEXT closing tag, never backtrack), so
the work is linear in the size of the body whatever the site serves; a lazy
``(.*?)`` regex over thousands of unclosed tags was quadratic (80 KB took 4 s).
The number of <loc> and <item> read is capped as well (MAX_LOCS, MAX_ITEMS).

Gzipped sitemaps: a declared ``sitemap.xml.gz`` served as
application/x-gzip (magic bytes 1f 8b, no Content-Encoding) is decompressed with
the same anti-bomb cap as any body (sitemap_body); one that cannot be read is
"unreadable" (grey), never "not found".
"""

from __future__ import annotations

import datetime as dt
import email.utils
import html
import re
import zlib
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .httpclient import Response

XML_CONTENT_TYPES: frozenset[str] = frozenset(
    {"application/xml", "text/xml", "application/rss+xml", "application/atom+xml"}
)
GZIP_CONTENT_TYPES: frozenset[str] = frozenset(
    {"application/x-gzip", "application/gzip", "application/x-gunzip", "application/octet-stream", "binary/octet-stream"}
)
GZIP_MAGIC = b"\x1f\x8b"
MAX_SITEMAP_BYTES = 5 * 1024 * 1024  # decompression cap, the same as any HTML/XML body
MAX_LOCS = 50_000  # sitemaps.org: at most 50,000 URLs per sitemap
MAX_ITEMS = 2_000

_REFUSED_RE = re.compile(r"<!DOCTYPE|<!ENTITY", re.IGNORECASE)
_SITEMAPINDEX_RE = re.compile(r"<(?:[\w-]+:)?sitemapindex\b", re.IGNORECASE)
_URLSET_RE = re.compile(r"<(?:[\w-]+:)?urlset\b", re.IGNORECASE)
# <loc> without a namespace prefix: image:loc / video:loc must not be counted.
_WS_RE = re.compile(r"\s+")
_RSS_RE = re.compile(r"<rss\b|<rdf:RDF\b|<channel\b", re.IGNORECASE)
_ATOM_RE = re.compile(r"<feed\b", re.IGNORECASE)
_TAG_RES: dict[str, tuple[re.Pattern[str], re.Pattern[str]]] = {}
_WP_GENERATOR_RE = re.compile(r"^https?://(?:www\.)?wordpress\.org/\?v=(\d+(?:\.\d+){1,2})\s*$", re.IGNORECASE)
_START_RE = re.compile(r"^\s*(<\?xml|<urlset|<sitemapindex|<(?:[\w-]+:)(?:urlset|sitemapindex))", re.IGNORECASE)


class DocKind(StrEnum):
    URLSET = "urlset"
    SITEMAPINDEX = "sitemapindex"
    RSS = "rss"
    ATOM = "atom"
    INVALID = "invalid"
    REFUSED = "refused"  # DOCTYPE/ENTITY present


@dataclass
class SitemapDoc:
    kind: DocKind
    locs: list[str] = field(default_factory=list)
    lastmods: list[str] = field(default_factory=list)  # raw strings, document order


@dataclass
class FeedItem:
    title: str
    date: dt.datetime | None  # timezone-aware; None when unparseable


@dataclass
class FeedDoc:
    kind: DocKind
    generator: str | None = None  # e.g. "https://wordpress.org/?v=6.1.1"
    channel_title: str | None = None
    channel_description: str | None = None  # VIS-19 reads the default tagline here
    items: list[FeedItem] = field(default_factory=list)  # document order (newest first in WP)


def _tag_res(tag: str) -> tuple[re.Pattern[str], re.Pattern[str]]:
    res = _TAG_RES.get(tag)
    if res is None:
        name = re.escape(tag)
        res = (re.compile(rf"<{name}(?=[\s>/])", re.IGNORECASE), re.compile(rf"</{name}\s*>", re.IGNORECASE))
        _TAG_RES[tag] = res
    return res


def _elements(text: str, tag: str, limit: int) -> list[tuple[str, str]]:
    """(attributes, inner text) of each <tag ...>...</tag>, in order, at most ``limit``.

    Forward only: after an opening tag the NEXT closing tag ends the element,
    and the scan never goes back. An opening tag without a closing one
    ends the scan: no later element can be complete either.
    """
    open_re, close_re = _tag_res(tag)
    out: list[tuple[str, str]] = []
    pos = 0
    while len(out) < limit:
        m = open_re.search(text, pos)
        if m is None:
            break
        gt = text.find(">", m.end())
        if gt < 0:
            break
        if text[gt - 1] == "/":  # <tag/>: empty, no content
            pos = gt + 1
            continue
        c = close_re.search(text, gt + 1)
        if c is None:
            break
        out.append((text[m.end() : gt], text[gt + 1 : c.start()]))
        pos = c.end()
    return out


def _unwrap_cdata(text: str) -> str:
    """Replace each complete <![CDATA[...]]> by its content (linear; an unterminated one stays as is)."""
    if "<![CDATA[" not in text:
        return text
    out: list[str] = []
    pos = 0
    while True:
        i = text.find("<![CDATA[", pos)
        if i < 0:
            break
        j = text.find("]]>", i + 9)
        if j < 0:
            break
        out.append(text[pos:i])
        out.append(text[i + 9 : j])
        pos = j + 3
    out.append(text[pos:])
    return "".join(out)


def _clean(text: str) -> str:
    """Unwrap CDATA, unescape entities, collapse whitespace."""
    return _WS_RE.sub(" ", html.unescape(_unwrap_cdata(text))).strip()


def _first(tag: str, text: str) -> str | None:
    found = _elements(text, tag, 1)
    return _clean(found[0][1]) if found else None


def gunzip_capped(data: bytes, max_bytes: int = MAX_SITEMAP_BYTES) -> bytes:
    """Decompress a gzip body with an output cap (decompression bomb guard). zlib.error when unreadable."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = d.decompress(bytes(data), max_bytes)
    if not d.eof and not d.unconsumed_tail and len(out) < max_bytes:
        raise zlib.error("truncated gzip data")
    return out


def sitemap_body(resp: "Response | None") -> tuple[bytes | None, bool]:
    """(XML bytes, unreadable) of a sitemap response.

    A gzipped body (magic 1f 8b that the transport did not decode) is
    decompressed with the cap; one that cannot be decompressed returns
    (None, True). Anything else is returned as is.
    """
    if resp is None or not resp.body:
        return (resp.body if resp is not None else None), False
    body = bytes(resp.body)
    if body[:2] == GZIP_MAGIC:
        try:
            return gunzip_capped(body), False
        except (zlib.error, EOFError, ValueError):
            return None, True
    return body, False


def looks_like_sitemap(resp: "Response | None", body: bytes | None = None) -> bool:
    """Spec VIS-02 validity: status 200, an XML Content-Type, body starting with
    ``<?xml``, ``<urlset`` or ``<sitemapindex`` (after whitespace/BOM), not challenged.

    ``body`` is the XML from sitemap_body; for a gzipped sitemap a gzip
    Content-Type is accepted too.
    """
    if resp is None or resp.status != 200 or resp.skipped or resp.error or resp.challenge:
        return False
    if resp.undecodable_encoding:
        return False
    gzipped = bytes(resp.body[:2]) == GZIP_MAGIC
    allowed = XML_CONTENT_TYPES | GZIP_CONTENT_TYPES if gzipped else XML_CONTENT_TYPES
    if resp.content_type not in allowed and not (gzipped and resp.content_type is None):
        return False
    data = body if body is not None else (None if gzipped else resp.body)
    if not data:
        return False
    head = bytes(data[:2048])
    if head.startswith(b"\xef\xbb\xbf"):
        head = head[3:]
    return bool(_START_RE.match(head.decode("latin-1")))


def parse_sitemap(text: str) -> SitemapDoc:
    """Return the kind and every <loc>/<lastmod> of a sitemap or sitemap index."""
    if _REFUSED_RE.search(text):
        return SitemapDoc(DocKind.REFUSED)
    if _SITEMAPINDEX_RE.search(text):
        kind = DocKind.SITEMAPINDEX
    elif _URLSET_RE.search(text):
        kind = DocKind.URLSET
    else:
        return SitemapDoc(DocKind.INVALID)
    locs = [v for v in (_clean(inner) for _, inner in _elements(text, "loc", MAX_LOCS)) if v]
    lastmods = [v for v in (_clean(inner) for _, inner in _elements(text, "lastmod", MAX_LOCS)) if v]
    return SitemapDoc(kind, locs, lastmods)


def _aware(value: dt.datetime) -> dt.datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=dt.UTC)


def _rss_date(raw: str | None) -> dt.datetime | None:
    if not raw:
        return None
    try:
        return _aware(email.utils.parsedate_to_datetime(raw))
    except (TypeError, ValueError, IndexError, OverflowError):
        return _iso_date(raw)


def _iso_date(raw: str | None) -> dt.datetime | None:
    if not raw:
        return None
    try:
        return _aware(dt.datetime.fromisoformat(raw.strip()))
    except ValueError:
        return None


def parse_feed(text: str) -> FeedDoc:
    """Parse an RSS 2.0 or Atom feed.

    RSS dates with email.utils.parsedate_to_datetime; Atom <updated> with
    datetime.fromisoformat. Naive dates are taken as UTC.
    """
    if _REFUSED_RE.search(text):
        return FeedDoc(DocKind.REFUSED)
    if _RSS_RE.search(text):
        first_item = re.search(r"<item\b", text, re.IGNORECASE)
        channel = text[: first_item.start()] if first_item else text
        doc = FeedDoc(
            DocKind.RSS,
            generator=_generator(text),
            channel_title=_first("title", channel),
            channel_description=_first("description", channel),
        )
        for _, block in _elements(text, "item", MAX_ITEMS):
            date_raw = _first("pubDate", block) or _first("dc:date", block)
            doc.items.append(FeedItem(title=_first("title", block) or "", date=_rss_date(date_raw)))
        return doc
    if _ATOM_RE.search(text):
        first_entry = re.search(r"<entry\b", text, re.IGNORECASE)
        head = text[: first_entry.start()] if first_entry else text
        doc = FeedDoc(
            DocKind.ATOM,
            generator=_generator(head),
            channel_title=_first("title", head),
            channel_description=_first("subtitle", head),
        )
        for _, block in _elements(text, "entry", MAX_ITEMS):
            date_raw = _first("updated", block) or _first("published", block)
            doc.items.append(FeedItem(title=_first("title", block) or "", date=_iso_date(date_raw)))
        return doc
    return FeedDoc(DocKind.INVALID)


def _generator(text: str) -> str | None:
    found = _elements(text, "generator", 1)
    if not found:
        return None
    attrs, body = found[0][0], _clean(found[0][1])
    # Atom: <generator uri="https://wordpress.org/" version="6.1.1">WordPress</generator>
    uri = re.search(r"""uri\s*=\s*["']([^"']+)["']""", attrs, re.IGNORECASE)
    version = re.search(r"""version\s*=\s*["']([^"']+)["']""", attrs, re.IGNORECASE)
    if uri and version and "wordpress.org" in uri.group(1).lower():
        return f"{uri.group(1).rstrip('/')}/?v={version.group(1).strip()}"
    return body or None


def wordpress_version_from_generator(generator: str | None) -> str | None:
    """``https://wordpress.org/?v=6.1.1`` -> ``6.1.1``; None for anything else."""
    if not generator:
        return None
    m = _WP_GENERATOR_RE.match(generator.strip())
    return m.group(1) if m else None
