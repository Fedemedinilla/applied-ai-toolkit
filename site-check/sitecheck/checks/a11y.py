"""Basic accessibility: VIS-10, VIS-11, VIS-12, VIS-13 (VIS module: FALLA is Azul).

Lighthouse audits come from the median mobile PSI run through psi.find_audit;
an absent audit is a missing sub-measure, never a pass.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from .. import artifacts, kinds
from ..model import ReportPhrase, State
from . import common
from .common import new_finding, not_applicable, not_verified

if TYPE_CHECKING:
    from ..htmlextract import PageFacts
    from ..model import EvalContext, Finding
    from ..observations import Observations
    from ..psi import AuditResult

MIN_ZOOM_SCALE = 2.0

# The PageSpeed mobile run loads the home as a phone and runs its scripts; the HTML
# the check reads was fetched with a desktop user agent. When the phone run finds a
# viewport meta that the desktop HTML lacks, the site serves phones another page
# (WPtouch, an m. redirect, a viewport printed only for mobile agents): grey.
REASON_VIS12_PHONE_VIEWPORT = (
    "la prueba de Google en celular encontró la etiqueta para celulares que falta en el código leído como "
    "computadora; se revisa en un celular"
)
NOTE_VIS12_PHONE_VIEWPORT = (
    "PageSpeed en celular encontró la etiqueta viewport y el HTML pedido como computadora no la tiene: el sitio "
    "puede servir otra página a los teléfonos. Abrir la página de inicio en un celular antes de decir nada."
)
# The meta tags of the first phone browsers. Without a viewport meta, Chrome on Android still reads MobileOptimized (any
# content) and HandheldFriendly (content "true") as "fit the page to the phone's
# width", so a home that has one may not be shown shrunk: grey with an internal
# note. Matched by name, case-insensitive, whatever the
# content (grey is the safe side; the hand check settles it).
LEGACY_MOBILE_METAS: tuple[str, ...] = ("HandheldFriendly", "MobileOptimized")
REASON_VIS12_LEGACY_META = (
    "la página de inicio no tiene la etiqueta actual para celulares pero sí una anterior que algunos teléfonos "
    "respetan; se revisa en un celular"
)
NOTE_VIS12_LEGACY_META = (
    "La página de inicio no tiene la etiqueta viewport pero tiene la etiqueta {nombre}, que Chrome en Android puede "
    "tomar como adaptada al ancho del teléfono. Abrir la página de inicio en un celular antes de decir nada."
)
# measured["viewport_celular"]: what the PageSpeed mobile runs say (phone_viewport).
PHONE_VIEWPORT_PRESENT = "presente"
PHONE_VIEWPORT_ABSENT = "ausente"

REASON_NO_CONTRAST = "la herramienta de Google no informó el contraste de los textos"
REASON_NO_FORM_AUDITS = "la herramienta de Google no informó los formularios y los botones"
GREY_CONTRAST_OK = (
    "El contraste de los textos está bien según Google; el foco al navegar con teclado requiere una prueba "
    "en navegador, que se hace aparte"
)
GREY_REFLOW = "Cómo se ve en un celular angosto y con el zoom al doble requiere una prueba en navegador, que se hace aparte"
# VIS-13 grey reasons: what was measured, never "están en otras páginas".
REASON_HOME_TRUNCATED = "la página principal llegó incompleta"  # the same words as gate.REASON_TRUNCATED
REASON_FORM_PAGE_TRUNCATED = "la página del formulario llegó incompleta"
REASON_NO_FORMS_HOME = "la página principal no tiene formularios para revisar; los de otras páginas se revisan en navegador"
REASON_NO_FORMS_FORM_PAGE = "la página indicada no tiene formularios para revisar; se revisan en navegador"
REASON_FORMS_BROWSER_HOME = "los campos del formulario de la página principal no se pudieron revisar desde afuera; se revisan en navegador"
REASON_FORMS_BROWSER_FORM_PAGE = "los campos de la página del formulario no se pudieron revisar desde afuera; se revisan en navegador"

_VIEWPORT_PAIR_RE = re.compile(r"([a-zA-Z-]+)\s*=\s*([^,;\s]+)")


def _psi_grey(spec_id: str, obs: "Observations", run_date, **fields: Any) -> "Finding":
    from .. import fmt

    spec = common.spec_of(spec_id)
    reason = common.psi_unavailable_reason(obs)
    sentence = f"No se pudo medir el {fmt.fecha_dmy(run_date)}: {reason}; se repite aparte"  # the date
    fields.setdefault("internal_note", common.psi_internal_note(obs))  # the 429 detail, for the operator only
    return not_verified(spec, reason, phrase_report=ReportPhrase(found=sentence), **fields)


def _audit(run, concept: str) -> "AuditResult | None":
    if run is None:
        return None
    return (run.audits or {}).get(concept)


def _applicable(a: "AuditResult | None") -> bool:
    return a is not None and a.score is not None and (a.score_display_mode or "") not in ("notApplicable", "manual", "informative")


# ---------------------------------------------------------------------------
# VIS-10
# ---------------------------------------------------------------------------


def evaluate_vis10(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-10 · contraste y foco.

    FALLA when color-contrast scores 0 (failing nodes counted). Contrast passing
    -> NO_VERIFICADO with REASON_BROWSER_FOCUS (a green needs both parts; the
    passing contrast stays as evidence). No PSI result -> NO_VERIFICADO.
    """
    spec = common.spec_of("VIS-10")
    run = common.psi_median_run(obs)
    if run is None:
        return _psi_grey("VIS-10", obs, ctx.run_date)
    audit = _audit(run, "color_contrast")
    evidence = common.psi_evidence(run)
    measured = {
        "contrast_score": audit.score if audit is not None else None,
        "contrast_failing": audit.failing_items if audit is not None else None,
    }
    if audit is None:
        return not_verified(spec, REASON_NO_CONTRAST, measured=measured)
    if audit.score is not None and audit.score == 0:
        n = audit.failing_items
        if n is None or n == 0:
            found = "Hay textos de la página principal con poco contraste con su fondo"
        elif n == 1:
            found = "Un texto de la página principal tiene poco contraste con su fondo"
        else:
            found = f"{n} textos de la página principal tienen poco contraste con su fondo"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace={"{n}": "checks[VIS-10].measured.contrast_failing"} if n and n > 1 else {},
            phrase_report=ReportPhrase(
                found=found,
                consequence="Cuesta leerlos con sol, en pantallas chicas o con la vista cansada",
                action=common.on_platform(obs, ctx, wordpress="Ajustar colores en el tema hijo", other="Ajustar los colores en el diseño del sitio"),
                who="Quien mantiene el sitio",
            ),
        )
    return not_verified(
        spec,
        common.REASON_BROWSER_FOCUS,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=GREY_CONTRAST_OK if _applicable(audit) else common.REASON_BROWSER_FOCUS),
    )


