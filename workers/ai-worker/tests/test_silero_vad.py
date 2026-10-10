from __future__ import annotations

import hashlib
import io
import shutil
import subprocess
import threading
import wave
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from editagent_ai_worker.application.voice_activity import analyse_speech
from editagent_ai_worker.domain.analysis.voice_activity import (
    AudioIdentity,
    InvalidAudio,
    VadCancelled,
    VadModelError,
    VadTimeout,
)
from editagent_ai_worker.infrastructure.silero_vad import SileroVadAdapter
from editagent_ai_worker.infrastructure.speech_schema import serialize
from editagent_ai_worker.infrastructure.vad_audio import normalized_audio
from editagent_ai_worker.infrastructure.vad_model import default_model_path, verify_model
from test_voice_activity import configuration, identity


@pytest.fixture(scope="module")
def detector() -> SileroVadAdapter:
    # Fail clearly if setup was not run; this test never silently downloads/skips inference.
    return SileroVadAdapter(default_model_path(), timeout_ms=120_000)


@pytest.fixture(scope="module")
def synthesized_speech(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("synthetic-vad-speech")
    output = root / "speech.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "flite=text='Hello world. This is a speech detection test. "
            "Please preserve every word.':voice=slt",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output),
        ],
        check=True,
        timeout=30,
        capture_output=True,
    )
    return output


def audio_identity(path: Path) -> AudioIdentity:
    with wave.open(str(path), "rb") as wav:
        duration = wav.getnframes() * 1_000_000 // wav.getframerate()
    return AudioIdentity(
        "synthetic-speech",
        "a" * 64,
        "synthetic-asr",
        hashlib.sha256(path.read_bytes()).hexdigest(),
        duration,
        0,
        duration,
    )


def test_real_model_silence_and_repeatability(detector: SileroVadAdapter) -> None:
    source = identity(1_000_000)
    a = detector.detect(io.BytesIO(bytes(32_000)), source, configuration())
    b = detector.detect(io.BytesIO(bytes(32_000)), source, configuration())
    assert a.regions == ()
    assert serialize(a) == serialize(b)
    assert a.provenance.sample_rate == 16000


def test_real_speech_normalization_schema_and_repeatability(
    detector: SileroVadAdapter, synthesized_speech: Path
) -> None:
    source = audio_identity(synthesized_speech)
    with normalized_audio(synthesized_speech, source) as pcm:
        a = analyse_speech(detector, pcm, source, configuration())
    with normalized_audio(synthesized_speech, source) as pcm:
        b = analyse_speech(detector, pcm, source, configuration())
    assert a.regions
    assert all(0 <= r.start_us < r.end_us <= source.source_duration_us for r in a.regions)
    assert serialize(a) == serialize(b)


