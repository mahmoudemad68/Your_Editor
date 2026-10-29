"""Append machine-readable QA results. Status is PASS, FAIL, ERROR, NOT_RUN, NOT_VERIFIED, or OBSERVED."""

from __future__ import annotations

import json
from pathlib import Path

STATUSES = {"PASS", "FAIL", "ERROR", "NOT_RUN", "NOT_VERIFIED", "OBSERVED"}


def emit(path: str | Path, case_id: str, gate: str, status: str, required: bool, detail: str, **extra: object) -> None:
    if status not in STATUSES:
        raise ValueError(f"bad status {status}")
    row = {
        "id": case_id,
        "gate": gate,
        "status": status,
        "required": bool(required),
        "detail": detail,
    }
    row.update(extra)
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")
    print(f"{status} {case_id}: {detail[:400]}")
