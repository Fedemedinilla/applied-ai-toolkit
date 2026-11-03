"""Contact paths: VIS-15 (button present), VIS-18 (WhatsApp number well written), VIS-21 (mail domain receives).

VIS-18 makes zero network requests: everything comes from the HTML already
downloaded (the home and the interna, which links.select_interna takes from the
contact page when the home links one); wa.me is never opened and nobody is
written to. Only the last 4 digits of a number are stored.

VIS-21 reads the DNS answers the collector got for the domains of the mailto:
links of the home and the interna (Observations.mail_domains). Only the domain
is kept, plus the full address when its local part is an institutional role
(links.ROLE_LOCAL_PARTS: info@, secretaria@, admisiones@...): that is the
organisation's published contact, never a person's.
FALLA only for a domain that cannot receive mail at all: it does not exist
(NXDOMAIN), it publishes a null MX ("0 .", RFC 7505), or it has neither MX nor
A/AAAA. A domain with no MX and an A or AAAA record still receives mail (RFC
5321 5.1): never a FALLA.

A FALLA of VIS-18 or VIS-21 is Amarillo (ColourException WHATSAPP_BROKEN and
MAIL_BOUNCES): a broken contact path is not a "Mejora opcional".
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, unquote, urlsplit

from .. import artifacts, domains
from ..doh import DnsStatus
from .. import kinds
from ..htmlextract import normalize_for_match
from ..model import ColourException, ReportPhrase, State
from . import common
from .common import new_finding, not_applicable, not_verified

if TYPE_CHECKING:
    from ..htmlextract import AnchorFacts, PageFacts
    from ..model import EvalContext, Finding
    from ..observations import MailDomainCheck, MailDomainSurvey, Observations

WHATSAPP_HREF_PATTERNS: tuple[str, ...] = (
    "wa.me/",
    "wa.link/",  # the WhatsApp link shortener, common in Latin America
    "api.whatsapp.com/send",
    "api.whatsapp.com/message/",  # WhatsApp Business short links
    "web.whatsapp.com/send",
    "whatsapp://send",
)
# Chat and WhatsApp widgets that build their button with JavaScript after the
# page loads: the HTML the check reads (fetched without running scripts) has no
# tel: or wa.me link, so the button cannot be seen, only presumed.
# Never a FALLA: with a widget like these, "there is no contact link" can be
# false. The list covers WhatsApp buttons and chat services (Tidio, Crisp,
# Zendesk, tawk.to) and their loader names. Hand-written lists of (what is matched, marker name kept
# in measured.plugin_marker). Only <script src> addresses and inline <script>
# loader snippets are read, never the page text.
# Hosts: a whole host name inside a script address or a loader snippet, so a
# subdomain counts (code.tidio.co) and a longer name does not (notidio.co,
# tidio.co.colegio.test).
WIDGET_SCRIPT_HOSTS: tuple[tuple[str, str], ...] = (
    ("elfsight.com", "elfsight"),  # Elfsight widgets, WhatsApp Chat among them (apps.elfsight.com, static.elfsight.com)
    ("elfsightcdn.com", "elfsight"),  # Elfsight's CDN, the platform.js of its newer embed code
    ("getbutton.io", "getbutton"),  # GetButton, WhatsApp and call buttons (static.getbutton.io; its snippet: host = "getbutton.io")
    ("whatshelp.io", "whatshelp"),  # WhatsHelp, GetButton's former name (static.whatshelp.io)
    ("tidio.co", "tidio"),  # Tidio live chat (code.tidio.co, widget.tidio.co)
    ("crisp.chat", "crisp"),  # Crisp chat (client.crisp.chat/l.js)
    ("zdassets.com", "zendesk"),  # Zendesk Web Widget and messaging (static.zdassets.com/ekr/snippet.js)
    ("zopim.com", "zendesk"),  # Zopim, the loader of the older Zendesk Chat (v2.zopim.com)
    ("tawk.to", "tawk.to"),  # tawk.to chat (embed.tawk.to)
    ("wati.io", "wati"),  # Wati, a WhatsApp Business chat widget
    ("wa.link", "wa.link"),  # the WhatsApp link shortener, used by floating-button scripts
)
# Loader names: a part of a script address (its folder or file name) or of an
# inline loader snippet, matched in lower case. "whatsapp" goes last: it names
# any other WhatsApp widget (a plugin folder, a CreateWhatsappChatWidget call).
WIDGET_LOADER_NAMES: tuple[tuple[str, str], ...] = (
    ("elfsight", "elfsight"),  # Elfsight's loader (platform.js) on any host, and its elfsight-app containers
    ("whatshelp", "whatshelp"),  # WhatsHelp's script names
    ("joinchat", "joinchat"),  # Joinchat (formerly WhatsApp me), WordPress plugin or a CDN copy (joinchat.min.js)
    ("click-to-chat", "click-to-chat"),  # Click to Chat for WhatsApp, WordPress plugin folder
    ("ht-ctc", "click-to-chat"),  # Click to Chat's script names (ht-ctc)
    ("chaty", "chaty"),  # Chaty, WordPress plugin (cht-front-script.js) and hosted widget (cdn.chaty.app)
    ("callbell", "callbell"),  # Callbell, WhatsApp chat for businesses (its include script)
    ("watiwidget", "wati"),  # Wati's loader script (watiWidget.js)
    ("tidio-live-chat", "tidio"),  # Tidio's WordPress plugin folder
    ("tawk_api", "tawk.to"),  # tawk.to's snippet: var Tawk_API = Tawk_API || {}
    ("$crisp", "crisp"),  # Crisp's snippet: window.$crisp = []
    ("zopim", "zendesk"),  # Zopim's snippet (window.$zopim) and its WordPress plugin folder
    ("whatsapp", "whatsapp"),  # any other WhatsApp widget script
)
# The marker names of chat services and multi-purpose widget platforms: the
# script says a chat or a widget loads, not that it offers WhatsApp or a phone,
# so the report does not say "El botón de WhatsApp" for them.
CHAT_WIDGET_MARKERS: frozenset[str] = frozenset({"elfsight", "tidio", "crisp", "zendesk", "tawk.to"})
_WIDGET_HOST_RES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(r"(?<![a-z0-9-])" + re.escape(host) + r"(?![a-z0-9.-])"), name) for host, name in WIDGET_SCRIPT_HOSTS
)
WHATSAPP_PLUGIN_MARKERS: tuple[str, ...] = (
    "joinchat",
    "ht-ctc",
    "click-to-chat",
    "qlwapp",
    "wp-whatsapp-chat",
    "nta-wa",
)


class NumberVerdict(StrEnum):
    OK = "ok"  # 54 + 9 + 10 national digits (13 digits)
    FAIL = "falla"  # a certain error: WhatsApp will not find the number
    REVIEW = "revisar"  # possibly fine (landline on WhatsApp Business) or not normalizable
    FOREIGN = "extranjero"  # another country code: ignored


@dataclass(frozen=True)
class NumberCheck:
    verdict: NumberVerdict
    last4: str  # the only part of the number ever stored
    reason: str  # English, for the evidence: "15-prefix", "missing-54", "549-plus-12", ...


_NON_DIGIT_RE = re.compile(r"[^0-9]")
# Numbers inside inline scripts and plugin configs.
_SCRIPT_WA_RE = re.compile(r"wa\.me/([+0-9 -]{8,})")
_SCRIPT_PHONE_RE = re.compile(r"phone=([^&\"'\s<>]{8,})")
_JSON_PHONE_RE = re.compile(r'"(?:telephone|phone|number|phone_number|whatsapp|tel)"\s*:\s*"([^"]{8,})"', re.IGNORECASE)
# A phone written as plain text (VIS-15 flag only; nothing is stored).
_PLAIN_PHONE_RE = re.compile(
    r"(?:\b(?:tel|telefono|telefonos|whatsapp|cel|celular|movil)\b\.?:?\s*)(\+?\d[\d\s().-]{6,}\d)"
)


def _has_fifteen(national: str) -> bool:
    """A 15 mobile prefix right after a 2, 3 or 4 digit area code."""
    return any(national[i : i + 2] == "15" for i in (2, 3, 4))


def classify_whatsapp_number(raw: str) -> NumberCheck:
    """Classify the number of a WhatsApp link for Argentina.

    First the digits (re.sub("[^0-9]", "", raw)) are classified:
      54 + 9 + 10 digits (13 total)                 -> OK
      54 + 12 digits without the 9 (14 total, with
        15 or 0 inside)                              -> FAIL
      549 + 12 digits (15 total)                     -> FAIL
      10 digits without 54                           -> FAIL (wa.me reads them as another country)
      54 + 10 digits without the 9 (12 total)        -> REVIEW (WhatsApp Business landline)
      another country code (not starting with 54 and not 10 digits) -> FOREIGN
      anything else                                  -> REVIEW
    Then separators: when the digits gave OK but ``raw`` has non-digit
    characters (+, spaces, hyphens), the verdict becomes REVIEW (the judge: not
    a certain failure, not a certain pass). A FAIL on the digits stays FAIL.

    A number that starts with 0 has no country code at all (no country code
    starts with 0): it is classified like the 10 digits without 54 (FAIL).
    """
    digits = _NON_DIGIT_RE.sub("", raw or "")
    last4 = digits[-4:]
    if not digits:
        return NumberCheck(NumberVerdict.REVIEW, "", "no-digits")
    if digits.startswith("54"):
        n = len(digits)
        national = digits[2:]
        if n == 13 and digits[2] == "9":
            verdict, reason = NumberVerdict.OK, "ok"
        elif n == 15 and digits.startswith("549"):
            verdict = NumberVerdict.FAIL
            reason = "15-prefix" if _has_fifteen(digits[3:]) else "549-plus-12"
        elif n == 14 and digits[2] != "9":
            verdict = NumberVerdict.FAIL
            if national.startswith("0"):
                reason = "0-prefix"
            elif _has_fifteen(national):
                reason = "15-prefix"
            else:
                reason = "54-plus-12"
        elif n == 13 and national.startswith("0"):
            verdict, reason = NumberVerdict.FAIL, "0-prefix"
        elif n == 12 and digits[2] != "9":
            verdict, reason = NumberVerdict.REVIEW, "54-plus-10"
        else:
            verdict, reason = NumberVerdict.REVIEW, "unexpected-length"
    elif len(digits) == 10:
        verdict, reason = NumberVerdict.FAIL, "missing-54"
    elif digits.startswith("0"):
        verdict, reason = NumberVerdict.FAIL, "leading-0"
    else:
        verdict, reason = NumberVerdict.FOREIGN, "other-country"
    if verdict == NumberVerdict.OK and _NON_DIGIT_RE.search(raw or ""):
        verdict, reason = NumberVerdict.REVIEW, "separators"
    return NumberCheck(verdict, last4, reason)


def _is_whatsapp_href(href: str) -> bool:
    low = (href or "").lower()
    return any(p in low for p in WHATSAPP_HREF_PATTERNS)


def _number_from_href(href: str) -> str | None:
    """The raw number of a WhatsApp link (path of wa.me, phone= of the others)."""
    h = (href or "").strip()
    low = h.lower()
    if "wa.me/" in low:
        path = h[low.index("wa.me/") + len("wa.me/") :]
        path = path.split("?", 1)[0].split("#", 1)[0].strip("/")
        raw = unquote(path)
        return raw or None
    parts = urlsplit(h)
    query = parts.query
    if not query and "?" in h:
        query = h.split("?", 1)[1]
    values = parse_qs(query, keep_blank_values=False).get("phone")
    if values:
        return values[0]
    m = re.search(r"phone=([^&#]+)", h)
    return unquote(m.group(1)) if m else None


def _has_prefilled_text(href: str) -> bool:
    return "text=" in (href or "").lower()


def _plugin_marker(page: "PageFacts") -> str | None:
    for token in sorted(page.class_id_tokens):
        for marker in WHATSAPP_PLUGIN_MARKERS:
            if marker in token:
                return marker
    return None


def _widget_name(text: str) -> str | None:
    """The marker name of a widget host or loader name in a script address or loader snippet, or None."""
    low = text.lower()
    for pattern, name in _WIDGET_HOST_RES:
        if pattern.search(low):
            return name
    for loader, name in WIDGET_LOADER_NAMES:
        if loader in low:
            return name
    return None


def _widget_marker(page: "PageFacts") -> str | None:
    """A chat or WhatsApp widget loader that builds its button with JavaScript, or None.

    The <script src> addresses first, then the inline scripts (loader
    snippets), in document order; WIDGET_SCRIPT_HOSTS before
    WIDGET_LOADER_NAMES within each. The visible text is never read.
    """
    for text in (*page.script_srcs, *page.inline_scripts):
        name = _widget_name(text)
        if name is not None:
            return name
    return None


def _contact_anchors(page: "PageFacts") -> tuple[list["AnchorFacts"], list["AnchorFacts"]]:
    tel = [a for a in page.anchors if a.scheme == "tel"]
    wa = [a for a in page.anchors if _is_whatsapp_href(a.href)]
    return tel, wa


def evaluate_vis15(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-15 · contacto en un toque.

    tel: and WhatsApp anchors (WHATSAPP_HREF_PATTERNS), plugin markers in
    class/id tokens (WHATSAPP_PLUGIN_MARKERS), widget scripts (WIDGET_SCRIPT_HOSTS
    and WIDGET_LOADER_NAMES in script addresses and inline loader snippets,
    never the page text), footer region. Presence and location only; phone-like
    plain text without a link is recorded as a flag.
    APROBADO: a tel: or WhatsApp link in the home AND inside the footer.
    APROBADO_CON_OBSERVACION (Azul): link not in the footer, footer not
    identified, only a plugin or widget marker (its name in
    measured.plugin_marker; a chat service or a multi-purpose widget platform,
    CHAT_WIDGET_MARKERS, is not called a WhatsApp button in the report), or a
    phone in plain text with no link.
    FALLA: no tel:, no WhatsApp link and no plugin or widget marker.
    Limit: a button that a script outside the lists builds is invisible to
    this check, so a FALLA is worth a look in a phone browser.
    """
    spec = common.spec_of("VIS-15")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    kind = kinds.of(ctx.kind)
    tel, wa = _contact_anchors(page)
    links = tel + wa
    in_footer = [a for a in links if a.in_footer]
    marker = _plugin_marker(page) or _widget_marker(page)
    plain_phone = bool(_PLAIN_PHONE_RE.search(normalize_for_match(page.nonlink_text)))
    measured = {
        "tel_links": len(tel),
        "whatsapp_links": len(wa),
        "in_footer": len(in_footer),
        "footer_found": page.footer_found,
        "plugin_marker": marker,
        "phone_plain_text": plain_phone,
    }
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    if not links and marker is None:
        if plain_phone:
            return new_finding(
                spec,
                State.APROBADO_CON_OBSERVACION,
                measured=measured,
                evidence=evidence,
                reason="teléfono sin enlace",
                phrase_report=ReportPhrase(
                    found="El teléfono aparece escrito, pero sin un botón para llamar o escribir con un toque",
                    consequence=f"Desde el celular, {kind.audience} tienen que copiar el número a mano",
                    action="Agregar un botón de WhatsApp con mensaje prearmado y el teléfono con enlace en el pie",
                    who="Quien mantiene el sitio",
                ),
            )
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="La página principal no tiene un botón para llamar ni para escribir por WhatsApp",
                consequence=f"Desde el celular, {kind.audience} tienen que copiar el número a mano o buscarlo en otra página",
                action="Agregar un botón de WhatsApp con mensaje prearmado y el teléfono con enlace en el pie",
                who="Quien mantiene el sitio",
            ),
        )
    if in_footer:
        if tel and wa:
            found = "Hay botones para llamar y para escribir por WhatsApp en la página principal, y uno de ellos en el pie"
        elif wa:
            found = "Hay un botón de WhatsApp en la página principal y en el pie"
        else:
            found = "Hay un botón de llamada en la página principal y en el pie"
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(found=found, consequence=f"{kind.Audience} llegan en un toque"),
        )
    if not links and marker in CHAT_WIDGET_MARKERS:
        found = (
            "Hay un chat o un complemento que se arma al cargar la página; desde el código no se puede ver si ofrece "
            "WhatsApp o un teléfono"
        )
    elif not links:
        found = "El botón de WhatsApp se arma al cargar la página y no se pudo ver en el código"
    elif not page.footer_found:
        found = "Hay un botón para llamar o escribir por WhatsApp; el pie de la página no se pudo identificar"
    else:
        found = "Hay un botón para llamar o escribir por WhatsApp, pero no está en el pie de la página"
    return new_finding(
        spec,
        State.APROBADO_CON_OBSERVACION,
        measured=measured,
        evidence=evidence,
        reason="botón fuera del pie o no confirmado",
        phrase_report=ReportPhrase(
            found=found,
            consequence=f"Desde el celular, parte de {kind.audience} no encuentra cómo comunicarse en un toque",
            action="Agregar el teléfono con enlace en el pie",
            who="Quien mantiene el sitio",
        ),
    )


