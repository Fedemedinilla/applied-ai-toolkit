"""EXT-05 · correo del dominio: SPF, DMARC, DKIM (EXT module, Alta).

Only DNS answers are read (DNS over HTTPS); nothing is sent to the mail
servers themselves. Delivery is never measured, so the report states what the records
allow, never what happened to a given message.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from .. import artifacts, kinds
from ..doh import DnsStatus
from ..model import ReportPhrase, State
from . import common
from .common import new_finding, not_applicable, not_verified

if TYPE_CHECKING:
    from ..doh import DnsAnswer, MailDns
    from ..model import EvalContext, Finding
    from ..observations import Observations

REASON_DNS_DOWN = "la consulta del correo del dominio no respondió; se repite"
NOT_APPLICABLE = "El dominio no recibe correo propio; esta parte no aplica."
DMARC_CASES: frozenset[int] = frozenset({6, 7, 8})
_DMARC_POLICIES: frozenset[str] = frozenset({"none", "quarantine", "reject"})

_ALL_RE = re.compile(r"^([+\-~?]?)all$", re.IGNORECASE)
_FAILED_STATUSES = frozenset({DnsStatus.SERVFAIL, DnsStatus.ERROR})


def _failed(answer: "DnsAnswer | None") -> bool:
    return answer is None or answer.status in _FAILED_STATUSES


def _records(answer: "DnsAnswer | None") -> list[str]:
    if answer is None or answer.status != DnsStatus.NOERROR:
        return []
    return [r for r in answer.records if r is not None]


def _dmarc_tags(record: str) -> dict[str, str]:
    tags: dict[str, str] = {}
    for part in record.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            tags.setdefault(k.strip().lower(), v.strip())
    return tags


_NO_DMARC = "no tiene la regla que les dice a Gmail y a Outlook qué hacer con los mails falsos"


def _mail_case(*, spf_count: int, spf_all: str | None, dkim_found: bool | None, dmarc_count: int, dmarc_p: str | None) -> int | None:
    """The EXT-05 failure case (1 to 8), the first that applies; None when none does.

    Cases 1 and 2 need ``dkim_found is False``: a documented selector of the
    provider was queried and nothing was found. With None (an unknown provider,
    nothing queried) they fall to 3 and 4, which make no DKIM or spam claim.
    """
    if spf_count == 0 and dkim_found is False:
        return 1
    if spf_count > 1 and dkim_found is False:
        return 2
    if spf_count == 0:
        return 3
    if spf_count > 1:
        return 4
    if spf_all == "+":
        return 5
    if dmarc_count > 1:
        return 6
    if dmarc_count == 1 and not dmarc_p:
        return 7
    if dmarc_count == 0:
        return 8
    return None


def _org_dmarc(site: "MailDns") -> dict[str, Any]:
    """measured keys for the organizational domain's DMARC record.

    dmarc_org_dominio: the real-PSL organizational domain, or None when it is the
    domain itself (nothing to ask). dmarc_org_consultado: the question got an
    answer (records or a definite "there is none"). dmarc_org_p: its p= when
    there is exactly one DMARC record. dmarc_org_valido: that p= is none,
    quarantine or reject. A failed lookup leaves consultado False, and the DMARC
    case is never dropped on a guess.
    """
    org = getattr(site, "org_domain", None)
    answer = getattr(site, "org_dmarc", None)
    out: dict[str, Any] = {"dmarc_org_dominio": org, "dmarc_org_consultado": False, "dmarc_org_p": None, "dmarc_org_valido": False}
    if org is None or answer is None or _failed(answer):
        return out
    out["dmarc_org_consultado"] = True
    records = [r for r in _records(answer) if r.strip().lower().startswith("v=dmarc1")]
    if len(records) == 1:
        p = (_dmarc_tags(records[0]).get("p") or "").lower() or None
        out["dmarc_org_p"] = p
        out["dmarc_org_valido"] = p in _DMARC_POLICIES
    return out


def evaluate_ext05(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-05.

    obs.dns.site and obs.dns.control. No MX -> NO_APLICA ("El dominio no recibe
    correo propio; esta parte no aplica."). Control failed or DoH
    SERVFAIL/timeout -> NO_VERIFICADO (REASON_DNS_CONTROL or resolver reason).
    FALLA (Rojo): SPF missing; more than one v=spf1 record (permerror); SPF with
    +all; DMARC missing; DMARC without p=; DMARC without rua=.
    APROBADO_CON_OBSERVACION (Amarillo, Alta): SPF and DMARC pass but DKIM not
    found with the provider's documented selector, or SPF ends in ?all. APROBADO: SPF -all/~all, DMARC
    with p and rua, DKIM found.
    A FALLA records in measured.caso_mail which of eight ordered cases applied
    first (_mail_case: 1-5 about SPF and DKIM, 6-8 about DMARC). Cases 6 to 8
    rest on the domain's own DMARC record: when the real-PSL organizational
    domain (doh.organizational_domain, colegio-ejemplo.esc.edu.ar -> esc.edu.ar)
    has one DMARC record with a valid p=, the case is cleared and a missing own
    record is an observation ("se aplica la de esc.edu.ar"), not a FALLA.
    measured keys (read by checks/tables.py): spf_count, spf_all, dmarc_present,
    dmarc_p, dmarc_rua, dkim_found, provider, resolver; plus dmarc_org_dominio,
    dmarc_org_consultado, dmarc_org_p, dmarc_org_valido.

    No record text is copied into ``measured`` (a DMARC rua= carries
    an e-mail address of the site); only tags and booleans.
    * A DMARC without rua= only means nobody receives the reports; it changes no
      delivery, so it is an observation for the report, never a FALLA for the
      mail.
    * The consequence names what can really happen: "fake mails can arrive" only
      when no DMARC policy rejects them (no record, no p=, or p=none, or SPF +all);
      otherwise only the delivery of the real mails is at stake.
    * An SPF record with ``redirect=`` and no ``all`` takes its ``all`` from the
      provider's record (RFC 7208 6.1): spf_all is "redirect", "defined by the
      provider", not "says nothing about the rest".
    """
    spec = common.spec_of("EXT-05")
    shared = common.shared_domain_reason(obs)
    if shared:  # the mail belongs to the organization or platform, never the site
        return not_applicable(spec, shared, measured={"shared_parent": obs.shared_parent})
    bundle = obs.dns
    site = bundle.site if bundle is not None else None
    if bundle is None or site is None:
        return not_verified(spec, REASON_DNS_DOWN)
    if not bundle.control_ok:
        return not_verified(spec, common.REASON_DNS_CONTROL)
    if _failed(site.mx):
        return not_verified(spec, REASON_DNS_DOWN)
    mx = _records(site.mx)
    if not mx:
        return not_applicable(spec, NOT_APPLICABLE, measured={"mx_count": 0})
    if _failed(site.txt) or _failed(site.dmarc):
        return not_verified(spec, REASON_DNS_DOWN)

    spf = [r for r in _records(site.txt) if r.strip().lower().startswith("v=spf1")]
    spf_all = None
    spf_redirect = False
    if len(spf) == 1:
        for token in spf[0].split()[1:]:
            m = _ALL_RE.match(token.strip())
            if m:
                spf_all = m.group(1) or "+"
            elif token.strip().lower().startswith("redirect="):
                spf_redirect = True
        if spf_all is None and spf_redirect:
            spf_all = "redirect"
    dmarc = [r for r in _records(site.dmarc) if r.strip().lower().startswith("v=dmarc1")]
    tags = _dmarc_tags(dmarc[0]) if len(dmarc) == 1 else {}
    dmarc_present = len(dmarc) == 1
    dmarc_p = (tags.get("p") or "").lower() or None
    dmarc_rua = bool(tags.get("rua"))
    dkim_answers = list(site.dkim.values())
    dkim_found = None
    if dkim_answers:
        dkim_found = any(
            any(("p=" in r.lower() and not r.lower().rstrip().endswith("p=")) or "v=dkim1" in r.lower() for r in _records(a))
            for a in dkim_answers
        )
    measured: dict[str, Any] = {
        "mx_count": len(mx),
        "provider": site.provider,
        "spf_count": len(spf),
        "spf_all": spf_all,
        "spf_redirect": spf_redirect,
        "dmarc_count": len(dmarc),
        "dmarc_present": dmarc_present,
        "dmarc_p": dmarc_p,
        "dmarc_sp": (tags.get("sp") or "").lower() or None,
        "dmarc_pct": tags.get("pct"),
        "dmarc_rua": dmarc_rua,
        "dkim_found": dkim_found,
        "dkim_selectors_checked": sorted(site.dkim.keys()),
        "resolver": site.txt.resolver if site.txt is not None else None,
    }
    evidence = [artifacts.DNS]

    problems: list[str] = []
    if not spf:
        problems.append("no tiene la lista de quién puede enviar mails en su nombre")
    elif len(spf) > 1:
        problems.append("tiene dos listas de quién puede enviar mails en su nombre, y así ninguna vale")
    elif spf_all == "+":
        problems.append("tiene una lista de quién puede enviar que deja enviar a cualquiera")
    if not dmarc:
        problems.append(_NO_DMARC)
    elif len(dmarc) > 1:
        problems.append("tiene dos reglas para los mails falsos, y así ninguna vale")
    elif not dmarc_p:
        problems.append("tiene una regla para los mails falsos que no dice qué hacer con ellos")
    kind = kinds.of(ctx.kind)

    # The organizational domain's DMARC: a receiver that finds no record at
    # the domain falls back to it, so a valid policy there covers a missing one.
    org = _org_dmarc(site)
    measured.update(org)
    org_covers = bool(org["dmarc_org_valido"]) and not dmarc
    if org_covers:
        problems = [p for p in problems if p != _NO_DMARC]
    if problems:
        joined = problems[0] if len(problems) == 1 else ", ".join(problems[:-1]) + " y " + problems[-1]
        found = "El correo del dominio " + joined
        if org_covers:
            found += f"; no tiene una regla propia para los mails falsos, pero se aplica la de {org['dmarc_org_dominio']}"
        effective_p = org["dmarc_org_p"] if org_covers else dmarc_p
        spoof_possible = (len(dmarc) != 1 and not org_covers) or effective_p in (None, "none") or spf_all == "+"
        consequence = (
            f"Se pueden enviar mails que parezcan {kind.del_} y llegar, y los mails reales pueden caer más seguido en spam"
            if spoof_possible
            else f"Los mails reales {kind.del_} pueden caer en spam o ser rechazados"
        )
        case = _mail_case(spf_count=len(spf), spf_all=spf_all, dkim_found=dkim_found, dmarc_count=len(dmarc), dmarc_p=dmarc_p)
        measured["caso_mail"] = case
        internal_note = None
        if case in DMARC_CASES and org["dmarc_org_valido"]:
            # The organizational record has a policy: a DMARC case would be false.
            internal_note = (
                f"el registro DMARC de {org['dmarc_org_dominio']} tiene una regla válida; el caso DMARC no se aplica"
            )
            measured["caso_mail"] = case = None
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            internal_note=internal_note,
            trace={"{dominio}": "meta.dominio", "caso": "checks[EXT-05].measured.caso_mail"} if case is not None else {},
            phrase_report=ReportPhrase(
                found=found,
                consequence=consequence,
                action="Configurar los registros que faltan en el dominio",
                who="Quien administra el dominio",
            ),
        )
    if org_covers:
        # Only the domain's own DMARC was missing, and the organizational record covers it.
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason=f"el dominio no tiene una regla propia para los mails falsos; se aplica la de {org['dmarc_org_dominio']}",
            phrase_report=ReportPhrase(
                found=(
                    "El correo del dominio no tiene una regla propia para los mails falsos; Gmail y Outlook aplican "
                    f"la de {org['dmarc_org_dominio']}"
                ),
                consequence="Lo que pasa con los mails falsos depende de una regla que el dominio no maneja",
                action="Agregar una regla propia para los mails falsos",
                who="Quien administra el dominio",
            ),
        )
    if spf_all not in ("-", "~", "redirect"):
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="la lista de quién puede enviar no dice qué hacer con el resto",
            phrase_report=ReportPhrase(
                found="La lista de quién puede enviar mails en nombre del dominio no le dice al receptor qué hacer con el resto",
                consequence="Gmail y Outlook no pueden descartar con seguridad los mails falsos",
                action="Terminar la lista con la indicación de rechazar o marcar el resto",
                who="Quien administra el dominio",
            ),
        )
    if not dmarc_rua:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="la regla para los mails falsos no pide los reportes",
            phrase_report=ReportPhrase(
                found="La regla para los mails falsos no pide los reportes de quién envía mails en nombre del dominio",
                consequence="Nadie se entera si alguien manda mails falsos con el nombre del dominio",
                action="Agregar a la regla el pedido de reportes",
                who="Quien administra el dominio",
            ),
        )
    if not dkim_found:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="la firma de los mensajes no se pudo confirmar desde afuera",
            phrase_report=ReportPhrase(
                found=(
                    "El correo del dominio tiene la lista de quién puede enviar y la regla para los mails falsos; la "
                    "firma de los mensajes no se pudo confirmar desde afuera"
                ),
                # Conditional: the signature may exist with a selector not checked from outside.
                consequence="Si los mensajes salen sin firma, algunos mails reales pueden caer en spam",
                action="Revisar la firma en el panel de correo",
                who="Quien administra el correo",
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found="El correo del dominio tiene la lista de quién puede enviar, la firma de los mensajes y la regla para los mails falsos",
            # Delivery is never measured, only the records.
            consequence=(
                f"Es más difícil mandar mails falsos con el nombre {kind.del_}, y los servidores de correo tienen con "
                "qué reconocer los verdaderos"
            ),
        ),
    )
