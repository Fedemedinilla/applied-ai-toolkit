"""VIS-09 · enlaces rotos o con vueltas, solo los de la página principal.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit

from .. import artifacts, domains, fmt, kinds
from ..model import ReportPhrase, State
from . import common
from .common import new_finding, not_applicable, not_verified

if TYPE_CHECKING:
    from ..model import EvalContext, Finding
    from ..observations import Observations

VERIFIED_FOR_PASS = 0.80  # share of selected links verified for APROBADO
VERIFIED_FOR_ANY = 0.50  # below this share: NO_VERIFICADO
BROKEN_STATUSES: frozenset[int] = frozenset({404, 410})

MAX_BROKEN_ADDRESSES = 10


def _broken_address(url: str) -> str | None:
    """The address of a broken link for the technical annex: the host (IDN decoded) plus the
    percent-decoded path, sanitized, without query or fragment; never just the home ("/").

    The report sentence never prints it: a path such as /staff/jane-doe/ can carry a
    person's name, so the address only goes to the annex.
    """
    path = unquote(urlsplit(url).path or "")
    if not path or path == "/":
        return None
    host = domains.decode_idn((urlsplit(url).hostname or "").rstrip(".").lower())
    address = fmt.sanitize_site_url(host + path, 120)
    return address or None


# (singular, plural) verb phrases of the report sentences.
_BROKEN = ("lleva a una página que no existe", "llevan a páginas que no existen")
_SERVER = ("da un error del servidor", "dan un error del servidor")
_CHAIN = ("da más de una vuelta antes de llegar", "dan más de una vuelta antes de llegar")
_OTHER = ("responde con un error", "responden con un error")
_ARRIVE = ("llega a su destino", "llegan a su destino")


def _lead(k: int, verified: int, selected: int, verbs: tuple[str, str]) -> str:
    """The first clause, with the denominator said once.

    When every selected link was checked, the count goes in the subject ("Uno de
    los 8 enlaces revisados..."); otherwise the subject has no count and
    _denominator adds "(se revisaron N de M)" at the end of the sentence.
    """
    singular, plural = verbs
    if verified == selected:
        if verified == 1:
            return f"El único enlace de la página principal {singular}"
        if k == verified:
            return f"Los {verified} enlaces revisados de la página principal {plural}"
        if k == 1:
            return f"Uno de los {verified} enlaces revisados de la página principal {singular}"
        return f"{k} de los {verified} enlaces revisados de la página principal {plural}"
    if k == 1:
        return f"Un enlace de la página principal {singular}"
    return f"{k} enlaces de la página principal {plural}"


def _more(k: int, verbs: tuple[str, str]) -> str:
    """A further clause about other links of the same survey: "otro da...", "otros 2 dan..."."""
    singular, plural = verbs
    return f"otro {singular}" if k == 1 else f"otros {k} {plural}"


def _denominator(verified: int, selected: int) -> str:
    """" (se revisaron N de M)" when not every selected link was checked, else nothing."""
    return "" if verified == selected else f" (se revisaron {verified} de {selected})"


def evaluate_vis09(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-09. Input: obs.links (selection and probes).

    A link is "verified" when it got a final status (not challenged, not skipped).
    FALLA: at least one verified link ends in 404/410; a 5xx also gives FALLA and
    is reported apart. APROBADO_CON_OBSERVACION (Azul): no 404 but at least one
    chain of 2+ redirects. APROBADO: every verified link answers 200 directly or
    after 1 hop AND >= 80 % of the selected links were verified. NO_VERIFICADO:
    < 50 % verified (challenge or budget). The report states the denominator
    once: in the subject when every selected link was checked ("Uno de
    los 8 enlaces revisados..."), else as "(se revisaron N de M)" at the end.
    A 5xx or 429 in a run that was throttled or cut is not verified: the site
    was slowing the tool down, so the error is not the site's fault.
    measured keys: n_selected, n_verified, n404 (links ending in 404 OR 410),
    n5xx, n_chains, broken (paths only, no query), broken_addresses (host plus
    decoded path, for the annex), capped.
    VIS-17 and EXT-25 read final statuses from obs.links.
    """
    spec = common.spec_of("VIS-09")
    if ctx.pages.get("home") is None:
        return common.home_missing_finding(spec, obs)
    survey = obs.links
    selection = survey.selection
    probes = list(survey.probes)
    n_selected = len(selection.selected) if selection is not None else len(probes)
    # A 5xx or 429 in a run the site throttled or cut is never a fault of the site.
    verified = [p for p in probes if common.probe_verified(p, obs)]
    n_verified = len(verified)
    broken = [p for p in verified if p.final_status in BROKEN_STATUSES]
    server = [p for p in verified if p.final_status is not None and 500 <= p.final_status <= 599]
    chains = [p for p in verified if p.hops >= 2]
    other_bad = [
        p for p in verified
        if p.final_status is not None and p.final_status not in BROKEN_STATUSES and not (200 <= p.final_status < 400) and not (500 <= p.final_status <= 599)
    ]
    measured = {
        "n_selected": n_selected,
        "n_verified": n_verified,
        "n404": len(broken),
        "n5xx": len(server),
        "n_other_errors": len(other_bad),
        "n_chains": len(chains),
        # Links that lead to a login or admin page: verified, never requested past the redirect, not broken.
        "n_private": sum(1 for p in verified if getattr(p, "private", False)),
        "broken": [fmt.sanitize_site_text(urlsplit(p.final_url or p.url).path or "/", 80) for p in broken][:10],
        # Whole addresses for the annex only, never for a report sentence.
        "broken_addresses": [a for a in (_broken_address(p.final_url or p.url) for p in broken) if a][:MAX_BROKEN_ADDRESSES],
        "capped": bool(selection.capped) if selection is not None else False,
    }
    if n_selected == 0:
        return not_applicable(spec, "la página principal no tiene enlaces internos para revisar", measured=measured)
    evidence = [artifacts.LINKS, common.page_evidence(obs.home, artifacts.HOME_HTML)]
    suffix = _denominator(n_verified, n_selected)

    if broken or server:
        # Chains that also end in an error are counted once, as errors.
        errored = {id(p) for p in broken + server}
        chains_ok = [p for p in chains if id(p) not in errored]
        if broken:
            parts = [_lead(len(broken), n_verified, n_selected, _BROKEN)]
            if server:
                parts.append(_more(len(server), _SERVER))
        else:
            parts = [_lead(len(server), n_verified, n_selected, _SERVER)]
        if chains_ok:
            parts.append(_more(len(chains_ok), _CHAIN))
        found = "; ".join(parts) + suffix
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace={"{n_probados}": "checks[VIS-09].measured.n_verified", "{n404}": "checks[VIS-09].measured.n404"},
            phrase_report=ReportPhrase(
                found=found,
                consequence=f"{kinds.of(ctx.kind).Audience} encuentran un error y Google pierde confianza en el sitio",
                action="Corregir cada enlace o su redirección",
                who="Quien mantiene el sitio",
            ),
        )

    share = n_verified / n_selected if n_selected else 0.0
    if share < VERIFIED_FOR_ANY:
        reason = common.blocked_reason(obs) if (obs.blocked or any(p.challenged for p in probes)) else (
            common.REASON_BUDGET if obs.budget_exhausted else "la mayoría de los enlaces no se pudieron revisar"
        )
        return not_verified(spec, reason, measured=measured)

    if chains or other_bad or share < VERIFIED_FOR_PASS:
        if chains:
            head = _lead(len(chains), n_verified, n_selected, _CHAIN)
            consequence = "Cada vuelta suma espera y Google pierde tiempo siguiendo redirecciones"
            action = "Apuntar cada enlace a su dirección final"
        elif other_bad:
            head = _lead(len(other_bad), n_verified, n_selected, _OTHER)
            consequence = f"{kinds.of(ctx.kind).Audience} pueden encontrarse con una página de error"
            action = "Revisar esos enlaces"
        else:
            head = "Los enlaces revisados de la página principal llegan a su destino, pero no se pudieron revisar todos"
            consequence = "Puede haber enlaces rotos entre los que no se revisaron"
            action = "Revisar el resto de los enlaces"
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="enlaces con vueltas o sin revisar",
            phrase_report=ReportPhrase(found=head + suffix, consequence=consequence, action=action, who="Quien mantiene el sitio"),
        )
    if n_verified == n_selected:
        found = _lead(n_verified, n_verified, n_selected, _ARRIVE)
    else:
        found = "Los enlaces revisados de la página principal llegan a su destino" + suffix
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found, consequence="Nadie encuentra páginas de error desde la portada"),
    )