# ---------------------------------------------------------------------------
# VIS-11
# ---------------------------------------------------------------------------


def evaluate_vis11(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-11 · imágenes con descripción.

    Home <img> outside <noscript>; missing alt ATTRIBUTE counts (alt="" is
    decorative and present; data-alt= is not alt: trap of the tool's grep).
    APROBADO: none missing. FALLA: 1 or more missing. NO_APLICA: no <img>.
    measured: n_img, n_missing_alt. PSI image-alt as evidence only.
    """
    spec = common.spec_of("VIS-11")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    images = [i for i in page.images if not i.in_noscript]
    total = len(images)
    missing = sum(1 for i in images if i.alt is None)
    run = common.psi_median_run(obs)
    psi_alt = _audit(run, "image_alt")
    measured = {
        "n_img": total,
        "n_missing_alt": missing,
        "psi_image_alt_score": psi_alt.score if psi_alt is not None else None,
    }
    if total == 0:
        return not_applicable(spec, "la página principal no tiene imágenes", measured=measured)
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    if missing:
        if total == 1:
            found = "La única imagen de la página principal no tiene descripción"
        elif missing == 1:
            found = f"1 de las {total} imágenes de la página principal no tiene descripción"
        else:
            found = f"{missing} de las {total} imágenes de la página principal no tienen descripción"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace={"{n}": "checks[VIS-11].measured.n_missing_alt", "{total}": "checks[VIS-11].measured.n_img"} if total > 1 else {},
            phrase_report=ReportPhrase(
                found=found,
                consequence="Las personas que usan lector de pantalla no saben qué muestran",
                action=common.on_platform(
                    obs, ctx, wordpress="Completar la descripción en la biblioteca de medios", other="Completar la descripción de cada imagen en el editor del sitio"
                ),
                who="Quien mantiene el sitio",
            ),
        )
    found = (
        "La imagen de la página principal tiene descripción"
        if total == 1
        else f"Las {total} imágenes de la página principal tienen descripción"
    )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found, consequence="Quien no ve la imagen igual sabe qué muestra"),
    )


# ---------------------------------------------------------------------------
# VIS-12
# ---------------------------------------------------------------------------


def _viewport_values(content: str) -> dict[str, str]:
    return {k.strip().lower(): v.strip().lower() for k, v in _VIEWPORT_PAIR_RE.findall(content or "")}


def _names_viewport(audit: "AuditResult") -> bool:
    """True when a failing item of the audit is the viewport meta itself (its node snippet or selector)."""
    items = (audit.details or {}).get("items") if isinstance(audit.details, dict) else None
    for item in items if isinstance(items, list) else []:
        node = item.get("node") if isinstance(item, dict) else None
        if not isinstance(node, dict):
            continue
        text = f"{node.get('snippet') or ''} {node.get('selector') or ''}".lower()
        if "viewport" in text:
            return True
    return False


def phone_viewport(obs: "Observations") -> str | None:
    """What the PageSpeed mobile runs say about the viewport meta: PHONE_VIEWPORT_PRESENT, _ABSENT, or None.

    Lighthouse's "meta-viewport" is axe's rule: it applies only when a
    ``<meta name="viewport">`` exists, so a page without one comes back
    "notApplicable" (ABSENT); a viewport that lets the user zoom scores 1
    (PRESENT); one that blocks the zoom scores 0 with that meta as its failing
    node (PRESENT). Read the other way, a 0 without a viewport node is ABSENT: both readings are
    handled. Any valid mobile run that sees one is PRESENT. None when PageSpeed
    gave no valid run or no such audit.
    """
    psi = obs.psi
    if psi is None or psi.status != "ok":
        return None
    seen: set[str] = set()
    for run in psi.valid_mobile:
        audit = _audit(run, "meta_viewport")
        if audit is None:
            continue
        if (audit.score_display_mode or "") == "notApplicable":
            seen.add(PHONE_VIEWPORT_ABSENT)
        elif audit.score is not None and audit.score >= 1:
            seen.add(PHONE_VIEWPORT_PRESENT)
        elif audit.score is not None and audit.score == 0:
            seen.add(PHONE_VIEWPORT_PRESENT if _names_viewport(audit) else PHONE_VIEWPORT_ABSENT)
    if PHONE_VIEWPORT_PRESENT in seen:
        return PHONE_VIEWPORT_PRESENT
    return PHONE_VIEWPORT_ABSENT if PHONE_VIEWPORT_ABSENT in seen else None


def legacy_mobile_meta(page: "PageFacts") -> str | None:
    """The first LEGACY_MOBILE_METAS name the page carries (as the constant spells it), or None."""
    wanted = {name.lower(): name for name in LEGACY_MOBILE_METAS}
    for meta in page.metas:
        name = (meta.get("name") or "").strip().lower()
        if name in wanted:
            return wanted[name]
    return None


def evaluate_vis12(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-12 · celular angosto y zoom.

    FALLA when there is no viewport meta, or user-scalable=no/0, or
    maximum-scale < 2. Otherwise NO_VERIFICADO with REASON_BROWSER_REFLOW.

    Without a viewport meta in the HTML (fetched as a desktop browser), the
    PageSpeed mobile runs decide first (phone_viewport): when they found one,
    the site serves phones another page and the result is NO_VERIFICADO
    (REASON_VIS12_PHONE_VIEWPORT, internal note NOTE_VIS12_PHONE_VIEWPORT).
    Without PageSpeed it stays a FALLA. measured.viewport_celular keeps
    what PageSpeed said ("presente", "ausente" or None).

    A home without a viewport meta but with
    a LEGACY_MOBILE_METAS tag (HandheldFriendly, MobileOptimized) counts as
    having one: NO_VERIFICADO (REASON_VIS12_LEGACY_META, internal note
    NOTE_VIS12_LEGACY_META, measured.meta_celular_anterior).
    """
    spec = common.spec_of("VIS-12")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    content = page.viewport
    values = _viewport_values(content or "")
    scalable = values.get("user-scalable")
    max_scale: float | None
    try:
        max_scale = float(values["maximum-scale"]) if "maximum-scale" in values else None
    except ValueError:
        max_scale = None
    measured: dict[str, Any] = {
        "viewport_present": content is not None,
        "user_scalable": scalable,
        "maximum_scale": max_scale,
    }
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    consequence = "Quien necesita letra más grande no puede leerla"
    action = common.on_platform(
        obs, ctx, wordpress="Ajustar la etiqueta de pantalla en el tema", other="Ajustar la etiqueta de pantalla en el diseño del sitio"
    )
    if content is None:
        phone = phone_viewport(obs)
        measured["viewport_celular"] = phone
        if phone is not None:
            evidence = evidence + common.psi_evidence(common.psi_median_run(obs))
        legacy = legacy_mobile_meta(page)
        if legacy is not None:
            measured["meta_celular_anterior"] = legacy
            return not_verified(
                spec,
                REASON_VIS12_LEGACY_META,
                measured=measured,
                evidence=evidence,
                internal_note=NOTE_VIS12_LEGACY_META.format(nombre=legacy),
            )
        if phone == PHONE_VIEWPORT_PRESENT:
            return not_verified(
                spec,
                REASON_VIS12_PHONE_VIEWPORT,
                measured=measured,
                evidence=evidence,
                internal_note=NOTE_VIS12_PHONE_VIEWPORT,
            )
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="La página principal no se adapta al ancho del celular",
                consequence="En el celular se ve chica y hay que agrandarla con los dedos",
                action=action,
                who="Quien mantiene el sitio",
            ),
        )
    if scalable in ("no", "0") or (max_scale is not None and max_scale < MIN_ZOOM_SCALE):
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="La página principal no deja agrandar la letra con el zoom",
                consequence=consequence,
                action=action,
                who="Quien mantiene el sitio",
            ),
        )
    return not_verified(
        spec,
        common.REASON_BROWSER_REFLOW,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=GREY_REFLOW),
    )


