"""Partition every real ASR test across required CI jobs without changing assertions."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

SHARDS = (
    "native",
    "languages",
    "state-single",
    "state-multi",
    "long-input",
    "alignment",
)
FILES = (
    "tests/test_real_asr.py",
    "tests/test_real_multilingual_asr.py",
    "tests/test_real_model_reuse.py",
)


def shard_for(node_id: str) -> str:
    if not node_id.startswith(tuple(name + "::" for name in FILES)):
        raise ValueError("Unexpected real-test collection entry")
    if node_id.startswith("tests/test_real_model_reuse.py::"):
        return "long-input"
    function = node_id.split("::", 1)[1].split("[", 1)[0]
    if "native_kernel_alignment" in function:
        return "native"
    if (
        "multilingual_content_and_reused" in function
        or "language_metadata_published_base" in function
    ):
        return "languages"
    if "full_minute_languages" in function:
        if node_id.endswith("[1]"):
            return "state-single"
        if node_id.endswith("[2]"):
            return "state-multi"
        raise ValueError("Unsupported repeatability thread case")
    if "ten_minute" in function:
        return "long-input"
    return "alignment"


def partition(node_ids: list[str]) -> dict[str, list[str]]:
    if not node_ids or len(node_ids) != len(set(node_ids)):
        raise ValueError("Real-test collection is empty or duplicated")
    result: dict[str, list[str]] = {name: [] for name in SHARDS}
    for node_id in node_ids:
        result[shard_for(node_id)].append(node_id)
    if sum(map(len, result.values())) != len(node_ids):
        raise ValueError("Incomplete real-test partition")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--shard", choices=SHARDS)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    worker = root / "workers/ai-worker"
    # The repository job partitions unit/real tests. A shard always collects
    # both complete real files, independently of the caller's pytest options.
    environment = dict(os.environ)
    environment.pop("PYTEST_ADDOPTS", None)
    collected = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "--collect-only",
            "-q",
            "-o",
            "addopts=",
            *FILES,
        ],
        cwd=worker,
        env=environment,
        text=True,
        capture_output=True,
        timeout=90,
        check=False,
    )
    if collected.returncode:
        raise RuntimeError("Real ASR test collection failed")
    node_ids = [
        line.strip()
        for line in collected.stdout.splitlines()
        if line.startswith("tests/") and "::" in line
    ]
    groups = partition(node_ids)
    if any(not group for group in groups.values()):
        raise ValueError("Required real-test shard is empty")
    print(
        json.dumps(
            {
                "realTests": len(node_ids),
                "partition": {k: len(v) for k, v in groups.items()},
            }
        ),
        flush=True,
    )
    if args.check:
        return 0
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-v", *groups[args.shard]],
        cwd=worker,
        env=environment,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
