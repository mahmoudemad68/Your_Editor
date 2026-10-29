#!/usr/bin/env python3
"""Refuse to run QA unless the product commit and tree are the frozen pin and QA adds only harness files."""

from __future__ import annotations

import subprocess
import sys

PRODUCT = "12b09f704d32bc68f662404872586f89d26f284f"
TREE = "ae20e671caceeb8c567c227692cbdea428b7762b"
ALLOWED = {".github/workflows/qa-pr100-independent.yml"}


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def main() -> int:
    head = git("rev-parse", PRODUCT)
    tree = git("rev-parse", f"{PRODUCT}^{{tree}}")
    print(f"PRODUCT_HEAD={head}")
    print(f"PRODUCT_TREE={tree}")
    if head != PRODUCT or tree != TREE:
        print("HEAD_DRIFT", file=sys.stderr)
        return 2
    changed = [line for line in git("diff", "--name-only", PRODUCT, "HEAD").splitlines() if line]
    unexpected = [path for path in changed if path not in ALLOWED and not path.startswith("qa/")]
    if unexpected:
        print("QA tree changes product files:", file=sys.stderr)
        for path in unexpected:
            print(path, file=sys.stderr)
        return 2
    print("QA_HEAD=" + git("rev-parse", "HEAD"))
    print("QA_PATHS=" + ",".join(changed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