# ---------------------------------------------------------------------------
# VIS-13
# ---------------------------------------------------------------------------


def _label_sentence(n: int | None) -> str:
    if n is None or n == 0:
        return "Hay campos del formulario sin su nombre asociado"
    if n == 1:
        return "Un campo del formulario no tiene su nombre asociado"
    return f"{n} campos del formulario no tienen su nombre asociado"


def _target_sentence(n: int | None) -> str:
    if n is None or n == 0:
        return "Hay botones o enlaces demasiado chicos para tocarlos con el dedo"
    if n == 1:
        return "Un botón o enlace es demasiado chico para tocarlo con el dedo"
    return f"{n} botones o enlaces son demasiado chicos para tocarlos con el dedo"


def evaluate_vis13(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-13 · formularios y botones.

    PSI audits label and target-size (score, failing items); home (or
    --form-page) forms and fields with their labels as evidence.
    FALLA: label or target-size scores 0. APROBADO: both pass and the page has at
    least one form. No PSI result -> NO_VERIFICADO.

    the grey reasons say what was measured. A truncated form page
    (the home, or --form-page) is "llegó incompleta"; no fields in the
    HTML and none for Google is "no tiene formularios para revisar"; fields seen
    by only one of the two is "no se pudieron revisar desde afuera". No other
    page is ever searched for forms, so the report never says they are there.
    The green consequence fits every --kind: "Completar un formulario desde
    el celular no se traba".
    """
    spec = common.spec_of("VIS-13")
    run = common.psi_median_run(obs)
    if run is None:
        return _psi_grey("VIS-13", obs, ctx.run_date)
    label = _audit(run, "label")
    target = _audit(run, "target_size")
    form_page = ctx.pages.get("formulario") or ctx.pages.get("home")
    n_forms = form_page.forms if form_page is not None else 0
    n_fields = len(form_page.fields) if form_page is not None else 0
    n_unlabelled = sum(1 for f in form_page.fields if not f.has_label) if form_page is not None else 0
    measured = {
        "label_score": label.score if label is not None else None,
        "label_failing": label.failing_items if label is not None else None,
        "target_size_score": target.score if target is not None else None,
        "target_size_failing": target.failing_items if target is not None else None,
        "forms": n_forms,
        "fields": n_fields,
        "fields_without_label_html": n_unlabelled,
        "form_page": "formulario" if ctx.pages.get("formulario") is not None else "home",
    }
    evidence = common.psi_evidence(run)
    label_fail = label is not None and label.score == 0
    target_fail = target is not None and target.score == 0
    if label_fail or target_fail:
        parts = []
        if label_fail:
            parts.append(_label_sentence(label.failing_items))
        if target_fail:
            parts.append(_target_sentence(target.failing_items))
        found = parts[0] + ("; " + parts[1][0].lower() + parts[1][1:] if len(parts) > 1 else "")
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=found,
                consequence=f"{kinds.of(ctx.kind).Audience} se equivocan al completar o no llegan a tocar el botón",
                action=common.on_platform(
                    obs,
                    ctx,
                    wordpress=(
                        "Ajustar el formulario en el plugin o el constructor; si está conectado a un sistema externo, "
                        "primero revisar qué no tocar"
                    ),
                    other=(
                        "Ajustar el formulario en el editor del sitio; si está conectado a un sistema externo, "
                        "primero revisar qué no tocar"
                    ),
                ),
                who="Quien mantiene el sitio",
            ),
        )
    if label is None or target is None:
        return not_verified(spec, REASON_NO_FORM_AUDITS, measured=measured, evidence=evidence)
    # the grey reason says what was measured. Half a page proves no
    # absence, and nobody looked for forms on other pages.
    on_form_page = ctx.pages.get("formulario") is not None
    page_fetch = obs.form_page if on_form_page else obs.home
    page_resp = page_fetch.response if page_fetch is not None else None
    if page_resp is not None and page_resp.truncated:
        return not_verified(spec, REASON_FORM_PAGE_TRUNCATED if on_form_page else REASON_HOME_TRUNCATED, measured=measured, evidence=evidence)
    if n_fields == 0 and not _applicable(label):
        reason = REASON_NO_FORMS_FORM_PAGE if on_form_page else REASON_NO_FORMS_HOME
        return not_verified(spec, reason, measured=measured, evidence=evidence)
    if n_fields == 0 or not _applicable(label):
        return not_verified(spec, REASON_FORMS_BROWSER_FORM_PAGE if on_form_page else REASON_FORMS_BROWSER_HOME, measured=measured, evidence=evidence)
    if n_forms >= 1 and _applicable(target):
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="Los campos del formulario tienen su nombre y los botones se pueden tocar",
                # Every kind has forms; not every kind has an «inscripción».
                consequence="Completar un formulario desde el celular no se traba",
            ),
        )
    return not_verified(spec, REASON_FORMS_BROWSER_FORM_PAGE if on_form_page else REASON_FORMS_BROWSER_HOME, measured=measured, evidence=evidence)
