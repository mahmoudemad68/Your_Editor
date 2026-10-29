#!/usr/bin/env python3
"""Copy the exception summary from a private ASR diagnostic without raw operands."""

from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> int:
    destination = Path(sys.argv[1])
    files = sorted(Path(".local/asr-batch").glob("integration-failure-*.txt"))
    if not files:
        destination.write_text("no private ASR diagnostic was written\n", encoding="utf-8")
        return 0
    text = files[-1].read_text(encoding="utf-8", errors="replace")
    # The private file starts with an exception repr. Keep the type and a short message.
    first = text.splitlines()[0][:500]
    first = re.sub(r"(?i)(password|secret|token|authorization)[=:][^\s,]+", r"\1=<redacted>", first)
    destination.write_text(first + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
