"""Resumen de Google: the report header.

The four Lighthouse category scores (x 100, rounded) from the median mobile run
and the desktop run. No state, no colour, not counted in any total. Shown with
Lighthouse's own bands and the same shapes: 0-49 "▲ Bajo", 50-89 "■ A mejorar",
90-100 "● Bien"; a missing score is "○ No se pudo medir ({motivo})".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..observations import Observations

BANDS: tuple[tuple[int, int, str, str], ...] = (
    (0, 49, "▲", "Bajo"),
    (50, 89, "■", "A mejorar"),
    (90, 100, "●", "Bien"),
)
MISSING_SHAPE = "○"


@dataclass
class ScoreCell:
    score: int | None
    shape: str
    label: str
    reason: str | None = None  # Spanish, when score is None


@dataclass
class GoogleSummary:
    """mobile/desktop -> category key ("performance", "accessibility", "best-practices", "seo") -> cell."""

    mobile: dict[str, ScoreCell] = field(default_factory=dict)
    desktop: dict[str, ScoreCell] = field(default_factory=dict)
    reason: str | None = None  # Spanish motivo when the whole summary is missing

    def to_datos(self) -> dict:
        """JSON-ready form for datos.json "encabezado"."""

        def side(cells: dict[str, ScoreCell]) -> dict:
            return {
                key: {"puntaje": c.score, "forma": c.shape, "rotulo": c.label, "motivo": c.reason}
                for key, c in cells.items()
            }

        return {"celular": side(self.mobile), "computadora": side(self.desktop), "motivo": self.reason}


MISSING_LABEL = "No se pudo medir"
REASON_NOT_SCORED = "Google no calificó esta parte"
REASON_DESKTOP_MISSING = "la medición en computadora no respondió"


def score_cell(score: int | None, reason: str | None) -> ScoreCell:
    """Map a score to its band (BANDS); None -> MISSING_SHAPE with the reason."""
    if score is None:
        return ScoreCell(None, MISSING_SHAPE, MISSING_LABEL, reason or REASON_NOT_SCORED)
    value = max(0, min(100, int(score)))
    for low, high, shape, label in BANDS:
        if low <= value <= high:
            return ScoreCell(value, shape, label)
    return ScoreCell(None, MISSING_SHAPE, MISSING_LABEL, reason or REASON_NOT_SCORED)  # unreachable


def build_google_summary(obs: "Observations") -> GoogleSummary:
    """Scores from obs.psi.median_run (mobile) and obs.psi.desktop."""
    from ..psi import CATEGORY_KEYS
    from .common import psi_median_run, psi_unavailable_reason

    psi = obs.psi
    if psi is None or psi.status != "ok":
        reason = psi_unavailable_reason(obs)
        cells = {k: score_cell(None, reason) for k in CATEGORY_KEYS}
        return GoogleSummary(mobile=dict(cells), desktop=dict(cells), reason=reason)
    summary = GoogleSummary()
    mobile = psi_median_run(obs)
    for key in CATEGORY_KEYS:
        if mobile is None:
            summary.mobile[key] = score_cell(None, psi_unavailable_reason(obs))
        else:
            summary.mobile[key] = score_cell((mobile.scores or {}).get(key), REASON_NOT_SCORED)
    desktop = psi.desktop if psi.desktop is not None and psi.desktop.ok else None
    for key in CATEGORY_KEYS:
        if desktop is None:
            summary.desktop[key] = score_cell(None, REASON_DESKTOP_MISSING)
        else:
            summary.desktop[key] = score_cell((desktop.scores or {}).get(key), REASON_NOT_SCORED)
    return summary
