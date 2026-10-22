"""Portable bounded-language controls; synthetic probes are not speech gold."""

from __future__ import annotations

import ast
import unittest
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np

from editagent_ai_worker.domain.analysis.transcription import (
    TranscriptionCancelled,
    TranscriptionError,
    TranscriptionTimeout,
)

source = (
    Path(__file__).resolve().parents[1] / "src/editagent_ai_worker/infrastructure/faster_whisper.py"
)
tree = ast.parse(source.read_text(encoding="utf-8"))
adapter_class = next(
    n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "FasterWhisperAdapter"
)
methods = [
    n
    for n in adapter_class.body
    if isinstance(n, ast.FunctionDef)
    and n.name
    in {
        "_language_regions",
        "_refine_language_boundaries",
    }
]
namespace: dict[str, Any] = {
    "Any": Any,
    "Callable": Callable,
    "np": np,
    "TranscriptionError": TranscriptionError,
    "get_speech_timestamps": lambda audio, options: [{"start": 0, "end": len(audio)}],
}
exec(compile(ast.Module(body=[*methods], type_ignores=[]), str(source), "exec"), namespace)
Adapter = type("LanguageControls", (), {method.name: namespace[method.name] for method in methods})


class OriginalPcm:
    def __init__(self, seconds: int = 22) -> None:
        self.frames = seconds * 16000
        self.position = 0
        self.reads: list[tuple[int, int]] = []

    def getnframes(self) -> int:
        return self.frames

    def setpos(self, position: int) -> None:
        assert 0 <= position <= self.frames
        self.position = position

    def readframes(self, count: int) -> bytes:
        assert 0 < count <= 64000
        assert self.position + count <= self.frames
        self.reads.append((self.position, self.position + count))
        self.position += count
        return b"\0" * (2 * count)


def adapter_for(reader: OriginalPcm, unsupported: bool = False) -> Any:
    def detect(encoded: Any) -> Any:
        first, last = reader.reads[-1]
        bounds = (first // 16000, last // 16000)
        if bounds in {(6, 8), (12, 14)}:
            language, probability = "ar", 0.4
        elif bounds in {(8, 10), (10, 12), (6, 10), (10, 14)} and not unsupported:
            language, probability = "ar", 0.8
        else:
            language, probability = "en", 0.9
        return [[(f"<|{language}|>", probability)]]

    adapter = Adapter()
    adapter.model = SimpleNamespace(
        encode=lambda value: value,
        feature_extractor=lambda value: value,
        model=SimpleNamespace(detect_language=detect),
    )
    adapter.settings = SimpleNamespace(model="small")
    adapter._vad_options = lambda: None
    return adapter


class BoundedLanguageRecoveryTests(unittest.TestCase):
    def test_offgrid_boundary_uses_corroborated_original_pcm_and_complete_partition(self) -> None:
        reader = OriginalPcm()
        adapter = adapter_for(reader)
        regions = [
            (0, 8000000, "en", 0.9),
            (8000000, 12000000, "ar", 0.9),
            (12000000, 22000000, "en", 0.9),
        ]
        result = adapter._refine_language_boundaries(
            reader, 22000000, regions, adapter.model, lambda: None
        )
        self.assertEqual(
            [(a, b, language) for a, b, language, _ in result],
            [(0, 6000000, "en"), (6000000, 14000000, "ar"), (14000000, 22000000, "en")],
        )
        self.assertLessEqual(len(reader.reads), 3 * 6)
        self.assertEqual(len(reader.reads), len(set(reader.reads)))
        self.assertIn((6 * 16000, 10 * 16000), reader.reads)
        self.assertIn((10 * 16000, 14 * 16000), reader.reads)

    def test_unsupported_boundary_preference_cannot_publish_a_successful_plan(self) -> None:
        reader = OriginalPcm()
        adapter = adapter_for(reader, unsupported=True)
        with self.assertRaisesRegex(TranscriptionError, "trustworthy redetection"):
            adapter._refine_language_boundaries(
                reader,
                22000000,
                [(0, 8000000, "en", 0.9), (8000000, 22000000, "ar", 0.9)],
                adapter.model,
                lambda: None,
            )

    def test_same_language_does_not_add_encodes_or_change_plan(self) -> None:
        reader = OriginalPcm()
        adapter = adapter_for(reader)
        regions = [(0, 22000000, "ar", 0.9)]
        self.assertIs(
            adapter._refine_language_boundaries(
                reader, 22000000, regions, adapter.model, lambda: None
            ),
            regions,
        )
        self.assertEqual(reader.reads, [])

    def test_cancellation_or_deadline_stops_refinement_before_native_work(self) -> None:
        for error in [TranscriptionCancelled("cancelled"), TranscriptionTimeout("timeout")]:
            reader = OriginalPcm()
            adapter = adapter_for(reader)

            def check(error: TranscriptionError = error) -> None:
                raise error

            with self.assertRaises(type(error)):
                adapter._refine_language_boundaries(
                    reader,
                    22000000,
                    [(0, 8000000, "en", 0.9), (8000000, 22000000, "ar", 0.9)],
                    adapter.model,
                    check,
                )
            self.assertEqual(reader.reads, [])

    def test_tiny_uses_exactly_one_verified_fallback_plan_only_for_language_ambiguity(self) -> None:
        reader = OriginalPcm()
        adapter = adapter_for(reader)
        adapter.settings.model = "tiny"
        fallback = object()
        calls = []
        expected = [(0, 22000000, "ar", 0.9)]

        def planned(wav: Any, duration: int, check: Any, model: Any, *, refine: bool) -> Any:
            calls.append((model, refine))
            if len(calls) == 1:
                raise TranscriptionError("ASR language evidence requires trustworthy redetection")
            self.assertIs(model, fallback)
            return expected

        adapter._planned_language_regions = planned
        adapter._pinned_alignment_model = lambda check: fallback
        self.assertIs(adapter._language_regions(reader, 22000000, lambda: None), expected)
        self.assertEqual(calls, [(adapter.model, False), (fallback, True)])

    def test_unrelated_failure_and_cancellation_do_not_start_fallback(self) -> None:
        for error in [
            TranscriptionError("other failure"),
            TranscriptionCancelled("cancelled"),
            TranscriptionTimeout("timeout"),
        ]:
            reader = OriginalPcm()
            adapter = adapter_for(reader)
            adapter.settings.model = "tiny"

            def planned(*args: Any, error: TranscriptionError = error, **kwargs: Any) -> Any:
                raise error

            adapter._planned_language_regions = planned
            adapter._pinned_alignment_model = lambda check: self.fail("Unexpected fallback model")
            with self.assertRaises(type(error)):
                adapter._language_regions(reader, 22000000, lambda: None)


if __name__ == "__main__":
    unittest.main()
