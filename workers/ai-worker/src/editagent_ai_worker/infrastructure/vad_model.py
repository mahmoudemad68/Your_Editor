"""Explicit setup only: acquire one pinned MIT Silero graph, never download during inference."""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

from editagent_ai_worker.domain.analysis.voice_activity import VadModelError

MODEL_NAME = "silero-vad"
MODEL_VERSION = "v6-faster-whisper-1.2.1"
MODEL_SHA256 = "4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2"
MODEL_SIZE = 1_245_151
MODEL_URL = (
    "https://raw.githubusercontent.com/SYSTRAN/faster-whisper/v1.2.1/"
    "faster_whisper/assets/silero_vad_v6.onnx"
)


def default_model_path() -> Path:
    return Path(sys.prefix) / "share" / "editagent" / "silero_vad_v6.onnx"


def verify_model(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size != MODEL_SIZE:
        raise VadModelError("Pinned Silero model is unavailable or invalid; run vad:setup")
    if hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
        raise VadModelError("Silero model integrity check failed")


def acquire_model(destination: Path | None = None) -> Path:
    path = default_model_path() if destination is None else destination
    if path.exists() or path.is_symlink():
        verify_model(path)
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".silero-download-", dir=path.parent)
    temporary = Path(name)
    try:
        # urllib honors the configured HTTPS proxy and system/SSL_CERT_FILE trust.
        with (
            os.fdopen(fd, "wb") as output,
            urllib.request.urlopen(MODEL_URL, timeout=60) as response,
        ):
            size = 0
            while chunk := response.read(65_536):
                size += len(chunk)
                if size > MODEL_SIZE:
                    raise VadModelError("Silero download exceeds pinned size")
                output.write(chunk)
        verify_model(temporary)
        temporary.chmod(0o644)
        # Exclusive destination creation: concurrent setup cannot overwrite unknown bytes.
        try:
            os.link(temporary, path)
        except FileExistsError:
            verify_model(path)
        return path
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    acquire_model()
    print(f"Silero model ready: {MODEL_VERSION} SHA256={MODEL_SHA256}")