def _numbers_of(page: "PageFacts") -> tuple[list[tuple[str, str]], bool]:
    """(raw number, source) pairs from WhatsApp hrefs, inline scripts and plugin configs."""
    found: list[tuple[str, str]] = []
    prefilled = False
    for a in page.anchors:
        if _is_whatsapp_href(a.href):
            raw = _number_from_href(a.href)
            if raw:
                found.append((raw, "enlace"))
            prefilled = prefilled or _has_prefilled_text(a.href)
    for script in page.inline_scripts:
        for m in _SCRIPT_WA_RE.finditer(script):
            found.append((m.group(1).strip(), "script"))
        for m in _SCRIPT_PHONE_RE.finditer(script):
            found.append((unquote(m.group(1)).strip(), "script"))
    for name, value, tokens in page.data_attrs:
        whatsapp_element = "whatsapp" in name or any(mk in tokens for mk in WHATSAPP_PLUGIN_MARKERS)
        if not whatsapp_element:
            continue
        for m in _JSON_PHONE_RE.finditer(value):
            found.append((m.group(1).strip(), "complemento"))
        if any(h in name for h in ("phone", "number", "tel", "whatsapp")) and len(_NON_DIGIT_RE.sub("", value)) >= 8 and "{" not in value:
            found.append((value.strip(), "complemento"))
    return found, prefilled


