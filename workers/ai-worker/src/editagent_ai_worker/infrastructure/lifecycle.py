"""Scaffold process wait. A later story replaces this with queue consumption."""

import signal
import threading
from pathlib import Path
from types import FrameType

READY_FILE_PATH = Path("/tmp/editagent.ready")


def keep_process_alive(ready_file: Path = READY_FILE_PATH) -> None:
    ready_file.write_text("ok\n", encoding="utf-8")
    stop = threading.Event()

    def _request_stop(_signum: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)
    while not stop.wait(60):
        continue
