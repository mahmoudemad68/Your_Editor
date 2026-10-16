"""Actual offline code switching and full-output reproducibility, not fabricated gold.

Composite fixtures are sample-exact adaptations of the licensed excerpts in
tests/fixtures/asr/manifest.json. Standalone/component equivalence measures lost
recognized content; it is not an independent human accuracy measurement.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any, Literal

import pytest

from editagent_ai_worker.domain.analysis.transcription import TranscriptionError
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.faster_whisper import FasterWhisperAdapter

ROOT = Path(__file__).resolve().parents[3]


def pcm(name: str) -> bytes:
    with wave.open(str(ROOT / "tests/fixtures/asr" / name), "rb") as stream:
        assert stream.getparams()[:3] == (1, 2, 16000)
        return stream.readframes(stream.getnframes())


def fixture(path: Path, samples: bytes) -> AudioIdentity:
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(samples)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    duration = len(samples) * 1_000_000 // 32000
    return AudioIdentity("composite", digest, "composite-asr", digest, duration, 0, duration)


def canonical(adapter: FasterWhisperAdapter, path: Path, source: AudioIdentity) -> dict[str, Any]:
    result = adapter.transcribe(str(path), source)
    return {
        "transcript": dataclasses.asdict(result),
        "provenance": adapter.provenance(source),
        "inferenceParameters": adapter.parameters(),
    }


def report(name: str, value: Any) -> None:
    directory = ROOT / ".local/asr-batch"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "fixture-attribution.json").write_text(
        (ROOT / "tests/fixtures/asr/manifest.json").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (directory / ("repair-" + name + ".json")).write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )


@pytest.mark.parametrize("threads", [1, 2])
def test_real_native_kernel_alignment_and_fresh_reused_state(threads: int) -> None:
    outputs = []
    environment = {
        **os.environ,
        "MKL_ENABLE_INSTRUCTIONS": "AVX2",
        "CT2_FORCE_CPU_ISA": "AVX2",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
    }
    # The supported x86 CPU branch reproduces zero-length real lexical tokens
    # on the old adapter. Every child performs fresh + post-EN/AR reused runs.
    for _ in range(2):
        run = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("asr_native_probe.py")), str(threads)],
            env=environment,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        assert run.returncode == 0, run.stderr
        outputs.append(json.loads(run.stdout))
        report(f"tiny-native-kernel-threads{threads}", outputs)
    assert outputs[0] == outputs[1]
    assert outputs[0]["completeNativeTextPreserved"] is True


@pytest.mark.parametrize("threads", [1, 2])
def test_real_coverage_drift_does_not_hide_missing_or_repeated_words(threads: int) -> None:
    import numpy as np

    from editagent_ai_worker.infrastructure.faster_whisper import uncovered_speech

    adapter = FasterWhisperAdapter(
        AsrSettings(model="small", model_root=ROOT / ".local/asr-models", cpu_threads=threads)
    )
    audio = np.frombuffer(pcm("en-coverage-boundary.wav"), dtype="<i2").astype(np.float32) / 32768
    try:
        segments, info = adapter._decode_window(audio, "en", lambda: None)
        words = adapter._aligned_chunk(segments, audio, info.language)
        gaps = uncovered_speech(audio, words, adapter._vad_options())
        assert words
        evidence = []
        for lower, upper in gaps:
            start, end = max(0, lower - 16000), min(len(audio), upper + 16000)
            verification, _ = adapter.model.transcribe(
                audio[start:end],
                language=None,
                word_timestamps=True,
                temperature=0.0,
                beam_size=adapter.settings.beam_size,
                condition_on_previous_text=False,
                vad_filter=False,
            )
            for segment in verification:
                for word in segment.words or []:
                    if lower <= start + (word.start + word.end) * 8000 < upper:
                        matches = [
                            w
                            for w in words
                            if w.word.strip() == word.word.strip()
                            and max(w.start, start / 16000 + word.start)
                            < min(w.end, start / 16000 + word.end)
                        ]
                        assert matches
                        evidence.append(word.word)
        if gaps:
            assert evidence, "Uncovered speech must have independent lexical evidence"
        adapter._verify_coverage(audio, words, lambda: None)
        adapter._verify_coverage(audio, words, lambda: None)
        # Removing actual recognized text is still an integrity failure. These
        # are model observations, never promoted to evaluation gold.
        if evidence:
            without = [w for w in words if w.word not in evidence]
            with pytest.raises(TranscriptionError, match="complete word coverage"):
                adapter._verify_coverage(audio, without, lambda: None)
        # Some supported CPU backends already cover this whole fixture. Do not
        # require a model to produce a gap. Always inject a real missing middle
        # third, retaining both outside word sequences, and independently decode
        # that original PCM. This negative path runs on every backend.
        left, right = len(words) // 3, 2 * len(words) // 3
        without = words[:left] + words[right:]
        assert 0 < left < right < len(words)
        assert uncovered_speech(audio, without, adapter._vad_options())
        with pytest.raises(TranscriptionError, match="complete word coverage"):
            adapter._verify_coverage(audio, without, lambda: None)
        report(
            f"small-coverage-drift-threads{threads}",
            {
                "words": [dataclasses.asdict(w) for w in words],
                "gaps": gaps,
                "existingWordsIndependentlyRedecoded": evidence,
                "provenance": adapter.parameters(),
                "removedWordsRejected": True,
                "removedMiddleWords": [w.word for w in words[left:right]],
            },
        )
    finally:
        adapter.model.model.unload_model()


@pytest.mark.parametrize("model", ["tiny", "small"])
@pytest.mark.parametrize("threads", [1, 2])
def test_real_multilingual_content_and_reused_process_determinism(
    tmp_path: Path, model: Literal["tiny", "small"], threads: int
) -> None:
    adapter = FasterWhisperAdapter(
        AsrSettings(model=model, model_root=ROOT / ".local/asr-models", cpu_threads=threads)
    )
    en, ar = pcm("en.wav"), pcm("ar.wav")
    cases = {
        "english": (en, [(0, 8, "latin")]),
        "arabic": (ar, [(0, 8, "arabic")]),
        "mixed-en-ar": (en + ar, [(0, 8, "latin"), (8, 16, "arabic")]),
        "codeswitch-boundary": (
            pcm("en-chunks.wav")[: 20 * 32000] + ar + en,
            [(0, 20, "latin"), (20, 28, "arabic"), (28, 36, "latin")],
        ),
        "repeated-phrases": (en + en, [(0, 8, "latin"), (8, 16, "latin")]),
    }
    components: dict[str, Any] = {}
    for name, (samples, ranges) in cases.items():
        path = tmp_path / (name + ".wav")
        source = fixture(path, samples)
        outputs = [canonical(adapter, path, source) for _ in range(3)]
        report(f"{model}-threads{threads}-{name}", outputs)
        assert outputs[0] == outputs[1] == outputs[2], (model, threads, name)
        words = outputs[0]["transcript"]["words"]
        if name in ("english", "arabic"):
            components[name] = words
        for lower, upper, script in ranges:
            owned = [
                word
                for word in words
                if lower * 2_000_000 <= word["start_us"] + word["end_us"] < upper * 2_000_000
            ]
            # These licensed excerpts contain substantial known speech. Script
            # checks reject translation/transliteration as well as empty tails.
            assert len(owned) >= (5 if script == "arabic" else 10), (model, threads, name)
            text = "".join(word["text"] for word in owned)
            if script == "arabic":
                assert sum("\u0600" <= c <= "\u06ff" for c in text) >= 15
            else:
                assert sum("a" <= c.lower() <= "z" for c in text) >= 25
            if name == "mixed-en-ar" or (name == "codeswitch-boundary" and lower > 0):
                # Complete real standalone recognition must survive composition
                # with another language: no missing, replaced or reordered words,
                # no changed probabilities, no invented/clipped boundaries.
                expected = components["arabic" if script == "arabic" else "english"]
                shifted = [
                    {
                        **word,
                        "start_us": word["start_us"] - lower * 1_000_000,
                        "end_us": word["end_us"] - lower * 1_000_000,
                    }
                    for word in owned
                ]
                assert shifted == list(expected), (model, threads, name, script)
        assert all(0 <= w["start_us"] < w["end_us"] <= source.duration_us for w in words)
        assert all(a["end_us"] <= b["start_us"] for a, b in zip(words, words[1:], strict=False))
    adapter.model.model.unload_model()


@pytest.mark.parametrize("threads", [1, 2])
@pytest.mark.parametrize("input_name", ["mixed", "english-long", "arabic-long"])
def test_real_fresh_process_canonical_output_includes_confidence_and_provenance(
    tmp_path: Path, threads: int, input_name: str
) -> None:
    path = tmp_path / "mixed.wav"
    source = fixture(
        path,
        pcm("en.wav") + pcm("ar.wav")
        if input_name == "mixed"
        else pcm("en-chunks.wav" if input_name == "english-long" else "ar-long.wav"),
    )
    identity = tmp_path / "identity.json"
    identity.write_text(json.dumps(dataclasses.asdict(source)))
    outputs: list[Any] = []
    for blas_threads in (1, 2, 1):
        run = subprocess.run(
            [
                sys.executable,
                "-m",
                "editagent_ai_worker.composition.transcribe",
                "--audio",
                str(path),
                "--identity",
                str(identity),
            ],
            env={
                **os.environ,
                "EDITAGENT_ASR_MODEL": "small",
                "EDITAGENT_ASR_MODEL_ROOT": str(ROOT / ".local/asr-models"),
                "EDITAGENT_ASR_CPU_THREADS": str(threads),
                "OPENBLAS_NUM_THREADS": str(blas_threads),
                "OMP_NUM_THREADS": str(threads),
            },
            check=False,
            capture_output=True,
            text=True,
            timeout=650,
        )
        if run.returncode != 0:
            report(
                f"small-fresh-threads{threads}-{input_name}",
                {"completedRuns": outputs, "exitCode": run.returncode, "diagnostic": run.stderr},
            )
        assert run.returncode == 0, run.stderr
        output = json.loads(run.stdout)
        outputs.append((output["section"], output["inferenceParameters"]))
        report(f"small-fresh-threads{threads}-{input_name}", outputs)
    assert outputs[0] == outputs[1] == outputs[2]


def fresh_for_cross_mode(
    path: Path, source: AudioIdentity, threads: int, chunk_us: int = 24_000_000
) -> dict[str, Any]:
    identity = path.with_suffix(".identity.json")
    identity.write_text(json.dumps(dataclasses.asdict(source)))
    run = subprocess.run(
        [
            sys.executable,
            "-m",
            "editagent_ai_worker.composition.transcribe",
            "--audio",
            str(path),
            "--identity",
            str(identity),
        ],
        env={
            **os.environ,
            "EDITAGENT_ASR_MODEL": "small",
            "EDITAGENT_ASR_MODEL_ROOT": str(ROOT / ".local/asr-models"),
            "EDITAGENT_ASR_CPU_THREADS": str(threads),
            "EDITAGENT_ASR_CHUNK_US": str(chunk_us),
            "OPENBLAS_NUM_THREADS": "1",
            "OMP_NUM_THREADS": str(threads),
        },
        check=False,
        capture_output=True,
        text=True,
        timeout=650,
    )
    assert run.returncode == 0, run.stderr
    result: dict[str, Any] = json.loads(run.stdout)
    return result


def assert_fresh_matches_reused(fresh: dict[str, Any], reused: dict[str, Any]) -> None:
    transcript = reused["transcript"]
    segments = []
    for index, word in enumerate(transcript["words"]):
        canonical_word = {
            "text": word["text"],
            "startUs": str(word["start_us"]),
            "endUs": str(word["end_us"]),
            "confidence": word["confidence"],
        }
        segments.append({"id": f"word-{index}", **canonical_word, "words": [canonical_word]})
    assert fresh["section"] == {
        "status": "completed",
        "provenance": reused["provenance"],
        "data": {
            "language": transcript["language"],
            "languageConfidence": transcript["language_confidence"],
            "segments": segments,
        },
    }
    assert fresh["inferenceParameters"] == reused["inferenceParameters"]


@pytest.mark.parametrize("threads", [1, 2])
def test_real_partial_context_uses_bounded_original_pcm_continuation(
    tmp_path: Path, threads: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "right-context.wav"
    copied = fixture(path, pcm("en-window-tail.wav"))
    source = AudioIdentity(
        "commons-148215183",
        "793bade8dea8492b56d266f1d6fb2997f1c936cb01c0ff5c65fe449bbe59f0f1",
        "fixture-right-context",
        copied.audio_sha256,
        615428000,
        190000000,
        220000000,
    )
    # The first 28 seconds are the EXACT original failing 190s..218s PCM.
    # A valid 26s core plus 2s overlap reproduces that window at fixture start.
    adapter = FasterWhisperAdapter(
        AsrSettings(
            model="small",
            model_root=ROOT / ".local/asr-models",
            cpu_threads=threads,
            chunk_us=26_000_000,
        )
    )
    original = adapter._aligned_chunk
    original_decode = adapter._decode_window
    decode_lengths = []
    continuation_expected = []

    def observed_decode(audio: Any, language: Any, check: Any) -> Any:
        decode_lengths.append(len(audio))
        decoded, info = original_decode(audio, language, check)
        if len(audio) == 448000:
            _, _, valid, right_edge = adapter._alignment_state(decoded, audio)
            continuation_expected.append(not valid and right_edge)
        return decoded, info

    def observed(segments: Any, audio: Any, language: str, check: Any = None) -> Any:
        words = original(segments, audio, language, check)
        assert "".join(w.word for w in words).strip() == "".join(s.text for s in segments).strip()
        return words

    # Observation only: actual decoder, VAD, PCM read and forced alignment run.
    monkeypatch.setattr(adapter, "_aligned_chunk", observed)
    monkeypatch.setattr(adapter, "_decode_window", observed_decode)
    try:
        outputs = [canonical(adapter, path, source) for _ in range(3)]
        report(f"small-right-continuation-threads{threads}", outputs)
        assert outputs[0] == outputs[1] == outputs[2]
        assert decode_lengths.count(448000) == 3
        assert len(continuation_expected) == 3
        assert continuation_expected == [continuation_expected[0]] * 3
        # Do not require a supported CPU backend to produce a native error.
        # The exact same source is extended once iff native evidence requires
        # it; a valid initial alignment must not trigger unnecessary decoding.
        assert decode_lengths.count(480000) == sum(continuation_expected)
        assert all(length <= 480000 for length in decode_lengths)
        report(
            f"small-right-continuation-decisions-threads{threads}",
            {"sampleCounts": decode_lengths, "continuationRequired": continuation_expected},
        )
        words = outputs[0]["transcript"]["words"]
        assert all(190_000_000 <= w["start_us"] < w["end_us"] <= 220_000_000 for w in words)
        # The clipped context's U.S. is only a model hypothesis, not gold.
        # Canonical ownership must retain EVERY word from independent inference
        # on the complete owning context, not force that earlier hypothesis in.
        owner_path = tmp_path / "owning-context.wav"
        owner_copy = fixture(owner_path, pcm("en-window-tail.wav")[-6 * 32000 :])
        owner_source = dataclasses.replace(
            source,
            artifact_id="fixture-owning-context",
            audio_sha256=owner_copy.audio_sha256,
            scope_start_us=214000000,
        )
        owner = canonical(adapter, owner_path, owner_source)
        report(f"small-independent-owner-context-threads{threads}", owner)
        # Compare the exact failing right-context region. Earlier join words can
        # legitimately use an overlapping neighbor's existing native alignment.
        expected = [w for w in owner["transcript"]["words"] if w["start_us"] >= 217_000_000]
        actual = [w for w in words if w["start_us"] >= 217_000_000]
        assert actual == expected and expected
        fresh = fresh_for_cross_mode(path, source, threads, chunk_us=26_000_000)
        report(f"small-right-continuation-fresh-threads{threads}", fresh)
        assert_fresh_matches_reused(fresh, outputs[0])
    finally:
        adapter.model.model.unload_model()


@pytest.mark.parametrize("threads", [1, 2])
def test_full_minute_languages_remain_identical_after_reusing_native_state(
    tmp_path: Path, threads: int
) -> None:
    adapter = FasterWhisperAdapter(
        AsrSettings(model="small", model_root=ROOT / ".local/asr-models", cpu_threads=threads)
    )
    inputs = {}
    for language, filename in [("en", "en-chunks.wav"), ("ar", "ar-long.wav")]:
        path = tmp_path / (language + ".wav")
        inputs[language] = (path, fixture(path, pcm(filename)))
    runs: dict[str, list[Any]] = {"en": [], "ar": []}
    try:
        for _ in range(3):
            for language, (path, source) in inputs.items():
                runs[language].append(canonical(adapter, path, source))
                report(f"small-reused-full-minute-threads{threads}", runs)
                assert runs[language][-1] == runs[language][0], (language, threads)

        for language, outputs in runs.items():
            assert outputs[0] == outputs[1] == outputs[2], (language, threads)
            assert len(outputs[0]["transcript"]["words"]) > 30
            if language == "ar":
                # The left overlapping context recognizes this word, but the
                # next core omits it. It must survive actual PCM reconciliation,
                # not merely produce the same incomplete result repeatedly.
                assert any(
                    w["text"].strip() == "المؤسسة"
                    and 44_000_000 < w["start_us"] < w["end_us"] < 51_000_000
                    for w in outputs[0]["transcript"]["words"]
                )
            path, source = inputs[language]
            fresh = fresh_for_cross_mode(path, source, threads)
            report(f"small-cross-mode-{language}-threads{threads}", fresh)
            assert_fresh_matches_reused(fresh, outputs[0])
    finally:
        adapter.model.model.unload_model()


@pytest.mark.parametrize("model", ["tiny", "small"])
def test_original_long_recording_opening_alignment_and_repeatability(
    tmp_path: Path, model: Literal["tiny", "small"]
) -> None:
    path = tmp_path / "original-opening.wav"
    source = fixture(path, pcm("en-long-opening.wav"))
    adapter = FasterWhisperAdapter(
        AsrSettings(model=model, model_root=ROOT / ".local/asr-models", cpu_threads=2)
    )
    try:
        outputs = [canonical(adapter, path, source) for _ in range(3)]
        report(f"{model}-original-opening", outputs)
        assert outputs[0] == outputs[1] == outputs[2]
        words = outputs[0]["transcript"]["words"]
        assert len(words) > 35
        text = "".join(word["text"] for word in words).casefold()
        assert "hello" in text and "references" in text and "information" in text
        assert words[-1]["end_us"] > 25_000_000
        assert all(0 <= w["start_us"] < w["end_us"] <= 26_000_000 for w in words)
    finally:
        adapter.model.model.unload_model()


@pytest.mark.parametrize("model", ["tiny", "small"])
def test_real_ten_minute_repeated_source_does_not_drop_chunk_content(
    tmp_path: Path, model: Literal["tiny", "small"]
) -> None:
    # A real-media long-input CI regression, not a claim this composite is the
    # original 600s commons recording. That recording is evaluated separately.
    path = tmp_path / "ten-minutes-repeated.wav"
    source = fixture(path, pcm("en-chunks.wav") * 10)
    adapter = FasterWhisperAdapter(
        AsrSettings(model=model, model_root=ROOT / ".local/asr-models", cpu_threads=2)
    )
    try:
        result = adapter.transcribe(str(path), source)
        report(
            f"{model}-ten-minute-repeated",
            {"transcript": dataclasses.asdict(result), "provenance": adapter.provenance(source)},
        )
        assert len(result.words) > 600
        assert result.words[-1].end_us > 590_000_000
        for minute in range(10):
            assert (
                sum(
                    minute * 60_000_000 <= word.start_us < (minute + 1) * 60_000_000
                    for word in result.words
                )
                > 30
            )
    finally:
        adapter.model.model.unload_model()