def evaluate_vis18(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-18 · botón de WhatsApp con el número bien escrito.

    Numbers from WhatsApp hrefs (path of wa.me/<n>, phone= of api/web.whatsapp)
    and from plugin JSON in inline scripts (regex wa.me/([+0-9 -]+) and
    phone=([^&"']+)). Each classified with classify_whatsapp_number; FOREIGN
    ignored. NO_APLICA when there is no WhatsApp number at all (VIS-15 covers
    the absence). FALLA when any number is FAIL (certain error).
    APROBADO_CON_OBSERVACION (Azul) when the worst is REVIEW, or two different
    numbers appear. APROBADO when every number is OK. measured: numbers as
    [{"last4", "verdict", "reason", "source"}], has_prefilled_text.
    measured.numeros_distintos counts distinct numbers, failing or not.

    The numbers of the interna count too (interna_page: the contact page when
    the home links one): each number records its pages ("inicio", "interna"),
    the interna HTML joins the evidence when a number comes from it, and
    measured.paginas_falla and interna_url say where to tap to confirm it by
    hand. The sentence already says "el sitio".
    """
    spec = common.spec_of("VIS-18")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    raw_numbers, prefilled = _numbers_of(page)
    found_on: list[tuple[str, str, str]] = [(raw, source, "inicio") for raw, source in raw_numbers]
    interna = interna_page(obs, ctx)
    if interna is not None:
        interna_numbers, interna_prefilled = _numbers_of(interna)
        found_on += [(raw, source, "interna") for raw, source in interna_numbers]
        prefilled = prefilled or interna_prefilled
    checks: list[tuple[NumberCheck, str, str, str]] = []  # (check, source, digits key, page)
    for raw, source, where in found_on:
        c = classify_whatsapp_number(raw)
        if c.verdict == NumberVerdict.FOREIGN:
            continue
        checks.append((c, source, _NON_DIGIT_RE.sub("", raw), where))
    # One entry per distinct number (digits), worst verdict kept, with every page it is on.
    rank = {NumberVerdict.FAIL: 0, NumberVerdict.REVIEW: 1, NumberVerdict.OK: 2}
    by_number: dict[str, tuple[NumberCheck, str]] = {}
    pages_of: dict[str, list[str]] = {}
    for c, source, key, where in checks:
        prev = by_number.get(key)
        if prev is None or rank[c.verdict] < rank[prev[0].verdict]:
            by_number[key] = (c, source)
        if where not in pages_of.setdefault(key, []):
            pages_of[key].append(where)
    # The same number written with and without the 54/9 normalizes to the same last 10 digits.
    distinct_national = {k[-10:] for k in by_number}
    measured = {
        "numbers": [
            {"last4": c.last4, "verdict": c.verdict.value, "reason": c.reason, "source": source, "paginas": pages_of[key]}
            for key, (c, source) in by_number.items()
        ],
        "has_prefilled_text": prefilled,
        "numeros_distintos": len(distinct_national),
    }
    if not by_number:
        return not_applicable(spec, "el sitio no tiene un botón de WhatsApp con número a la vista", measured=measured)
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    if any("interna" in pages for pages in pages_of.values()):
        evidence.append(common.page_evidence(obs.interna, artifacts.INTERNA_HTML))
        measured["interna_url"] = obs.interna.url if obs.interna is not None else None
    verdicts = [c.verdict for c, _ in by_number.values()]
    if NumberVerdict.FAIL in verdicts:
        failing = [c for c, _ in by_number.values() if c.verdict == NumberVerdict.FAIL]
        measured["motivos_falla"] = sorted({c.reason for c in failing})
        # Where the failing numbers are, so a hand check knows which page to open.
        measured["paginas_falla"] = sorted(
            {where for key, (c, _src) in by_number.items() if c.verdict == NumberVerdict.FAIL for where in pages_of[key]}
        )
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            colour_exception=ColourException.WHATSAPP_BROKEN,
            phrase_report=ReportPhrase(
                found="El botón de WhatsApp del sitio lleva a un número mal escrito, y WhatsApp no lo reconoce",
                consequence="Quien toca el botón abre un chat que no existe y no puede escribir",
                action="Corregir el número en el botón: 549, el código de área sin el 0 y el número sin el 15",
                who="Quien mantiene el sitio",
            ),
        )
    if NumberVerdict.REVIEW in verdicts or len(distinct_national) > 1:
        found = (
            "El sitio usa dos números de WhatsApp distintos"
            if len(distinct_national) > 1
            else "El número del botón de WhatsApp tiene un formato que conviene revisar"
        )
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="número para revisar",
            phrase_report=ReportPhrase(
                found=found,
                consequence="Puede que el botón no lleve al chat esperado",
                action="Probar el botón desde un celular y corregir el número si hace falta",
                who="Quien mantiene el sitio",
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found="El botón de WhatsApp lleva a un número bien escrito",
            consequence=f"{kinds.of(ctx.kind).Audience} escriben en un toque",
        ),
    )


def interna_page(obs: "Observations", ctx: "EvalContext") -> "PageFacts | None":
    """The parsed interna when it was read whole (VIS-18 and VIS-21 read its links).

    None when there is no interna, when it could not be parsed (an error, a
    challenge: evaluate.build_pages), or when it arrived truncated (a cut body
    could cut a number or an address in half).
    """
    if obs.interna is None or obs.interna.response is None:
        return None
    resp = obs.interna.response
    if resp.truncated or resp.short_body:
        return None
    return ctx.pages.get("interna")


# ---------------------------------------------------------------------------
# VIS-21: a published mail address whose domain cannot receive mail
# ---------------------------------------------------------------------------

# Per-domain verdicts (mail_domain_verdict). Only DOMAIN_FAILS are a FALLA.
DOMAIN_MISSING = "no-existe"  # NXDOMAIN on the MX question
DOMAIN_NULL_MX = "mx-nulo"  # a null MX ("0 ."): the domain says it receives no mail (RFC 7505)
DOMAIN_NOWHERE = "sin-mx-ni-a"  # no MX, no A, no AAAA: nowhere to deliver
DOMAIN_RECEIVES_MX = "recibe-mx"
DOMAIN_RECEIVES_A = "recibe-a"  # no MX, but an A/AAAA address: RFC 5321 fallback, it receives
DOMAIN_UNKNOWN = "sin-dato"  # an error, a SERVFAIL, or answers that contradict each other
DOMAIN_FAILS: tuple[str, ...] = (DOMAIN_MISSING, DOMAIN_NULL_MX, DOMAIN_NOWHERE)
_DOMAIN_WHY: dict[str, str] = {
    DOMAIN_MISSING: "ese dominio no existe",
    DOMAIN_NULL_MX: "ese dominio declara que no recibe correo",
    DOMAIN_NOWHERE: "ese dominio no tiene un servidor de correo ni una dirección donde recibirlo",
}
REASON_VIS21_NOT_ASKED = "los dominios de las direcciones de correo del sitio no se consultaron en esta corrida"
REASON_VIS21_NO_CONTROL = "la consulta de control del correo falló; se repite"
REASON_VIS21_SHARED = "el sitio está en un dominio compartido y los dominios de correo no se consultaron"
REASON_VIS21_DNS = "la consulta del dominio de una dirección de correo no respondió; se repite"
# The failing mail domain is the site's own (its registrable domain or one of its
# hosts) while the home loaded. That domain answers on the web, so a "does not
# exist" or "nowhere to receive mail" for it is more likely a bad DNS answer than
# a fact: no data.
REASON_VIS21_OWN_DOMAIN = (
    "el DNS dio una respuesta sobre el correo del propio dominio del sitio que no se pudo confirmar; se revisa a mano"
)
NOTE_VIS21_OWN_DOMAIN = (
    "La dirección que falla es del propio dominio del sitio (@{dominio}) y la página de inicio cargó. Consultar el "
    "registro MX de {dominio} en una herramienta de DNS antes de decir nada."
)
NA_VIS21_NONE = "la página de inicio y la página interna no publican direcciones de correo"
# Without the interna read whole, only the home is known.
NA_VIS21_NONE_INTERNA_UNREAD = "la página de inicio no publica direcciones de correo (la página interna no se pudo leer entera)"
NA_VIS21_NONE_NO_INTERNA = "la página de inicio no publica direcciones de correo (no se leyó otra página del sitio)"
NA_VIS21_FREE = "las direcciones de correo publicadas son de un servicio gratuito, que siempre recibe correo"


def _null_mx(records: list[str]) -> bool:
    """True for a null MX: every record has an empty exchanger ("0 ." is normalized to "0 ")."""
    if not records:
        return False
    for record in records:
        parts = record.split()
        host = parts[1] if len(parts) >= 2 else ""
        if host.strip(".") != "":
            return False
    return True


def mail_domain_verdict(check: "MailDomainCheck") -> str:
    """The verdict of one mailto: domain from its DNS answers (the DOMAIN_* constants).

    Never a guess: anything but a clean answer, or answers that contradict each
    other (an NXDOMAIN for A after a NODATA for MX), is DOMAIN_UNKNOWN.
    """
    mx = check.mx
    if mx is None:
        return DOMAIN_UNKNOWN
    if mx.status is DnsStatus.NXDOMAIN:
        return DOMAIN_MISSING
    if mx.status is DnsStatus.NOERROR:
        return DOMAIN_NULL_MX if _null_mx(mx.records) else DOMAIN_RECEIVES_MX
    if mx.status is not DnsStatus.NODATA:
        return DOMAIN_UNKNOWN
    a = check.a
    if a is None or a.status not in (DnsStatus.NOERROR, DnsStatus.NODATA):
        return DOMAIN_UNKNOWN
    if a.status is DnsStatus.NOERROR:
        return DOMAIN_RECEIVES_A
    aaaa = check.aaaa
    if aaaa is None or aaaa.status not in (DnsStatus.NOERROR, DnsStatus.NODATA):
        return DOMAIN_UNKNOWN
    return DOMAIN_RECEIVES_A if aaaa.status is DnsStatus.NOERROR else DOMAIN_NOWHERE


def institutional_addresses(findings: "list[Finding]") -> frozenset[str]:
    """The institutional role addresses VIS-21 measured in this run, lowercased.

    They are the only addresses of the site that a report or datos.json may
    carry. A person's address is never in
    measured, so it is never here.
    """
    out: set[str] = set()
    for f in findings:
        if f.id != "VIS-21" or not isinstance(f.measured, dict):
            continue
        for entry in f.measured.get("dominios") or []:
            if isinstance(entry, dict) and isinstance(entry.get("direccion"), str):
                out.add(entry["direccion"].lower())
        if isinstance(f.measured.get("direccion_mail"), str):
            out.add(f.measured["direccion_mail"].lower())
    return frozenset(out)


def _page_key(page: str, survey: "MailDomainSurvey") -> str:
    """Where an address was found, as datos.json names it: "inicio", "contacto" or "otra"."""
    if page == "inicio":
        return "inicio"
    return "contacto" if survey.interna_kind == "contacto" else "otra"


def site_domains(obs: "Observations") -> frozenset[str]:
    """The site's own names (ASCII, lower case): its site domain, its registrable domain and its hosts.

    A mail domain among them that "cannot receive mail" while the home loaded
    is a DNS answer to doubt, not a finding (REASON_VIS21_OWN_DOMAIN).
    """
    names: set[str] = set()
    for raw in (obs.registrable, obs.canonical_host, obs.other_host, obs.canonical_url, obs.input_url):
        if not raw:
            continue
        try:
            host = domains.host_of(raw) if "://" in raw else domains.normalize_host(raw)
        except ValueError:
            continue
        names.add(host)
        try:
            names.add(domains.registrable_domain(host))
        except ValueError:
            pass
    return frozenset(names)


def _display_address(check: "MailDomainCheck") -> str | None:
    """The institutional role address of ``check`` with its domain decoded, or None."""
    if not check.role_local:
        return None
    return f"{check.role_local}@{domains.decode_idn(check.domain)}"


def evaluate_vis21(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-21 · las direcciones de correo publicadas pueden recibir mails.

    Observations.mail_domains (collect.check_mail_domains). NO_VERIFICADO
    without the home, when the step did not run, without a good control lookup
    (or on a shared domain), or when a domain's answer is unknown and none
    fails. NO_APLICA when the home and the interna publish no mailto: address
    (the reason says so only when the interna was read whole), or only free
    mail services. FALLA (Amarillo, ColourException.MAIL_BOUNCES) when a domain
    is in DOMAIN_FAILS (the first one, in document order, is the one measured
    in detail); APROBADO otherwise. measured: dominios [{dominio, paginas,
    veredicto, and direccion only for a role address}], gratuitos and
    fuera_del_tope (counts), and for a FALLA dominio_mail, veredicto_mail,
    paginas_mail, pagina_mail ("inicio", "contacto" or "otra"), direccion_mail
    (a role address or None) and interna_url. Never a person's address.

    A failing verdict for the site's own
    domain (site_domains) is no data, since the home loaded: its entry says
    "sin-dato" with the DNS verdict in veredicto_dns, and with no other failing
    domain the result is NO_VERIFICADO (REASON_VIS21_OWN_DOMAIN, internal note
    NOTE_VIS21_OWN_DOMAIN).
    """
    spec = common.spec_of("VIS-21")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    survey = obs.mail_domains
    if survey is None:
        return not_verified(spec, REASON_VIS21_NOT_ASKED)
    # The site's own domain answers on the web (the home loaded): a failing verdict
    # for it is no data, kept as veredicto_dns.
    own_names = site_domains(obs)
    verdicts: list[tuple["MailDomainCheck", str]] = []
    own_failing: list[tuple["MailDomainCheck", str]] = []
    for c in survey.checked:
        v = mail_domain_verdict(c)
        if v in DOMAIN_FAILS and c.domain.strip(".").lower() in own_names:
            own_failing.append((c, v))
            v = DOMAIN_UNKNOWN
        verdicts.append((c, v))
    doubted = {id(c): v for c, v in own_failing}
    entries: list[dict[str, Any]] = []
    for c, v in verdicts:
        entry: dict[str, Any] = {"dominio": c.domain, "paginas": list(c.pages), "veredicto": v}
        if id(c) in doubted:
            entry["veredicto_dns"] = doubted[id(c)]
        address = _display_address(c)
        if address is not None:
            entry["direccion"] = address
        entries.append(entry)
    measured: dict[str, Any] = {
        "dominios": entries,
        "gratuitos": len(survey.free_mail),
        "fuera_del_tope": len(survey.over_cap),
    }
    if not survey.checked:
        if survey.free_mail:
            reason = NA_VIS21_FREE
        elif survey.interna_read:
            reason = NA_VIS21_NONE
        elif obs.interna is not None:
            reason = NA_VIS21_NONE_INTERNA_UNREAD
        else:
            reason = NA_VIS21_NONE_NO_INTERNA
        return not_applicable(spec, reason, measured=measured)
    if survey.not_queried == "shared-domain":
        return not_verified(spec, REASON_VIS21_SHARED, measured=measured)
    if survey.not_queried is not None:
        return not_verified(spec, REASON_VIS21_NO_CONTROL, measured=measured)
    evidence = [artifacts.MAIL_DOMAINS, common.page_evidence(obs.home, artifacts.HOME_HTML)]
    failing = [(c, v) for c, v in verdicts if v in DOMAIN_FAILS]
    if failing:
        first, verdict = failing[0]
        shown = domains.decode_idn(first.domain)
        if "interna" in first.pages:
            evidence.append(common.page_evidence(obs.interna, artifacts.INTERNA_HTML))
        address = _display_address(first)
        where = (first.role_page if address is not None and first.role_page else None) or (first.pages or ["inicio"])[0]
        page_key = _page_key(where, survey)
        measured.update(
            {
                "dominio_mail": shown,
                "veredicto_mail": verdict,
                "paginas_mail": list(first.pages),
                "pagina_mail": page_key,
                "direccion_mail": address,
                "interna_url": obs.interna.url if ("interna" in first.pages and obs.interna is not None) else None,
            }
        )
        trace = {"{dominio}": "checks[VIS-21].measured.dominio_mail"}
        if len(failing) == 1:
            found = f"Una dirección de correo publicada en el sitio termina en @{shown}, y {_DOMAIN_WHY[verdict]}"
        else:
            clauses = "; ".join(f"@{domains.decode_idn(c.domain)}: {_DOMAIN_WHY[v]}" for c, v in failing)
            found = f"Hay direcciones de correo publicadas en el sitio cuyos dominios no pueden recibir mails ({clauses})"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            colour_exception=ColourException.MAIL_BOUNCES,
            trace=trace,
            phrase_report=ReportPhrase(
                found=found,
                consequence="Lo que escriben a esa dirección no llega, y quien escribe se queda sin respuesta",
                action="Corregir la dirección en el sitio o hacer que ese dominio reciba correo",
                who="Quien administra el dominio",
            ),
        )
    if own_failing:
        own = domains.decode_idn(own_failing[0][0].domain)
        return not_verified(
            spec,
            REASON_VIS21_OWN_DOMAIN,
            measured=measured,
            evidence=evidence,
            internal_note=NOTE_VIS21_OWN_DOMAIN.format(dominio=own),
        )
    if any(v == DOMAIN_UNKNOWN for _c, v in verdicts):
        return not_verified(spec, REASON_VIS21_DNS, measured=measured)
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found="Los dominios de las direcciones de correo publicadas tienen dónde recibir mails",
            consequence="Lo que escriben tiene a dónde llegar; cada casilla en sí no se puede comprobar desde afuera",
        ),
    )
