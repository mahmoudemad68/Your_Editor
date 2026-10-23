"""Real cross-model process reuse on licensed public media; no diagnostic captures.

Only complete canonical outputs are compared. Nothing is emitted as annotations,
reference text, raw CI output or artifacts. The shared reporting hook protects
assertion operands if inference or equality fails.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import wave
from pathlib import Path

from faster_whisper.audio import decode_audio  # type: ignore[import-untyped]

from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.faster_whisper import FasterWhisperAdapter

ROOT = Path(__file__).resolve().parents[3]


def checked_fixture(name: str) -> Path:
    manifest = json.loads((ROOT / "tests/fixtures/asr/manifest.json").read_text())
    item = next(entry for entry in manifest["fixtures"] if entry["file"] == name)
    path = ROOT / "tests/fixtures/asr" / name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
    return path


def canonical_audio(source: Path, target: Path, copies: int = 1) -> AudioIdentity:
    audio = decode_audio(str(source), sampling_rate=16000)
    assert copies in (1, 10) and 0 < len(audio) * copies <= 600 * 16000
    frames = (audio * 32768).astype("<i2").tobytes() * copies
    with wave.open(str(target), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(frames)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    duration = len(frames) * 1_000_000 // 32000
    return AudioIdentity("public-fixture", digest, "fixture-pcm", digest, duration, 0, duration)


def tiny_output(path: Path, source: AudioIdentity) -> str:
    adapter = FasterWhisperAdapter(
        AsrSettings(model="tiny", model_root=ROOT / ".local/asr-models", cpu_threads=2)
    )
    try:
        result = adapter.transcribe(str(path), source)
        assert len(result.words) > 600 and result.words[-1].end_us > 590_000_000
        return json.dumps(
            {
                "transcript": dataclasses.asdict(result),
                "provenance": adapter.provenance(source),
                "configuration": adapter.parameters(),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    finally:
        adapter.close()


def test_cross_model_reuse_preserves_complete_original_transcript(tmp_path: Path) -> None:
    original = tmp_path / "original.wav"
    original_identity = canonical_audio(checked_fixture("en-original-ten-minute.flac"), original)
    before = tiny_output(original, original_identity)
    warm = FasterWhisperAdapter(
        AsrSettings(model="small", model_root=ROOT / ".local/asr-models", cpu_threads=2)
    )
    try:
        for name, copies in (("ar-long.wav", 1), ("en-chunks.wav", 10)):
            path = tmp_path / ("warm-" + name)
            identity = canonical_audio(checked_fixture(name), path, copies)
            result = warm.transcribe(str(path), identity)
            assert len(result.words) > 30
            assert result.words[-1].end_us > identity.duration_us - 10_000_000
    finally:
        warm.close()
    after = tiny_output(original, original_identity)
    assert before == after
