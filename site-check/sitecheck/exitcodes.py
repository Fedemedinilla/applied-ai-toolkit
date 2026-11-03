"""Exit codes: the contract with the shell, the tests and any batch wrapper.

Precedence when several apply (first wins): USAGE, EXCLUDED (before any
request), SCOPE_VIOLATION, HOME_UNREACHABLE, TEXT_CONTROL, HACK_GATE, OK.
UNEXPECTED (1) is any uncaught exception, anywhere. The values never change
without a note in the README.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum


class ExitCode(IntEnum):
    OK = 0  # run complete: datos.json, informe.md and anexo-tecnico.md written
    UNEXPECTED = 1  # uncaught error (traceback on stderr, key redacted)
    USAGE = 2  # invalid arguments or configuration (argparse uses 2 too)
    HOME_UNREACHABLE = 3  # home did not answer or was challenged from the first request
    TEXT_CONTROL = 4  # report text failed the control (forbidden word, dash, placeholder, key, e-mail)
    EXCLUDED = 10  # domain on the exclusion list: no request made, no folder created
    HACK_GATE = 30  # signs of compromise: the report leads with them, nothing else is wrong with the run
    SCOPE_VIOLATION = 50  # the scope guard refused a request the tool itself built: a bug, run aborted


PRECEDENCE: tuple[ExitCode, ...] = (
    ExitCode.USAGE,
    ExitCode.EXCLUDED,
    ExitCode.SCOPE_VIOLATION,
    ExitCode.HOME_UNREACHABLE,
    ExitCode.TEXT_CONTROL,
    ExitCode.HACK_GATE,
    ExitCode.OK,
)


@dataclass
class OutcomeFlags:
    """What happened in a run, from which the single exit code is resolved."""

    usage_error: bool = False
    excluded: bool = False
    scope_violation: bool = False
    home_unreachable: bool = False
    text_control_failed: bool = False
    hack_gate: bool = False


_FLAG_OF: dict[ExitCode, str] = {
    ExitCode.USAGE: "usage_error",
    ExitCode.EXCLUDED: "excluded",
    ExitCode.SCOPE_VIOLATION: "scope_violation",
    ExitCode.HOME_UNREACHABLE: "home_unreachable",
    ExitCode.TEXT_CONTROL: "text_control_failed",
    ExitCode.HACK_GATE: "hack_gate",
}

# One line per code, for the console summary and the README.
DESCRIPTION: dict[ExitCode, str] = {
    ExitCode.OK: "report written",
    ExitCode.UNEXPECTED: "unexpected error",
    ExitCode.USAGE: "invalid options or configuration",
    ExitCode.HOME_UNREACHABLE: "the home page did not answer or stayed behind an anti-bot check",
    ExitCode.TEXT_CONTROL: "the text control found a problem in the report; see datos.json salida.control_texto",
    ExitCode.EXCLUDED: "the domain is on the exclusion list",
    ExitCode.HACK_GATE: "signs that the site was compromised; the report leads with them",
    ExitCode.SCOPE_VIOLATION: "the scope guard refused a request (a bug); run aborted",
}


def resolve(flags: OutcomeFlags) -> ExitCode:
    """The first code of PRECEDENCE whose flag is set; OK when none."""
    for code in PRECEDENCE:
        name = _FLAG_OF.get(code)
        if name is not None and getattr(flags, name):
            return code
    return ExitCode.OK
