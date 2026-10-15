"""Offline model, non-speech, cancellation and source-integrity regressions."""

from __future__ import annotations

import hashlib
import threading
import wave
from pathlib import Path

import numpy as np
import pytest

from editagent_ai_worker.domain.analysis.transcription import (
    TranscriptionCancelled,
    TranscriptionError,
)
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.asr_model import verify_asr_model
from editagent_ai_worker.infrastructure.faster_whisper import FasterWhisperAdapter

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def adapter() -> FasterWhisperAdapter:
    return FasterWhisperAdapter(AsrSettings(model="tiny", model_root=ROOT / ".local/asr-models"))


@pytest.mark.parametrize("signal_kind", ["silence", "tone", "music"])
def test_real_silence_and_non_speech_tone(
    adapter: FasterWhisperAdapter, tmp_path: Path, signal_kind: str
) -> None:
    path = tmp_path / "input.wav"
    samples = np.arange(16000 * 3, dtype=np.float64)
    if signal_kind == "silence":
        waveform = np.zeros(len(samples))
    elif signal_kind == "tone":
        waveform = np.sin(samples * 2 * np.pi * 440 / 16000) * 2000
    else:
        # Deterministic instrumental triad with a pulsed envelope; mathematically
        # contains no voice, reference transcript, or copyrighted recording.
        envelope = 0.5 + 0.5 * np.cos(samples * 2 * np.pi * 2 / 16000)
        waveform = (
            sum(np.sin(samples * 2 * np.pi * hz / 16000) for hz in (261.63, 329.63, 392.0))
            * 1500
            * envelope
        )
    pcm = waveform.astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        w.writeframes(pcm.tobytes())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    identity = AudioIdentity("fixture", digest, "fixture-asr", digest, 3000000, 0, 3000000)
    result = adapter.transcribe(str(path), identity)
    assert result.words == ()
    assert result.language == "und"


def test_cancellation_prevents_inference(adapter: FasterWhisperAdapter) -> None:
    event = threading.Event()
    event.set()
    with pytest.raises(TranscriptionCancelled):
        adapter.transcribe(
            "/not/read", AudioIdentity("x", "a" * 64, "x", "b" * 64, 1000000, 0, 1000000), event
        )


def test_missing_or_tampered_model_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(TranscriptionError):
        verify_asr_model(tmp_path, "tiny")


@pytest.mark.parametrize("duration_us,frames", [(333333, 5333), (1000001, 16000), (333333, 5334)])
def test_verified_final_partial_sample_is_not_a_truncated_chunk(
    adapter: FasterWhisperAdapter, tmp_path: Path, duration_us: int, frames: int
) -> None:
    path = tmp_path / "fractional-duration.wav"
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(bytes(frames * 2))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    source = AudioIdentity("fixture", digest, "fixture-asr", digest, duration_us, 0, duration_us)
    result = adapter.transcribe(str(path), source)
    assert result.words == () and result.language == "und"


def test_empty_pcm_cannot_claim_a_positive_source_duration(
    adapter: FasterWhisperAdapter, tmp_path: Path
) -> None:
    path = tmp_path / "empty.wav"
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    source = AudioIdentity("fixture", digest, "fixture-asr", digest, 1, 0, 1)
    with pytest.raises(TranscriptionError, match="Canonical audio is empty"):
        adapter.transcribe(str(path), source)
