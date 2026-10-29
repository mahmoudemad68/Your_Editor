#!/usr/bin/env python3
"""Prove the evidence gate rejects injected FAIL, ERROR, NOT_RUN, missing, and required NOT_VERIFIED rows."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from cases import CASES  # noqa: E402
from results import emit  # noqa: E402


def passing_rows() -> list[dict]:
    rows = []
    for case_id, gate, required in CASES:
        status = "PASS" if required else "OBSERVED"
        rows.append(
            {
                "id": case_id,
                "gate": gate,
                "status": status,
                "required": required,
                "detail": "fixture",
            }
        )
    return rows


def run_gate(rows: list[dict]) -> int:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "rows.jsonl"
        path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, str(ROOT / "evidence_gate.py"), str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        return completed.returncode


def main() -> int:
    results = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("qa-results-g4.jsonl")
    ok = passing_rows()
    if run_gate(ok) != 0:
        emit(results, "g4.fail_closed_proof", "G4", "FAIL", True, "all-PASS fixture did not pass the gate")
        return 1
    injections = []
    for status in ("FAIL", "ERROR", "NOT_RUN"):
        rows = passing_rows()
        rows[0] = {**rows[0], "status": status, "detail": "injected"}
        injections.append((status, rows, 1))
    missing = passing_rows()[1:]
    injections.append(("MISSING", missing, 1))
    unverified = passing_rows()
    unverified[0] = {**unverified[0], "status": "NOT_VERIFIED", "detail": "injected"}
    injections.append(("NOT_VERIFIED", unverified, 1))
    optional = next(index for index, case in enumerate(CASES) if not case[2])
    observed = passing_rows()
    observed[optional] = {**observed[optional], "status": "NOT_VERIFIED", "detail": "optional"}
    injections.append(("optional NOT_VERIFIED", observed, 0))
    failed = []
    for label, rows, expected in injections:
        actual = run_gate(rows)
        if actual != expected:
            failed.append(f"{label} exit {actual} expected {expected}")
    if failed:
        emit(results, "g4.fail_closed_proof", "G4", "FAIL", True, "; ".join(failed))
        return 1
    emit(
        results,
        "g4.fail_closed_proof",
        "G4",
        "PASS",
        True,
        "gate rejects injected FAIL, ERROR, NOT_RUN, MISSING, and required NOT_VERIFIED; accepts optional NOT_VERIFIED",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
