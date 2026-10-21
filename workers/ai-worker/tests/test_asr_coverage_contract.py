"""Portable coverage-logic regressions; these do not qualify native inference.

Compile the production coverage methods without importing CT2 or configuring a
native runtime. Decoder observations below are synthetic contract inputs, never
evaluation gold. Linux real-audio tests remain separate acceptance requirements.
"""

from __future__ import annotations

import ast
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from editagent_ai_worker.domain.analysis.transcription import TranscriptionError

SOURCE = (
    Path(__file__).resolve().parents[1] / "src/editagent_ai_worker/infrastructure/faster_whisper.py"
)


def coverage_adapter(segments: list[Any]) -> tuple[Any, list[int]]:
    module = ast.parse(SOURCE.read_text(encoding="utf-8"))
    adapter = next(
        node
        for node in module.body
        if isinstance(node, ast.ClassDef) and node.name == "FasterWhisperAdapter"
    )
    methods: list[ast.stmt] = [
        node
        for node in adapter.body
        if isinstance(node, ast.FunctionDef)
        and node.name in {"_unrepresented_words", "_coverage_evidence", "_verify_coverage"}
    ]
    assert len(methods) == 3
    adapter.body = methods
    isolated = ast.Module(body=[adapter], type_ignores=[])
    namespace: dict[str, Any] = {
        "Decimal": Decimal,
        "TranscriptionError": TranscriptionError,
        "uncovered_speech": lambda *_args: [(16_000, 32_000)],
    }
    exec(compile(isolated, str(SOURCE), "exec"), namespace)
    instance = namespace["FasterWhisperAdapter"]()
    calls: list[int] = []

    def transcribe(audio: Any, **kwargs: Any) -> Any:
        calls.append(len(audio))
        assert kwargs["language"] is None
        assert kwargs["vad_filter"] is False
        return iter(segments), SimpleNamespace(language="ar")

    instance.model = SimpleNamespace(transcribe=transcribe)
    instance.settings = SimpleNamespace(beam_size=5)
    instance._vad_options = lambda: None
    return instance, calls


def segment(words: list[Any], text: str = " مرحبا") -> Any:
    return SimpleNamespace(text=text, words=words, avg_logprob=-0.2, no_speech_prob=0.01)


def word(start: float, end: float, text: str = " مرحبا") -> Any:
    return SimpleNamespace(word=text, start=start, end=end, probability=0.9)


class CoverageContractTests(unittest.TestCase):
    def test_reliable_lexical_speech_without_word_alignment_cannot_be_certified(self) -> None:
        for text in (" hello", " مرحبا"):
            with self.subTest(text=text):
                adapter, calls = coverage_adapter([segment([], text)])
                with self.assertRaisesRegex(TranscriptionError, "complete word coverage"):
                    adapter._verify_coverage([0] * 64_000, [], lambda: None)
                self.assertEqual(calls, [48_000])

    def test_whole_native_word_crossing_either_gap_edge_remains_missing_evidence(self) -> None:
        for start, end in ((0.7, 1.1), (1.9, 2.3)):
            with self.subTest(start=start, end=end):
                observation = segment([word(start, end)])
                adapter, calls = coverage_adapter([observation])
                evidence = adapter._coverage_evidence([0] * 64_000, [], lambda: None)
                self.assertEqual(len(evidence), 1)
                self.assertIs(evidence[0][4], observation)
                self.assertEqual(calls, [48_000])
                self.assertEqual(
                    (observation.words[0].start, observation.words[0].end), (start, end)
                )

    def test_existing_lexical_and_temporal_match_does_not_create_missing_evidence(self) -> None:
        observation = segment([word(0.7, 1.1)])
        adapter, _ = coverage_adapter([observation])
        represented = [word(0.7, 1.1)]
        self.assertEqual(adapter._coverage_evidence([0] * 64_000, represented, lambda: None), [])

    def test_low_quality_or_non_speech_decode_is_not_reliable_missing_speech(self) -> None:
        for field, value in (("avg_logprob", -1.2), ("no_speech_prob", 0.8)):
            with self.subTest(field=field):
                observation = segment([])
                setattr(observation, field, value)
                adapter, _ = coverage_adapter([observation])
                self.assertEqual(adapter._coverage_evidence([0] * 64_000, [], lambda: None), [])

    def test_empty_decode_does_not_invent_lexical_evidence(self) -> None:
        adapter, _ = coverage_adapter([segment([], "")])
        self.assertEqual(adapter._coverage_evidence([0] * 64_000, [], lambda: None), [])

    def test_cancellation_precedes_the_independent_decode(self) -> None:
        adapter, calls = coverage_adapter([segment([word(1.1, 1.3)])])

        def cancelled() -> None:
            raise TranscriptionError("cancelled")

        with self.assertRaisesRegex(TranscriptionError, "cancelled"):
            adapter._coverage_evidence([0] * 64_000, [], cancelled)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
