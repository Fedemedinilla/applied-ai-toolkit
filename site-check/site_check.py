"""Passive website check: ``python3 -I -S site_check.py URL [options]``.

Thin entry point; everything lives in the sitecheck package next to this file.
``-I -S`` keeps third-party packages out, and the CLI refuses to run if any
module outside the standard library was loaded anyway.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make "sitecheck" importable under "python -I", which does not add the
# script's folder to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sitecheck.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
