#!/usr/bin/env python3
"""Fail closed unless every expected case is present and acceptable.

FAIL, ERROR, and NOT_RUN always fail the aggregate.
NOT_VERIFIED fails when the case is required.
OBSERVED is accepted only for cases that are not required.
A required case must be PASS.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from cases import CASES  # noqa: E402


def load_results(paths: list[Path]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for path in paths:
        if not path.is_file():
            continue
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            case_id = row.get("id")
            if not isinstance(case_id, str) or not case_id:
                raise SystemExit(f"{path}:{line_number} missing id")
            if case_id in found:
                raise SystemExit(f"duplicate result {case_id}")
            found[case_id] = row
    return found


def evaluate(found: dict[str, dict]) -> tuple[list[str], dict[str, dict[str, int]]]:
    problems: list[str] = []
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    expected_ids = set()
    for case_id, gate, required in CASES:
        expected_ids.add(case_id)
        row = found.get(case_id)
        if row is None:
            problems.append(f"MISSING {case_id}")
            counts[gate]["MISSING"] += 1
            continue
        status = str(row.get("status", ""))
        counts[gate][status] += 1
        if status in {"FAIL", "ERROR", "NOT_RUN"}:
            problems.append(f"{status} {case_id}: {row.get('detail', '')}")
        elif status == "NOT_VERIFIED" and required:
            problems.append(f"NOT_VERIFIED {case_id}: {row.get('detail', '')}")
        elif status == "OBSERVED" and required:
            problems.append(f"OBSERVED required {case_id}")
        elif status == "PASS":
            continue
        elif status == "NOT_VERIFIED" and not required:
            continue
        elif status == "OBSERVED" and not required:
            continue
        else:
            problems.append(f"bad status {status} for {case_id}")
    for case_id in sorted(set(found) - expected_ids):
        problems.append(f"UNEXPECTED {case_id}")
    return problems, counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", nargs="+", type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    found = load_results(args.results)
    problems, counts = evaluate(found)
    summary = {
        "problems": len(problems),
        "counts": {gate: dict(bucket) for gate, bucket in sorted(counts.items())},
        "verdict": "PASS" if not problems else "FAIL",
    }
    text = json.dumps(summary, indent=2, sort_keys=True)
    print(text)
    if args.summary:
        args.summary.write_text(text + "\n", encoding="utf-8")
    if problems:
        print("EVIDENCE GATE FAIL", file=sys.stderr)
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    print("EVIDENCE GATE PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
