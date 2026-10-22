"""Real offline CPU inference; fixtures are attributed excerpts, never synthetic gold."""

from __future__ import annotations

import hashlib
import json
import wave
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any, Literal

import pytest

from editagent_ai_worker.domain.analysis.transcription import Word
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.faster_whisper import FasterWhisperAdapter

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("model", ["tiny", "small"])
@pytest.mark.parametrize("threads", [1, 2])
def test_real_offgrid_code_switch_preserves_complete_native_component_words(
    model: Literal["tiny", "small"], threads: int, tmp_path: Path
) -> None:
    """Actual switch recovery preserves every observed component word tuple.

    Component recognition is not independent human accuracy ground truth.
    The actual EN/AR transitions at 6/14 seconds cross the four-second cells.
    """
    manifest = json.loads((ROOT / "tests/fixtures/asr/manifest.json").read_text())
    samples = []
    for name in ("en.wav", "ar.wav"):
        path = ROOT / "tests/fixtures/asr" / name
        expected = next(entry for entry in manifest["fixtures"] if entry["file"] == name)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected["sha256"]
        with wave.open(str(path), "rb") as stream:
            assert stream.getparams()[:3] == (1, 2, 16000)
            samples.append(stream.readframes(stream.getnframes()))
    english, arabic = samples
    assert len(english) == len(arabic) == 8 * 32000
    path = tmp_path / "offgrid.wav"
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(english[: 6 * 32000] + arabic + english)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    source = AudioIdentity("offgrid-fixture", digest, "offgrid-pcm", digest, 22000000, 0, 22000000)
    adapter = FasterWhisperAdapter(
        AsrSettings(model=model, model_root=ROOT / ".local/asr-models", cpu_threads=threads)
    )
    try:
        expected_words: list[Word] = []
        for index, (pcm, lower, upper) in enumerate(
            [
                (english[: 6 * 32000], 0, 6000000),
                (arabic, 6000000, 14000000),
                (english, 14000000, 22000000),
            ]
        ):
            component = tmp_path / f"component-{index}.wav"
            with wave.open(str(component), "wb") as stream:
                stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                stream.writeframes(pcm)
            digest = hashlib.sha256(component.read_bytes()).hexdigest()
            identity = AudioIdentity(
                "component", digest, "component-pcm", digest, upper - lower, 0, upper - lower
            )
            observed = adapter.transcribe(str(component), identity)
            assert observed.words
            expected_words.extend(
                replace(word, start_us=word.start_us + lower, end_us=word.end_us + lower)
                for word in observed.words
            )
        results = [adapter.transcribe(str(path), source) for _ in range(2)]
        assert results[0] == results[1]
        assert results[0].words == tuple(expected_words)
        assert all(
            a.end_us <= b.start_us for a, b in zip(expected_words, expected_words[1:], strict=False)
        )
    finally:
        adapter.close()


@pytest.fixture(scope="module")
def real_adapter() -> Iterator[FasterWhisperAdapter]:
    value = FasterWhisperAdapter(AsrSettings(model="tiny", model_root=ROOT / ".local/asr-models"))
    try:
        yield value
    finally:
        value.close()


@pytest.mark.parametrize("language", ["en", "ar"])
def test_real_cpu_word_timestamps_language_and_repeatability(
    real_adapter: FasterWhisperAdapter, language: str
) -> None:
    path = ROOT / "tests/fixtures/asr" / (language + ".wav")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    source = AudioIdentity("fixture", digest, "fixture-asr", digest, 8_000_000, 0, 8_000_000)
    first = real_adapter.transcribe(str(path), source)
    second = real_adapter.transcribe(str(path), source)
    assert first == second
    assert first.language == language
    assert first.words
    assert all(
        0 <= w.start_us < w.end_us <= 8_000_000 and 0 <= w.confidence <= 1 for w in first.words
    )


def test_real_chunk_edges_preserve_words_and_original_source_coordinates(
    real_adapter: FasterWhisperAdapter,
) -> None:
    path = ROOT / "tests/fixtures/asr/en-chunks.wav"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    source = AudioIdentity(
        "commons-148215183",
        "793bade8dea8492b56d266f1d6fb2997f1c936cb01c0ff5c65fe449bbe59f0f1",
        "fixture-chunks",
        digest,
        615428000,
        96000000,
        156000000,
    )
    result = real_adapter.transcribe(str(path), source)
    assert result.language == "en"
    assert len(result.words) > 30
    assert all(96000000 <= word.start_us < word.end_us <= 156000000 for word in result.words)
    assert all(a.end_us <= b.start_us for a, b in zip(result.words, result.words[1:], strict=False))


def test_real_word_realignment_preserves_complete_recognized_text(
    real_adapter: FasterWhisperAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = ROOT / "tests/fixtures/asr/en-alignment.wav"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    source = AudioIdentity(
        "commons-148215183",
        "793bade8dea8492b56d266f1d6fb2997f1c936cb01c0ff5c65fe449bbe59f0f1",
        "fixture-alignment",
        digest,
        615428000,
        480000000,
        540000000,
    )
    # The second owned core uses original source 502s..530s and reproduces
    # native zero-length lexical alignment. Preserve it using genuine PCM.
    original = real_adapter._aligned_chunk
    complete_text: list[str] = []

    def observed(segments: Any, audio: Any, language: str, check: Any = None) -> Any:
        words = original(segments, audio, language, check)
        expected = "".join(segment.text for segment in segments).strip()
        assert "".join(word.word for word in words).strip() == expected
        complete_text.append(expected)
        return words

    monkeypatch.setattr(real_adapter, "_aligned_chunk", observed)
    result = real_adapter.transcribe(str(path), source)
    assert len(result.words) > 70
    assert all(480000000 <= w.start_us < w.end_us <= 540000000 for w in result.words)
    # Native punctuation can differ across CPU backends; it is not hand-labelled
    # reference text. Require the real lexical word and, above, byte-exact
    # preservation of EVERY recognized word/punctuation in every alignment.
    assert any(w.text.strip().rstrip(",.;:!?").casefold() == "example" for w in result.words)
    assert complete_text
    assert all(a.end_us <= b.start_us for a, b in zip(result.words, result.words[1:], strict=False))


def test_cuda_initialization_failure_falls_back_to_real_cpu_int8_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = FasterWhisperAdapter._load

    def unavailable_cuda(self: FasterWhisperAdapter, device: str, compute_type: str) -> Any:
        if device == "cuda":
            raise RuntimeError("Controlled unavailable CUDA initialization")
        return original(self, device, compute_type)

    monkeypatch.setattr(FasterWhisperAdapter, "_load", unavailable_cuda)
    adapter = FasterWhisperAdapter(
        AsrSettings(
            model="tiny",
            model_root=ROOT / ".local/asr-models",
            device="cuda",
            compute_type="float16",
            cpu_fallback=True,
        )
    )
    assert (adapter.device, adapter.compute_type) == ("cpu", "int8")
    path = ROOT / "tests/fixtures/asr/en.wav"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    result = adapter.transcribe(
        str(path), AudioIdentity("fixture", digest, "fixture-asr", digest, 8000000, 0, 8000000)
    )
    assert result.language == "en" and result.words
    assert adapter.parameters()["effectiveDevice"] == "cpu"
    assert adapter.parameters()["effectiveComputeType"] == "int8"