def test_real_multi_chunk_mixed_input_preserves_state(
    detector: SileroVadAdapter, synthesized_speech: Path
) -> None:
    with wave.open(str(synthesized_speech), "rb") as wav:
        speech = wav.readframes(wav.getnframes())
    raw = bytes(64_000) + speech + bytes(64_000)
    source = identity(len(raw) // 2 * 1_000_000 // 16000)
    result = detector.detect(io.BytesIO(raw), source, configuration(padding_us=100_000))
    assert result.regions
    assert result.regions[0].start_us > 1_000_000
    assert result.regions[-1].end_us < source.source_duration_us - 1_000_000
    # Thousands of individual ONNX windows; never decode/load long audio into a model tensor.
    long_source = identity(65_000_000)
    assert (
        detector.detect(io.BytesIO(bytes(65 * 32000)), long_source, configuration()).regions == ()
    )


def test_real_low_volume_and_short_speech(
    detector: SileroVadAdapter, synthesized_speech: Path
) -> None:
    with wave.open(str(synthesized_speech), "rb") as wav:
        speech = wav.readframes(wav.getnframes())
    # A quarter amplitude still produces finite/bounded probabilities, with no English text input.
    quiet = (np.frombuffer(speech, dtype="<i2") // 4).astype("<i2").tobytes()
    result = detector.detect(
        io.BytesIO(quiet), identity(len(quiet) // 2 * 1_000_000 // 16000), configuration()
    )
    assert result.regions
    short = speech[:8000]
    result = detector.detect(io.BytesIO(short), identity(250_000), configuration(min_speech_us=1))
    serialize(result)


def test_real_alternate_rate_asymmetric_stereo_and_cleanup(
    detector: SileroVadAdapter, synthesized_speech: Path, tmp_path: Path
) -> None:
    ffmpeg = Path(shutil.which("ffmpeg") or "/missing-ffmpeg")
    output = tmp_path / "stereo8k.wav"
    subprocess.run(
        [
            str(ffmpeg),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(synthesized_speech),
            "-af",
            "pan=stereo|c0=0*c0|c1=c0",
            "-ar",
            "8000",
            "-c:a",
            "pcm_s16le",
            str(output),
        ],
        check=True,
        timeout=30,
        capture_output=True,
    )
    source = audio_identity(output)
    with normalized_audio(output, source, ffmpeg=ffmpeg, temporary_root=tmp_path) as pcm:
        assert list(tmp_path.glob("editagent-vad-*"))
        result = detector.detect(pcm, source, configuration())
        assert result.regions  # Speech in right channel, not arbitrarily selecting silent left.
    assert not list(tmp_path.glob("editagent-vad-*"))


def test_permanent_audio_and_model_failures(
    detector: SileroVadAdapter, synthesized_speech: Path, tmp_path: Path
) -> None:
    for raw in [b"", bytes(32_002)]:
        with pytest.raises(InvalidAudio):
            detector.detect(io.BytesIO(raw), identity(1_000_000), configuration())
    source = replace(audio_identity(synthesized_speech), audio_sha256="0" * 64)
    with pytest.raises(InvalidAudio):
        with normalized_audio(synthesized_speech, source):
            pass
    symlink = tmp_path / "source.wav"
    symlink.symlink_to(synthesized_speech)
    with pytest.raises(InvalidAudio):
        with normalized_audio(symlink, audio_identity(synthesized_speech)):
            pass
    model = tmp_path / "model.onnx"
    model.write_bytes(b"bad")
    with pytest.raises(VadModelError):
        verify_model(model)
    with pytest.raises(VadModelError):
        SileroVadAdapter(model, 1000)


def test_cancellation_timeout_and_reusable_model(detector: SileroVadAdapter) -> None:
    cancellation = threading.Event()
    cancellation.set()
    with pytest.raises(VadCancelled):
        detector.detect(
            io.BytesIO(bytes(32000)), identity(1_000_000), configuration(), cancellation
        )
    small_deadline = SileroVadAdapter(default_model_path(), timeout_ms=1)
    with pytest.raises(VadTimeout):
        small_deadline.detect(io.BytesIO(bytes(65 * 32000)), identity(65_000_000), configuration())
    assert (
        detector.detect(io.BytesIO(bytes(32000)), identity(1_000_000), configuration()).regions
        == ()
    )


def test_normalization_failure_timeout_and_cancel_cleanup(
    synthesized_speech: Path, tmp_path: Path
) -> None:
    ffmpeg = Path(shutil.which("ffmpeg") or "/missing-ffmpeg")
    output = tmp_path / "alternate.wav"
    subprocess.run(
        [
            str(ffmpeg),
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(synthesized_speech),
            "-ar",
            "8000",
            str(output),
        ],
        check=True,
        timeout=30,
        capture_output=True,
    )
    source = audio_identity(output)
    with pytest.raises(InvalidAudio):
        with normalized_audio(
            output, source, ffmpeg=Path("/usr/bin/false"), temporary_root=tmp_path
        ):
            pass
    assert not list(tmp_path.glob("editagent-vad-*"))
    with pytest.raises(VadTimeout):
        with normalized_audio(output, source, ffmpeg=ffmpeg, timeout_ms=1, temporary_root=tmp_path):
            pass
    assert not list(tmp_path.glob("editagent-vad-*"))
    cancellation = threading.Event()
    cancellation.set()
    with pytest.raises(VadCancelled):
        with normalized_audio(output, source, cancellation=cancellation, ffmpeg=ffmpeg):
            pass


def test_model_setup_is_pinned_bounded_exclusive_and_reused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from editagent_ai_worker.infrastructure.vad_model import acquire_model

    # Mock acquisition only. Inference tests above always execute the actual verified graph.
    model = default_model_path().read_bytes()
    calls: list[str] = []

    def download(url: str, timeout: int) -> io.BytesIO:
        calls.append(url)
        return io.BytesIO(model)

    monkeypatch.setattr("urllib.request.urlopen", download)
    destination = tmp_path / "weights.onnx"
    assert acquire_model(destination) == destination
    assert destination.read_bytes() == model
    assert len(calls) == 1
    assert acquire_model(destination) == destination
    assert len(calls) == 1
    destination.write_bytes(b"bad")
    with pytest.raises(VadModelError):
        acquire_model(destination)
    assert destination.read_bytes() == b"bad"
    assert not list(tmp_path.glob(".silero-download-*"))
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(model + b"x")
    )
    with pytest.raises(VadModelError):
        acquire_model(tmp_path / "oversized.onnx")
    assert not (tmp_path / "oversized.onnx").exists()
    assert not list(tmp_path.glob(".silero-download-*"))
