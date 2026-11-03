"""Spanish formatting of measured values for client text, and the local clock.

Rules: Argentina time as a FIXED offset, timezone(timedelta(hours=-3)),
because zoneinfo needs the tzdata package on Windows and
Argentina has no DST since 2009. Header dates d/m/aaaa; dates in
text "6 de diciembre de 2026"; decimal comma; rounding HALF UP (like PageSpeed
shows: 4830 ms -> "4,8"), never Python's banker's rounding. 1 MB = 1,048,576
bytes (matches PSI's KiB/MiB).
"""

from __future__ import annotations

import datetime as dt
import html
import math
import re
import unicodedata
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal

ART = dt.timezone(dt.timedelta(hours=-3), "ART")

MONTHS_ES: tuple[str, ...] = (
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
)

MIB = 1_048_576

# Characters that must never reach client text from site text (dashes of every
# width, plus the minus sign), replaced by a plain hyphen.
_DASH_CHARS = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"
# Double quotes of every kind found in site text (straight, curly, low-9).
_DOUBLE_QUOTES = '"“”„‟'
_EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+")  # lookbehind: linear, same matches
_SPACE_RE = re.compile(r"\s+")
# A URL in site text: any scheme with "://", the common bare schemes, or www.
_URL_RE = re.compile(r"(?:\b[a-z][a-z0-9+.-]*://|\b(?:javascript|data|mailto|tel|vbscript):|\bwww\.)[^\s<>\"'«»()\[\]]*", re.IGNORECASE)


def now_utc() -> dt.datetime:
    """Timezone-aware current UTC time.

    The one clock of a run: the run date (pipeline), the RDAP and TLS day counts
    (collect, tlsprobe) all read it here, so patching it pins every date at once.
    """
    return dt.datetime.now(dt.timezone.utc)


def to_local(moment: dt.datetime) -> dt.datetime:
    """Convert an aware datetime to ART. ValueError for naive datetimes."""
    if moment.tzinfo is None or moment.tzinfo.utcoffset(moment) is None:
        raise ValueError("naive datetime: an aware datetime is required")
    return moment.astimezone(ART)


def local_date(moment: dt.datetime) -> dt.date:
    """The ART calendar date of an aware datetime (the run date and the salidas folder name)."""
    return to_local(moment).date()


def fecha_dmy(day: dt.date) -> str:
    """8/10/2026 (no leading zeros)."""
    return f"{day.day}/{day.month}/{day.year}"


def fecha_larga(day: dt.date) -> str:
    """6 de diciembre de 2026."""
    return f"{day.day} de {MONTHS_ES[day.month - 1]} de {day.year}"


def mes_anio(day: dt.date) -> str:
    """noviembre de 2022 (EXT-02 branch month)."""
    return f"{MONTHS_ES[day.month - 1]} de {day.year}"


def hora(moment: dt.datetime) -> str:
    """14:05 in ART (24 h, zero-padded minutes)."""
    local = to_local(moment)
    return f"{local.hour}:{local.minute:02d}"


def _to_decimal(value: float | int | Decimal) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    # repr gives the shortest string that round-trips, so 4.85 stays 4.85
    # (Decimal(4.85) would be 4.8499999... and round down).
    return Decimal(repr(float(value)))


def _format_decimal(d: Decimal, decimals: int, rounding: str = ROUND_HALF_UP) -> str:
    quantum = Decimal(1).scaleb(-decimals) if decimals > 0 else Decimal(1)
    q = d.quantize(quantum, rounding=rounding)
    negative = q < 0
    text = format(abs(q), "f")
    if "." in text:
        int_part, frac_part = text.split(".", 1)
    else:
        int_part, frac_part = text, ""
    if len(int_part) >= 5:  # 10.000 and above get thousands dots; 9999 does not
        groups = []
        while len(int_part) > 3:
            groups.insert(0, int_part[-3:])
            int_part = int_part[:-3]
        groups.insert(0, int_part)
        int_part = ".".join(groups)
    out = int_part + ("," + frac_part if frac_part else "")
    if negative and q != 0:
        out = "-" + out
    return out


def decimal_es(value: float, decimals: int = 1) -> str:
    """Round half up and use a decimal comma: 4.85 -> '4,9'; 0.1 -> '0,1'; decimals=0 -> '5'.

    No thousands separator below 10,000; above, a dot every three digits
    (12.345). Negative values keep the sign.
    """
    return _format_decimal(_to_decimal(value), decimals)


