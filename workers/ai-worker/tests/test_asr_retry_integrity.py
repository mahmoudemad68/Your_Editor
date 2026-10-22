"""Portable retry-evidence contracts; synthetic inputs are not ASR qualification."""

from __future__ import annotations

import ast
import unittest
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from editagent_ai_worker.domain.analysis.transcription import TranscriptionError

SOURCE = (
    Path(__file__).resolve().parents[1] / "src/editagent_ai_worker/infrastructure/faster_whisper.py"
)
NAMES = {"microseconds", "same_context_word", "verify_retry_word_coverage"}
functions = [
    node
    for node in ast.parse(SOURCE.read_text(encoding="utf-8")).body
    if isinstance(node, ast.FunctionDef) and node.name in NAMES
]
assert {node.name for node in functions} == NAMES
namespace: dict[str, Any] = {
    "Decimal": Decimal,
    "ROUND_HALF_UP": ROUND_HALF_UP,
    "Any": Any,
    "TranscriptionError": TranscriptionError,
}
body: list[ast.stmt] = list(functions)
exec(compile(ast.Module(body=body, type_ignores=[]), str(SOURCE), "exec"), namespace)
verify = namespace["verify_retry_word_coverage"]


def word(text: str, start: float, end: float) -> Any:
    return SimpleNamespace(word=text, start=start, end=end, probability=0.9)


class RetryIntegrityTests(unittest.TestCase):
    def test_native_overlap_keeps_both_hypotheses_unchanged(self) -> None:
        original = [word(" Retained", 1, 1.5), word(" recovery", 2, 2)]
        retry = [word(" retained", 1.1, 1.6), word(" recovery", 2, 2.5)]
        before = [[vars(w).copy() for w in words] for words in (original, retry)]
        verify(original, retry, 5, 0, 0, 5_000_000)
        self.assertEqual([[vars(w) for w in words] for words in (original, retry)], before)

    def test_a_second_native_occurrence_cannot_match_the_first_twice(self) -> None:
        original = [word(" again", 1, 1.5), word(" again", 2, 2.5)]
        with self.assertRaisesRegex(TranscriptionError, "complete word coverage"):
            verify(original, [word(" again", 1, 2.5)], 5, 0, 0, 5_000_000)

    def test_same_text_without_temporal_overlap_does_not_prove_preservation(self) -> None:
        for start, end in [(0.1, 0.5), (1.5, 2), (1.2, 1.2)]:
            with self.subTest(start=start, end=end):
                with self.assertRaisesRegex(TranscriptionError, "complete word coverage"):
                    verify([word(" kept", 1, 1.5)], [word(" kept", start, end)], 5, 0, 0, 5_000_000)

    def test_source_sample_offset_and_half_open_core_select_the_correct_owner(self) -> None:
        original = [word(" owned", 1, 2)]
        # Original midpoint is source 2.5s after adding the exact 16000-sample offset.
        verify(original, [], 5, 16000, 0, 2_500_000)
        with self.assertRaisesRegex(TranscriptionError, "complete word coverage"):
            verify(original, [], 5, 16000, 2_500_000, 5_000_000)

    def test_only_genuine_positive_source_intervals_establish_timing_evidence(self) -> None:
        for start, end in [(1, 1), (-1, 1), (4, 6), (2, 1), (float("nan"), 2)]:
            with self.subTest(start=start, end=end):
                verify([word(" unaligned", start, end)], [], 5, 0, 0, 5_000_000)

    def test_lexical_substitution_and_unicode_folding_are_rejected(self) -> None:
        for original, retry in [(" kept", " replaced"), (" ß", " ss"), (" word,", " word.")]:
            with self.subTest(original=original, retry=retry):
                with self.assertRaisesRegex(TranscriptionError, "complete word coverage"):
                    verify([word(original, 1, 2)], [word(retry, 1, 2)], 5, 0, 0, 5_000_000)

    def test_neighbouring_context_is_not_owned_by_this_core(self) -> None:
        verify(
            [word(" before", 0, 1), word(" owned", 2, 3), word(" after", 4, 5)],
            [word(" owned", 2, 3)],
            5,
            0,
            2_000_000,
            4_000_000,
        )


if __name__ == "__main__":
    unittest.main()
