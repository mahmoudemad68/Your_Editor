"""Fixed isolated entrypoint: establish lifecycle fencing before importing native code."""

import ctypes
import os
import runpy
import signal
import sys


def main() -> None:
    # A fixed supervisor argument keeps parent-death protection ahead of even
    # configuration/framework imports. Job payloads only arrive later on stdin.
    try:
        parent = int(sys.argv[1])
    except (ValueError, IndexError):
        raise SystemExit(1) from None
    if parent <= 1:
        raise SystemExit(1)
    if ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL) != 0 or os.getppid() != parent:
        raise SystemExit(1)
    from editagent_ai_worker.infrastructure.config import configure_asr_native_environment

    configure_asr_native_environment()
    runpy.run_module("editagent_ai_worker.composition.analysis_job", run_name="__main__")


if __name__ == "__main__":
    main()
