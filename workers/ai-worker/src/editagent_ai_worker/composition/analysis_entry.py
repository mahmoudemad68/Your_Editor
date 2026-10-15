"""Fixed isolated entrypoint: establish lifecycle fencing before importing native code."""

import ctypes
import os
import runpy
import signal


def main() -> None:
    parent = int(os.environ["EDITAGENT_ANALYSIS_PARENT_PID"])
    if ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL) != 0 or os.getppid() != parent:
        raise SystemExit(1)
    runpy.run_module("editagent_ai_worker.composition.analysis_job", run_name="__main__")


if __name__ == "__main__":
    main()
