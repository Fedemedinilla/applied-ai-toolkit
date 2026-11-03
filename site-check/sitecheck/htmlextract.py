"""Measurement facts from one HTML page (titles, meta, headings, images, anchors, JSON-LD...).

One html.parser pass per page: feed the whole text once, then close (never
incremental: gh-153030 quadratic case on 3.14.5). Attribute order and case do
not matter (trap: the tool's grep missed <meta content=... property=...>).
Content inside <script>, <style> and <template> is not visible text; images
inside <noscript> are lazy-load duplicates and are marked; comments are kept
apart (cache plugin signatures, EXT-19). The footer region is the <footer>
element (every one of them), else the elements whose class or id contains
"footer" (fusion-footer, elementor-location-footer, site-footer); <html> and
<body> classes are ignored there, because WordPress body classes such as
"footer-widgets" would turn the whole page into a footer.

URLs are resolved with domains.resolve_url (the same rule as links.py, NET), so
the measurement and the request boundary agree on every href.

Audit: anchors carry ``lang_hint`` (a language switcher: hreflang,
lang or data-gt-lang attributes, or a translation plugin's classes), the page
keeps the text written inside elements whose lang is not Spanish
(``foreign_lang_text``), so EXT-24 never reads a language menu or a Japanese
class as spam, and ``data_forms`` counts the forms that ask for
personal data (an e-mail, a phone, a name or a document; never a search box),
which is what the privacy law is about.

Personal data: anchors keep their href, but nothing here is copied to datos.json
by default. Phone numbers are never stored whole (VIS-18 keeps the last 4
digits); e-mail addresses are never stored.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from html.parser import HTMLParser

from . import domains


@dataclass
class AnchorFacts:
    href: str  # raw attribute value, stripped
    url: str | None  # resolved absolute http(s) URL, fragment dropped; None for mailto:/tel:/js
    scheme: str  # "http", "https", "mailto", "tel", "whatsapp", "javascript", "" (relative resolved)...
    text: str  # visible text, whitespace collapsed
    aria_label: str | None
    title: str | None
    img_alts: list[str]  # alt of <img> inside the anchor
    in_footer: bool
    classes_ids: list[str]  # class and id tokens of the anchor and its ancestors (lowercased)
    lang_hint: bool = False  # part of a language switcher (hreflang/lang/data-gt-lang, plugin classes)


@dataclass
class ImageFacts:
    src: str | None
    alt: str | None  # None = no alt attribute; "" = decorative (counts as present)
    in_noscript: bool


@dataclass
class FieldFacts:
    tag: str  # input/select/textarea
    type: str | None  # input type, lowercased
    has_label: bool  # <label for>, wrapping <label>, aria-label or aria-labelledby


@dataclass
class PageFacts:
    url: str
    lang: str | None = None  # <html lang>, lowercased and trimmed
    title: str | None = None  # html.unescape, collapsed
    meta_description: str | None = None
    metas: list[dict[str, str]] = field(default_factory=list)  # every <meta>, attrs lowercased keys
    robots_meta: list[str] = field(default_factory=list)  # content of name=robots, lowercased
    googlebot_meta: list[str] = field(default_factory=list)
    canonicals: list[str] = field(default_factory=list)  # <link rel~=canonical> resolved
    og: dict[str, list[str]] = field(default_factory=dict)  # "og:image" -> all values, document order
    twitter: dict[str, list[str]] = field(default_factory=dict)
    hreflang: list[tuple[str, str]] = field(default_factory=list)
    feeds: list[tuple[str, str | None, str]] = field(default_factory=list)  # (type, title, url)
    generator: list[str] = field(default_factory=list)  # <meta name=generator> contents
    viewport: str | None = None
    headings: list[int] = field(default_factory=list)  # levels in order, outside script/template/noscript
    images: list[ImageFacts] = field(default_factory=list)
    anchors: list[AnchorFacts] = field(default_factory=list)
    jsonld_blocks: list[str] = field(default_factory=list)  # raw text of script[type=application/ld+json]
    inline_scripts: list[str] = field(default_factory=list)  # other inline scripts (plugin JSON configs)
    script_srcs: list[str] = field(default_factory=list)
    stylesheet_hrefs: list[str] = field(default_factory=list)
    n_style_blocks: int = 0
    subresources: list[tuple[str, str, str]] = field(default_factory=list)  # (tag, attr, url) for EXT-16
    forms: int = 0
    fields: list[FieldFacts] = field(default_factory=list)
    comments: list[str] = field(default_factory=list)
    visible_text: str = ""  # outside script/style/template; hidden blocks INCLUDED (EXT-24 needs them)
    footer_found: bool = False
    footer_text: str = ""
    class_id_tokens: set[str] = field(default_factory=set)  # every class/id token in the page, lowercased
    # Optional additions:
    nonlink_text: str = ""  # visible text outside <a> (VIS-15: a phone written without a link)
    foreign_lang_text: str = ""  # visible text inside elements with a non-Spanish lang attribute (EXT-24)
    data_forms: int = 0  # forms with a field for an e-mail, phone, name or document
    # data-* attributes whose name mentions phone/number/tel/settings/whatsapp, as
    # (attribute, value, class/id tokens of the element): WhatsApp plugin configs (VIS-18).
    data_attrs: list[tuple[str, str, str]] = field(default_factory=list)
    # <param name=... value=...> of <object> (VIS-20, the "movie" of a
    # Flash object), as (name lowercased, value), values capped at 2000 characters.
    params: list[tuple[str, str]] = field(default_factory=list)


VOID_ELEMENTS: frozenset[str] = frozenset(
    {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"}
)
# Inline elements: entering or leaving them does not separate words in the text.
INLINE_ELEMENTS: frozenset[str] = frozenset(
    {
        "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "font", "i", "kbd", "mark", "q", "s",
        "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "label", "img",
    }
)
# EXT-16: link rels that load something, and rels that never do (the usual exclusions).
SUBRESOURCE_LINK_RELS: frozenset[str] = frozenset(
    {"stylesheet", "icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed", "preload", "modulepreload", "manifest", "mask-icon"}
)
EXCLUDED_LINK_RELS: frozenset[str] = frozenset(
    {"profile", "pingback", "dns-prefetch", "preconnect", "alternate", "canonical", "shortlink", "edituri", "wlwmanifest", "prev", "next"}
)
_SUBRESOURCE_ATTRS: dict[str, tuple[str, ...]] = {
    "source": ("src", "srcset"),
    "video": ("src", "poster"),
    "audio": ("src",),
    "iframe": ("src",),
    "embed": ("src",),
    "object": ("data",),
    "track": ("src",),
    "input": ("src",),
}
_DATA_ATTR_HINTS: tuple[str, ...] = ("phone", "number", "tel", "settings", "whatsapp")
_CSS_URL_RE = re.compile(r"""url\(\s*['"]?([^'")\s]+)['"]?\s*\)""", re.IGNORECASE)
_SPACE_RE = re.compile(r"\s+")
_SCHEME_RE = re.compile(r"^\s*([a-zA-Z][a-zA-Z0-9+.\-]*):")
_FIELD_SKIP_TYPES: frozenset[str] = frozenset({"hidden", "submit", "button", "image", "reset"})
JS_YEAR_MARK = "\ufffc"  # where an inline script writes the current year
# Class or id fragments of language switchers (GTranslate, TranslatePress, WPML, Polylang, Weglot...).
_LANG_SWITCH_HINTS: tuple[str, ...] = (
    "gtranslate", "glink", "gt_", "trp-", "wpml", "lang-item", "language", "lang-switch", "polylang", "weglot",
    "translatepress", "qtranxs",
)
_LANG_ATTRS: tuple[str, ...] = ("hreflang", "lang", "data-gt-lang", "data-lang", "data-language")
# A field asks for personal data when its type says so or its name, id, placeholder,
# label or autocomplete mentions one of these.
_PERSONAL_FIELD_TYPES: frozenset[str] = frozenset({"email", "tel"})
_PERSONAL_FIELD_HINTS: tuple[str, ...] = (
    "nombre", "apellido", "name", "dni", "documento", "cuit", "cuil", "telefono", "phone", "celular", "movil",
    "whatsapp", "mail", "correo", "direccion", "address", "domicilio", "nacimiento",
)
_SEARCH_NAMES: frozenset[str] = frozenset({"s", "q", "search", "buscar", "busqueda", "query"})
_HEADINGS: dict[str, int] = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_RAW_TAGS: frozenset[str] = frozenset({"script", "style", "title", "textarea"})


def _collapse(text: str) -> str:
    return _SPACE_RE.sub(" ", text).strip()


def _tokens(attrs: dict[str, str]) -> list[str]:
    out = [t.lower() for t in (attrs.get("class") or "").split()]
    ident = (attrs.get("id") or "").strip().lower()
    if ident:
        out.append(ident)
    return out


@dataclass
class _Anchor:
    href: str
    url: str | None
    scheme: str
    aria_label: str | None
    title: str | None
    tokens: list[str]
    footer_tag: bool
    footer_class: bool
    text_parts: list[str] = field(default_factory=list)
    img_alts: list[str] = field(default_factory=list)
    lang_hint: bool = False


@dataclass
class _Node:
    tag: str
    tokens: list[str]
    in_template: bool
    in_noscript: bool
    in_svg: bool
    footer_tag: bool
    footer_class: bool
    in_label: bool
    anchor: _Anchor | None
    foreign: bool = False  # inside an element whose lang is not Spanish


@dataclass
class _Field:
    tag: str
    type: str | None
    ident: str | None
    labelled: bool


class _Extractor(HTMLParser):
    def __init__(self, url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.facts = PageFacts(url=url)
        self.base = url
        self.base_set = False
        self.stack: list[_Node] = []
        self.raw: str | None = None  # "script" | "style" | "title" | "textarea" while inside
        self.raw_attrs: dict[str, str] = {}
        self.raw_parts: list[str] = []
        self.raw_skip = False  # the raw element sits inside <template> or <svg>
        self.text: list[str] = []
        self.nonlink: list[str] = []
        self.footer_tag_text: list[str] = []
        self.footer_class_text: list[str] = []
        self.saw_footer_tag = False
        self.saw_footer_class = False
        self.anchors: list[_Anchor] = []
        self.foreign_text: list[str] = []
        self.current_form: int | None = None  # index of the open <form> (forms do not nest)
        self.form_search: dict[int, bool] = {}
        self.form_personal: dict[int, bool] = {}
        self.fields: list[_Field] = []
        self.label_for: set[str] = set()
        self.title_seen = False

    # ---- helpers -------------------------------------------------------
    def _top(self) -> _Node | None:
        return self.stack[-1] if self.stack else None

    def _resolve(self, href: str | None) -> str | None:
        if href is None:
            return None
        try:
            return domains.resolve_url(self.base, href)
        except Exception:  # a malformed href never stops the extraction
            return None

    def _sep(self) -> None:
        """A word boundary (block element edge) in every text buffer."""
        self.text.append(" ")
        self.nonlink.append(" ")
        self.footer_tag_text.append(" ")
        self.footer_class_text.append(" ")
        top = self._top()
        if top is not None and top.anchor is not None:
            top.anchor.text_parts.append(" ")

    @staticmethod
    def _personal_field(tag: str, attrs: dict[str, str]) -> bool:
        return _personal_field_of(tag, attrs)

    def _close_to(self, index: int) -> None:
        while len(self.stack) > index:
            node = self.stack.pop()
            if node.tag not in INLINE_ELEMENTS:
                self._sep()

    def _attr_urls(self, attrs: dict[str, str], attr: str) -> list[str]:
        value = attrs.get(attr)
        if not value:
            return []
        if attr.endswith("srcset"):
            raw = [part.strip().split()[0] for part in value.split(",") if part.strip()]
        else:
            raw = [value]
        out = []
        for r in raw:
            u = self._resolve(r)
            if u:
                out.append(u)
        return out

    # ---- parser callbacks ---------------------------------------------
    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._start(tag, attrs, self_closing=True)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._start(tag, attrs, self_closing=False)

    def _start(self, tag: str, attrs_list: list[tuple[str, str | None]], *, self_closing: bool) -> None:
        tag = tag.lower()
        attrs: dict[str, str] = {}
        present: set[str] = set()
        for k, v in attrs_list:
            k = k.lower()
            if k not in present:
                attrs[k] = v if v is not None else ""
                present.add(k)
        parent = self._top()
        tokens = _tokens(attrs)
        f = self.facts
        f.class_id_tokens.update(tokens)
        in_template = bool(parent and parent.in_template) or tag == "template"
        in_noscript = bool(parent and parent.in_noscript) or tag == "noscript"
        in_svg = bool(parent and parent.in_svg) or tag == "svg"
        footer_tag = bool(parent and parent.footer_tag) or tag == "footer"
        is_footer_class = tag not in ("html", "body") and any("footer" in t for t in tokens)
        footer_class = bool(parent and parent.footer_class) or is_footer_class
        in_label = bool(parent and parent.in_label) or tag == "label"
        lang_value = (attrs.get("lang") or "").strip().lower() if "lang" in present and tag != "html" else None
        if lang_value:
            foreign = not lang_value.replace("_", "-").startswith("es")
        else:
            foreign = bool(parent and parent.foreign)
        if tag == "footer" and not in_template:
            self.saw_footer_tag = True
        if is_footer_class and not in_template:
            self.saw_footer_class = True

        if not in_template:
            for k, v in attrs.items():
                if k.startswith("data-") and v and any(h in k for h in _DATA_ATTR_HINTS):
                    f.data_attrs.append((k, v[:2000], " ".join(tokens)))
            style_attr = attrs.get("style")
            if style_attr and "url(" in style_attr.lower():
                for m in _CSS_URL_RE.finditer(style_attr):
                    u = self._resolve(m.group(1))
                    if u:
                        f.subresources.append((tag, "style", u))

        if tag == "html" and "lang" in present:
            f.lang = (attrs.get("lang") or "").strip().lower()
        elif tag == "base" and not self.base_set and attrs.get("href"):
            resolved = self._resolve(attrs["href"])
            if resolved:
                self.base = resolved
                self.base_set = True
        elif tag == "meta":
            self._meta(attrs)
        elif tag == "link" and not in_template:
            self._link(attrs)
        elif tag == "param" and not in_template and (attrs.get("name") or "").strip():
            f.params.append(((attrs.get("name") or "").strip().lower(), (attrs.get("value") or "")[:2000]))

        if tag in _HEADINGS and not (in_template or in_noscript or in_svg):
            f.headings.append(_HEADINGS[tag])

        if tag == "img" and not in_template:
            alt = attrs.get("alt") if "alt" in present else None
            src = attrs.get("src")
            f.images.append(ImageFacts(src=(self._resolve(src) or src) if src else None, alt=alt, in_noscript=in_noscript))
            if not in_noscript:
                for attr in ("src", "srcset"):
                    for u in self._attr_urls(attrs, attr):
                        f.subresources.append(("img", attr, u))
            if parent is not None and parent.anchor is not None and alt:
                parent.anchor.img_alts.append(_collapse(alt))
        elif tag == "script" and not in_template:
            for u in self._attr_urls(attrs, "src"):
                f.script_srcs.append(u)
                if not in_noscript:
                    f.subresources.append(("script", "src", u))
        elif tag in _SUBRESOURCE_ATTRS and not (in_template or in_noscript):
            if tag != "input" or (attrs.get("type") or "").strip().lower() == "image":
                for attr in _SUBRESOURCE_ATTRS[tag]:
                    for u in self._attr_urls(attrs, attr):
                        f.subresources.append((tag, attr, u))

        if tag == "form" and not in_template:
            f.forms += 1
            for u in self._attr_urls(attrs, "action"):
                f.subresources.append(("form", "action", u))
            self.current_form = f.forms
            role = (attrs.get("role") or "").strip().lower()
            self.form_search[f.forms] = role == "search" or any("search" in t for t in tokens)
            self.form_personal.setdefault(f.forms, False)
        if tag == "label" and (attrs.get("for") or "").strip():
            self.label_for.add(attrs["for"].strip())
        if tag in ("input", "select", "textarea") and not in_template and self.current_form is not None:
            if self._personal_field(tag, attrs):
                self.form_personal[self.current_form] = True
        if tag in ("input", "select", "textarea") and not in_template:
            itype = (attrs.get("type") or "").strip().lower() or None
            if tag != "input" or (itype or "text") not in _FIELD_SKIP_TYPES:
                labelled = (
                    in_label
                    or bool((attrs.get("aria-label") or "").strip())
                    or bool((attrs.get("aria-labelledby") or "").strip())
                )
                self.fields.append(
                    _Field(tag, itype if tag == "input" else None, (attrs.get("id") or "").strip() or None, labelled)
                )

        anchor_obj: _Anchor | None = parent.anchor if parent else None
        if tag == "a":
            # HTML does not nest anchors: a new <a> closes the open one.
            if anchor_obj is not None:
                for i in range(len(self.stack) - 1, -1, -1):
                    if self.stack[i].tag == "a":
                        self._close_to(i)
                        break
            anchor_obj = None
            if not in_template and "href" in present:
                href = (attrs.get("href") or "").strip()
                m = _SCHEME_RE.match(href)
                scheme = m.group(1).lower() if m else ""
                ancestors = [t for n in self.stack for t in n.tokens]
                all_tokens = list(tokens) + ancestors
                lang_hint = any(k in present for k in _LANG_ATTRS) or any(
                    h in t for t in all_tokens for h in _LANG_SWITCH_HINTS
                )
                anchor_obj = _Anchor(
                    href=href,
                    url=self._resolve(href) if scheme in ("", "http", "https") else None,
                    scheme=scheme,
                    aria_label=attrs.get("aria-label") if "aria-label" in present else None,
                    title=attrs.get("title") if "title" in present else None,
                    tokens=list(tokens) + ancestors,
                    footer_tag=footer_tag,
                    footer_class=footer_class,
                    lang_hint=lang_hint,
                )
                self.anchors.append(anchor_obj)

        if tag in _RAW_TAGS and not self_closing:
            # html.parser delivers their content as raw data until the end tag.
            self.raw = tag
            self.raw_attrs = attrs
            self.raw_parts = []
            self.raw_skip = in_template or (tag == "title" and in_svg)
            if tag == "style" and not in_template:
                f.n_style_blocks += 1
            return

        if tag in VOID_ELEMENTS or self_closing:
            if tag not in INLINE_ELEMENTS:
                self._sep()
            return
        if tag not in INLINE_ELEMENTS:
            self._sep()
        self.stack.append(_Node(tag, tokens, in_template, in_noscript, in_svg, footer_tag, footer_class, in_label, anchor_obj, foreign))

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.raw is not None:
            if tag == self.raw:
                self._end_raw()
            return
        if tag == "form":
            self.current_form = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i].tag == tag:
                self._close_to(i)
                return
        if tag in ("br", "p"):
            self._sep()

    def _end_raw(self) -> None:
        tag, attrs, text = self.raw, self.raw_attrs, "".join(self.raw_parts)
        self.raw = None
        if self.raw_skip:
            return
        f = self.facts
        if tag == "script":
            stype = (attrs.get("type") or "").split(";")[0].strip().lower()
            if stype == "application/ld+json":
                f.jsonld_blocks.append(text)
            elif "src" not in attrs and text.strip():
                f.inline_scripts.append(text)
                low = text.lower()
                if "getfullyear" in low or "getyear" in low:
                    # The browser writes a year here ("© 2019 - <script>...</script>"):
                    # leave a mark so VIS-16 knows the visible year is not the whole story.
                    self._mark_js_year()
        elif tag == "style":
            for m in _CSS_URL_RE.finditer(text):
                u = self._resolve(m.group(1))
                if u:
                    f.subresources.append(("style", "url", u))
        elif tag == "title":
            if not self.title_seen:
                self.title_seen = True
                f.title = _collapse(text)
        # textarea content is form data, not page text

    def handle_data(self, data: str) -> None:
        if self.raw is not None:
            self.raw_parts.append(data)
            return
        top = self._top()
        if top is not None and top.in_template:
            return
        self.text.append(data)
        if top is not None and top.foreign:
            self.foreign_text.append(data)
        if top is not None and top.anchor is not None:
            top.anchor.text_parts.append(data)
        else:
            self.nonlink.append(data)
        if top is not None and top.footer_tag:
            self.footer_tag_text.append(data)
        if top is not None and top.footer_class:
            self.footer_class_text.append(data)

    def _mark_js_year(self) -> None:
        mark = JS_YEAR_MARK
        self.text.append(mark)
        top = self._top()
        if top is not None and top.footer_tag:
            self.footer_tag_text.append(mark)
        if top is not None and top.footer_class:
            self.footer_class_text.append(mark)

    def handle_comment(self, data: str) -> None:
        self.facts.comments.append(data)

    # ---- element helpers ----------------------------------------------
    def _meta(self, attrs: dict[str, str]) -> None:
        f = self.facts
        f.metas.append(dict(attrs))
        name = (attrs.get("name") or "").strip().lower()
        prop = (attrs.get("property") or "").strip().lower()
        if "content" not in attrs:
            return
        content = attrs["content"]
        content_c = _collapse(content)
        if name == "description" and f.meta_description is None:
            f.meta_description = content_c
        elif name == "robots":
            f.robots_meta.append(content_c.lower())
        elif name == "googlebot":
            f.googlebot_meta.append(content_c.lower())
        elif name == "generator":
            f.generator.append(content_c)
        elif name == "viewport" and f.viewport is None:
            f.viewport = content_c
        key = prop or name
        if key.startswith("og:"):
            f.og.setdefault(key, []).append(content_c)
        elif key.startswith("twitter:"):
            f.twitter.setdefault(key, []).append(content_c)

    def _link(self, attrs: dict[str, str]) -> None:
        f = self.facts
        rels = {r.lower() for r in (attrs.get("rel") or "").split()}
        url = self._resolve(attrs.get("href"))
        if url is None:
            return
        if "canonical" in rels:
            f.canonicals.append(url)
        if "alternate" in rels:
            ltype = (attrs.get("type") or "").split(";")[0].strip().lower()
            if "hreflang" in attrs:
                f.hreflang.append(((attrs.get("hreflang") or "").strip(), url))
            elif ltype in ("application/rss+xml", "application/atom+xml"):
                f.feeds.append((ltype, attrs.get("title"), url))
        if "stylesheet" in rels:
            f.stylesheet_hrefs.append(url)
        if rels & SUBRESOURCE_LINK_RELS and not (rels & EXCLUDED_LINK_RELS):
            f.subresources.append(("link", "href", url))

    # ---- finish --------------------------------------------------------
    def finish(self) -> PageFacts:
        if self.raw is not None:
            self._end_raw()
        self._close_to(0)
        f = self.facts
        f.visible_text = _collapse("".join(self.text))
        f.nonlink_text = _collapse("".join(self.nonlink))
        f.foreign_lang_text = _collapse("".join(self.foreign_text))
        f.data_forms = sum(1 for i, personal in self.form_personal.items() if personal and not self.form_search.get(i, False))
        use_tag = self.saw_footer_tag
        f.footer_found = self.saw_footer_tag or self.saw_footer_class
        f.footer_text = _collapse("".join(self.footer_tag_text if use_tag else self.footer_class_text))
        for a in self.anchors:
            seen: set[str] = set()
            tokens = []
            for t in a.tokens:
                if t not in seen:
                    seen.add(t)
                    tokens.append(t)
            f.anchors.append(
                AnchorFacts(
                    href=a.href,
                    url=a.url,
                    scheme=a.scheme,
                    text=_collapse("".join(a.text_parts)),
                    aria_label=_collapse(a.aria_label) if a.aria_label is not None else None,
                    title=_collapse(a.title) if a.title is not None else None,
                    img_alts=a.img_alts,
                    in_footer=a.footer_tag if use_tag else a.footer_class,
                    classes_ids=tokens,
                    lang_hint=a.lang_hint,
                )
            )
        for fld in self.fields:
            f.fields.append(FieldFacts(fld.tag, fld.type, fld.labelled or bool(fld.ident and fld.ident in self.label_for)))
        return f


def _personal_field_of(tag: str, attrs: dict[str, str]) -> bool:
    itype = (attrs.get("type") or "").strip().lower()
    if tag == "input" and itype in _FIELD_SKIP_TYPES | {"search", "checkbox", "radio", "file", "range", "color"}:
        return False
    name = (attrs.get("name") or "").strip().lower()
    if name in _SEARCH_NAMES:
        return False
    if tag == "input" and itype in _PERSONAL_FIELD_TYPES:
        return True
    hay = " ".join(
        (attrs.get(k) or "") for k in ("name", "id", "placeholder", "aria-label", "autocomplete", "title")
    ).lower()
    hay = "".join(ch for ch in unicodedata.normalize("NFKD", hay) if not unicodedata.combining(ch))
    return any(h in hay for h in _PERSONAL_FIELD_HINTS)


def extract_page(html: str, url: str) -> PageFacts:
    """Parse ``html`` served at ``url`` into PageFacts (rules in the module docstring)."""
    parser = _Extractor(url)
    parser.feed(html or "")
    parser.close()
    return parser.finish()


def normalize_for_match(text: str) -> str:
    """Lowercase, unicodedata NFKD, strip combining accents, collapse whitespace.

    'Inscripción ABIERTA' -> 'inscripcion abierta'. Used by VIS-04, VIS-17,
    EXT-25 and VIS-19 to compare with fixed word lists.
    """
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _collapse(stripped.lower())


_LINK_ITEM_RE = re.compile(r"<([^>]*)>")
_LINK_PARAM_RE = re.compile(r"""\s*;\s*([^\s=;,]+)\s*(?:=\s*("(?:[^"\\]|\\.)*"|[^;,]*))?""")


def parse_link_header(value: str) -> list[tuple[str, dict[str, str]]]:
    """Parse an HTTP Link header into (url, params) pairs; params keys lowercased (rel, hreflang)."""
    out: list[tuple[str, dict[str, str]]] = []
    if not value:
        return out
    pos = 0
    while True:
        m = _LINK_ITEM_RE.search(value, pos)
        if not m:
            break
        url = m.group(1).strip()
        pos = m.end()
        params: dict[str, str] = {}
        while True:
            pm = _LINK_PARAM_RE.match(value, pos)
            if not pm:
                break
            key = pm.group(1).lower()
            raw = (pm.group(2) or "").strip()
            if len(raw) >= 2 and raw[0] == raw[-1] == '"':
                raw = raw[1:-1].replace('\\"', '"')
            params.setdefault(key, raw)
            pos = pm.end()
        out.append((url, params))
        comma = value.find(",", pos)
        if comma < 0:
            break
        pos = comma + 1
    return out
