"""Canonical media-core Python execution boundary for the existing VAD WAV preset.

This package owns Python FFmpeg launch as well as the Node builder/executor.
No model/settings/VAD behavior belongs here. Production argv is never caller supplied.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Callable
from pathlib import Path


def normalize_wav(
    source: Path,
    output: Path,
    executable: Path,
    sample_count: int,
    check: Callable[[], None],
) -> None:
    for path in (source, output, executable):
        if (
            not path.is_absolute()
            or any(ord(c) < 32 or ord(c) == 127 for c in str(path))
            or "://" in str(path)
        ):
            raise ValueError("Controlled local paths are required")
    if (
        isinstance(sample_count, bool)
        or not isinstance(sample_count, int)
        or not 0 < sample_count <= 28_800_000
    ):
        raise ValueError("Invalid normalization sample count")
    # File-only protocol + WAV-only demuxer: playlists/URLs are never input formats.
    args = [
        str(executable),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "wav",
        "-i",
        str(source.resolve()),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-af",
        f"aresample=16000,apad,atrim=end_sample={sample_count},asetpts=PTS-STARTPTS",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "-fs",
        str(sample_count * 2 + 1),
        str(output),
    ]
    process = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": "C",
            "LC_ALL": "C",
        },
    )
    try:
        while process.poll() is None:
            check()
            time.sleep(0.01)
        if process.returncode != 0:
            raise ValueError("Audio normalization failed")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