def decimal_es_up(value: float, decimals: int = 1) -> str:
    """Like decimal_es, rounding UP (a value just above a threshold never prints as the threshold)."""
    return _format_decimal(_to_decimal(value), decimals, ROUND_CEILING)


def ms_to_s(ms: float) -> str:
    """Milliseconds as seconds with one decimal: 4830 -> '4,8'; 2500 -> '2,5'; 180 -> '0,2'."""
    return _format_decimal(_to_decimal(ms) / Decimal(1000), 1)


def bytes_to_mb(n: int, decimals: int = 1) -> str:
    """Bytes as MB (1 MB = 1,048,576 bytes), decimal comma: 2_621_440 -> '2,5'."""
    return _format_decimal(Decimal(int(n)) / Decimal(MIB), decimals)


def bytes_to_kb(n: int) -> str:
    """Bytes as whole KB (1 KB = 1024 bytes), half up: 384_000 -> '375'."""
    return _format_decimal(Decimal(int(n)) / Decimal(1024), 0)


def cls_es(value: float) -> str:
    """CLS with two decimals and a comma: 0.05 -> '0,05'; 0.1 -> '0,10'."""
    return _format_decimal(_to_decimal(value), 2)


def whole_months_between(earlier: dt.date, later: dt.date) -> int:
    """Whole calendar months from ``earlier`` to ``later`` (VIS-16 n_meses); 0 if later < earlier."""
    if later < earlier:
        return 0
    months = (later.year - earlier.year) * 12 + (later.month - earlier.month)
    if later.day < earlier.day:
        months -= 1
    return max(0, months)


def whole_years_between(earlier: dt.date, later: dt.date) -> int:
    """floor((later - earlier).days / 365.25) (EXT-02 n_anios)."""
    return math.floor((later - earlier).days / 365.25)


def _strip_controls(text: str) -> str:
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        if cat in ("Cc", "Cf", "Cs", "Co") and ch not in "\t\n\r":
            continue
        out.append(ch)
    return "".join(out)


def sanitize_site_text(text: str, max_len: int = 120) -> str:
    """Make text taken from the measured site safe to quote in client text.

    html.unescape, replace U+2013 and U+2014 with "-" (titles often use an en
    dash as separator; client text must not contain dashes), drop control
    characters, collapse whitespace, strip, and cut at ``max_len`` characters on
    a word boundary adding "...". Never returns an e-mail address: any
    ``x@y.z`` is replaced by "[correo]".

    Curly braces become parentheses, so a site title can never look like an
    unfilled placeholder to the text control.

    Links and tags never travel: "<" and ">" are
    dropped, square brackets become parentheses (no Markdown link), and any
    URL (scheme://..., www....) is replaced by "[enlace]". The text has
    already been decoded once by the HTML parser, so a second html.unescape
    can only produce "<" and ">", which are dropped here.

    Inner double quotes (straight and curly) become single quotes, so quoted
    site text never closes the quotation early.
    """
    return _sanitize(text, max_len, keep_urls=False)


def sanitize_site_url(text: str, max_len: int = 120) -> str:
    """sanitize_site_text for an address the report shows ON PURPOSE (a host, a variant, a canonical URL).

    The address stays readable; tags, brackets, quotes, control characters and
    e-mail addresses are still removed, so it can never become Markdown or HTML.
    """
    return _sanitize(text, max_len, keep_urls=True)


def _sanitize(text: str, max_len: int, *, keep_urls: bool) -> str:
    if not text:
        return ""
    t = html.unescape(text)
    for ch in _DASH_CHARS:
        t = t.replace(ch, "-")
    t = _strip_controls(t)
    t = t.replace("{", "(").replace("}", ")")
    if keep_urls:
        t = t.replace('"', "").replace("'", "").replace("`", "")
    else:
        t = _URL_RE.sub("[enlace]", t)
        # Quoted site text sits between straight double quotes: inner double
        # quotes (straight or curly) become single ones, so the quote never closes
        # early.
        for ch in _DOUBLE_QUOTES:
            t = t.replace(ch, "'")
    t = t.replace("<", " ").replace(">", " ").replace("[", "(").replace("]", ")")
    t = t.replace("(enlace)", "[enlace]")
    t = _SPACE_RE.sub(" ", t).strip()
    t = _EMAIL_RE.sub("[correo]", t)
    if max_len > 0 and len(t) > max_len:
        cut = t[:max_len]
        space = cut.rfind(" ")
        if space > max_len // 3:
            cut = cut[:space]
        cut = cut.rstrip(" ,;:.-")
        t = cut + "..."
    return t
