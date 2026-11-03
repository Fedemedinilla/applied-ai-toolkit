"""From Observations to the final list of findings: evaluate, gate, colour.

Order (pipeline step 5):
1. parse every fetched page once (htmlextract.extract_page) into EvalContext.pages;
2. run every registry evaluator; an evaluator that raises is turned into
   NO_VERIFICADO (reason "la medición no se pudo evaluar") and the traceback
   summary goes to EvaluationResult.errors (English, redacted): one broken
   check never kills the run;
3. gate.apply_gate (evidence);
4. colours.colour_finding for every finding (table, exceptions, --overrides);
5. build the Google summary and the two report tables;
6. hack gate: active when any finding has hack_signal (EXT-23 abuse codes,
   EXT-24 positive).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .checks.header import GoogleSummary
    from .checks.tables import MailAuthTable, VelocityTable
    from .colours import ColourOverride
    from .htmlextract import PageFacts
    from .model import EvalContext, Finding
    from .observations import Observations, PageFetch

# Error texts kept in datos.json are cut so a long exception message (which
# could quote site text) never floods the file.
_MAX_ERROR_LEN = 300


@dataclass
class HackGate:
    active: bool = False
    reasons: list[str] = field(default_factory=list)  # check IDs and short English reasons


@dataclass
class EvaluationResult:
    findings: list["Finding"]
    google_summary: "GoogleSummary"
    velocity: "VelocityTable"
    mail_auth: "MailAuthTable"
    hack_gate: HackGate
    errors: list[str] = field(default_factory=list)


def _page_facts(pf: "PageFetch | None") -> "PageFacts | None":
    """PageFacts of one fetched page, or None when its body is not usable HTML."""
    from .htmlextract import extract_page

    if pf is None or pf.response is None:
        return None
    resp = pf.response
    if not resp.usable or resp.status is None or not (200 <= resp.status < 300) or not resp.body:
        return None
    if resp.undecodable_encoding:
        return None
    text, _ = resp.text()
    return extract_page(text, resp.final_url or pf.url)


def build_pages(obs: "Observations") -> dict[str, "PageFacts | None"]:
    """Parse home, interna, form page and hreflang pages (None when the body is not usable)."""
    pages: dict[str, PageFacts | None] = {
        "home": _page_facts(obs.home),
        "interna": _page_facts(obs.interna),
        "formulario": _page_facts(obs.form_page),
    }
    for pf in obs.hreflang_pages:
        role = pf.role if pf.role.startswith("hreflang:") else f"hreflang:{pf.role}"
        if role not in pages:
            pages[role] = _page_facts(pf)
    return pages


def _short(text: str) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= _MAX_ERROR_LEN else text[: _MAX_ERROR_LEN - 3] + "..."


def evaluate_all(
    obs: "Observations",
    ctx: "EvalContext",
    *,
    overrides: dict[str, "ColourOverride"] | None = None,
) -> EvaluationResult:
    """Steps 2 to 6 for every check of the registry, in registry order."""
    from . import colours, gate, registry
    from .checks import header, tables
    from .checks.common import REASON_EVAL_ERROR, not_verified

    errors: list[str] = []
    specs = registry.by_id()
    findings: list[Finding] = []
    for spec in registry.all_specs():
        try:
            finding = spec.evaluate(obs, ctx)
            if finding is None or finding.id != spec.id:
                raise ValueError(f"evaluator returned {getattr(finding, 'id', None)!r}")
        except Exception as exc:  # noqa: BLE001 - one broken check never kills the run
            errors.append(_short(f"{spec.id}: {type(exc).__name__}: {exc}"))
            finding = not_verified(spec, REASON_EVAL_ERROR)
        findings.append(finding)

    gate.apply_gate(findings, specs, obs, ctx.artifacts_written)
    for f in findings:
        colours.colour_finding(f, overrides)

    try:
        summary = header.build_google_summary(obs)
    except Exception as exc:  # noqa: BLE001
        errors.append(_short(f"google summary: {type(exc).__name__}: {exc}"))
        summary = header.GoogleSummary(reason=REASON_EVAL_ERROR)
    by_id = {f.id: f for f in findings}
    try:
        velocity = tables.build_velocity_table(by_id, run_date=ctx.run_date)
    except Exception as exc:  # noqa: BLE001
        errors.append(_short(f"velocity table: {type(exc).__name__}: {exc}"))
        velocity = tables.VelocityTable(intro=f"La medición de velocidad no se pudo completar {tables.day_text(ctx.run_date)}.")
    try:
        mail_auth = tables.build_mail_auth_table(by_id.get("EXT-05"))
    except Exception as exc:  # noqa: BLE001
        errors.append(_short(f"mail table: {type(exc).__name__}: {exc}"))
        mail_auth = tables.MailAuthTable()

    return EvaluationResult(
        findings=findings,
        google_summary=summary,
        velocity=velocity,
        mail_auth=mail_auth,
        hack_gate=hack_gate_of(findings),
        errors=errors,
    )


def recolour(findings: list["Finding"], overrides: dict[str, "ColourOverride"] | None) -> list["Finding"]:
    """--rerender: recompute colours of findings loaded from datos.json (no gate, no evaluation)."""
    from . import colours

    for f in findings:
        colours.colour_finding(f, overrides)
    return findings


def hack_gate_of(findings: list["Finding"]) -> HackGate:
    """Step 6 alone (also used by --rerender)."""
    reasons: list[str] = []
    for f in findings:
        if not f.hack_signal:
            continue
        if f.id == "EXT-23":
            codes = f.measured.get("codes") if isinstance(f.measured, dict) else None
            detail = ", ".join(str(c) for c in codes) if codes else "abuse listing"
            reasons.append(f"EXT-23: Spamhaus DBL {detail}")
        elif f.id == "EXT-24":
            reasons.append("EXT-24: spam terms or foreign scripts on the home or in the sitemap")
        else:
            reasons.append(f"{f.id}: signs of compromise")
    return HackGate(active=bool(reasons), reasons=reasons)
