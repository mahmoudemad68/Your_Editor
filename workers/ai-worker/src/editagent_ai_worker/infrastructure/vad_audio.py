"""Verified local WAV input. Canonical US-128 asr.wav needs no decoder/model download."""

from __future__ import annotations

import contextlib
import hashlib
import tempfile
import time
import wave
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import BinaryIO, cast

from editagent_media_core import normalize_wav

from editagent_ai_worker.domain.analysis.voice_activity import (
    SAMPLE_RATE,
    AudioIdentity,
    Cancellation,
    InvalidAudio,
    VadCancelled,
    VadTimeout,
    integer,
)

MAX_INPUT_BYTES = 512 * 1024 * 1024  # Staged WAV adapter bound; not a new upload policy.


def verify_audio_file(
    path: Path, identity: AudioIdentity, check: Callable[[], None] | None = None
) -> None:
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_INPUT_BYTES:
        raise InvalidAudio("Staged audio is missing, unsafe or exceeds the adapter limit")
    digest = hashlib.sha256()
    seen = 0
    with path.open("rb") as source:
        while chunk := source.read(65_536):
            if check is not None:
                check()
            seen += len(chunk)
            if seen > MAX_INPUT_BYTES:
                raise InvalidAudio("Staged audio exceeds the adapter limit")
            digest.update(chunk)
    if digest.hexdigest() != identity.audio_sha256:
        raise InvalidAudio("Staged audio checksum differs from persisted identity")


def wav_parameters(path: Path, identity: AudioIdentity) -> tuple[int, int, int]:
    try:
        with wave.open(str(path), "rb") as wav:
            rate, channels, width, count = (
                wav.getframerate(),
                wav.getnchannels(),
                wav.getsampwidth(),
                wav.getnframes(),
            )
            if (
                wav.getcomptype() != "NONE"
                or rate not in {8000, 16000, 22050, 24000, 44100, 48000}
                or not 1 <= channels <= 8
                or width not in {2, 3, 4}
                or abs(count * 1_000_000 - identity.duration_us * rate) > 1_000_000
            ):
                raise InvalidAudio("Unsupported WAV format or inconsistent scope duration")
            # Wave headers must not declare more samples than the file actually contains.
            expected = count * channels * width
            if expected > path.stat().st_size:
                raise InvalidAudio("Truncated WAV input")
            return rate, channels, width
    except (wave.Error, EOFError, OSError) as exc:
        raise InvalidAudio("Invalid or unsupported WAV input") from exc


class WavePcmReader:
    def __init__(self, wav: wave.Wave_read) -> None:
        self._wav = wav

    def read(self, size: int = -1) -> bytes:
        if not 1 <= size <= 1024:
            raise InvalidAudio("PCM reads must be bounded")
        return self._wav.readframes((size + 1) // 2)


@contextlib.contextmanager
def normalized_audio(
    path: Path,
    identity: AudioIdentity,
    *,
    ffmpeg: Path | None = None,
    timeout_ms: int = 120_000,
    cancellation: Cancellation | None = None,
    temporary_root: Path | None = None,
) -> Iterator[BinaryIO]:
    integer(timeout_ms, 1, 600_000)
    deadline = time.monotonic() + timeout_ms / 1000

    def check() -> None:
        if cancellation is not None and cancellation.is_set():
            raise VadCancelled("Audio normalization cancelled")
        if time.monotonic() >= deadline:
            raise VadTimeout("Audio normalization timed out")

    check()
    verify_audio_file(path, identity, check)
    parameters = wav_parameters(path, identity)
    check()
    if parameters == (SAMPLE_RATE, 1, 2):
        with wave.open(str(path), "rb") as wav:
            if wav.getnframes() != identity.sample_count:
                raise InvalidAudio("Canonical WAV sample count differs from scope")
            yield cast(BinaryIO, WavePcmReader(wav))
        return
    if ffmpeg is None or not ffmpeg.is_absolute():
        raise InvalidAudio("Noncanonical WAV requires an explicitly configured local FFmpeg")
    with tempfile.TemporaryDirectory(prefix="editagent-vad-", dir=temporary_root) as directory:
        output = Path(directory) / "normalized.pcm"
        try:
            normalize_wav(path.resolve(), output, ffmpeg, identity.sample_count, check)
        except ValueError as exc:
            raise InvalidAudio(
                "Audio normalization failed or returned inconsistent duration"
            ) from exc
        if output.stat().st_size != identity.sample_count * 2:
            raise InvalidAudio("Audio normalization failed or returned inconsistent duration")
        with output.open("rb") as stream:
            yield stream
