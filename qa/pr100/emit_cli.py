#!/usr/bin/env python3
"""Record one QA result from a shell step: emit_cli.py RESULTS ID GATE STATUS REQUIRED DETAIL"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from results import emit  # noqa: E402


def main() -> int:
    if len(sys.argv) < 7:
        print("usage: emit_cli.py RESULTS ID GATE STATUS REQUIRED DETAIL", file=sys.stderr)
        return 2
    results, case_id, gate, status, required, detail = sys.argv[1:7]
    emit(results, case_id, gate, status, required.lower() == "true", detail)
    return 0 if status in {"PASS", "OBSERVED", "NOT_VERIFIED"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
