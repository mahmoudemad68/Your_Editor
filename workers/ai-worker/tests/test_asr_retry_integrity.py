"""Portable retry-evidence contracts; synthetic inputs are not ASR qualification."""

from __future__ import annotations

import ast
import unicodedata
import unittest
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from editagent_ai_worker.domain.analysis.transcription import TranscriptionError

SOURCE = (
    Path(__file__).resolve().parents[1] / "src/editagent_ai_worker/infrastructure/faster_whisper.py"
)
NAMES = {
    "microseconds",
    "same_context_word",
    "verify_retry_word_coverage",
    "neighboring_language_prompt",
}
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
    "unicodedata": unicodedata,
}
body: list[ast.stmt] = list(functions)
exec(compile(ast.Module(body=body, type_ignores=[]), str(SOURCE), "exec"), namespace)
verify = namespace["verify_retry_word_coverage"]
language_prompt = namespace["neighboring_language_prompt"]


def word(text: str, start: float, end: float) -> Any:
    return SimpleNamespace(word=text, start=start, end=end, probability=0.9)


class RetryIntegrityTests(unittest.TestCase):
    def test_silent_cell_can_borrow_a_neighboring_prompt(self) -> None:
        self.assertEqual(language_prompt("ar", {}, {}), "ar")

    def test_weak_agreeing_language_evidence_is_preserved(self) -> None:
        probabilities = {"ar": 0.38, "en": 0.24, "es": 0.2}
        self.assertEqual(language_prompt("ar", probabilities, {}), "ar")
        self.assertEqual(probabilities, {"ar": 0.38, "en": 0.24, "es": 0.2})

    def test_conflicting_speech_cannot_be_forced_to_the_neighboring_language(self) -> None:
        for neighbor, probabilities in [
            ("en", {"ar": 0.38, "en": 0.24, "es": 0.2}),
            ("ar", {"en": 0.4, "ar": 0.3}),
            ("en", {"ar": 0.4}),
        ]:
            with self.subTest(neighbor=neighbor, probabilities=probabilities):
                with self.assertRaisesRegex(TranscriptionError, "trustworthy redetection"):
                    language_prompt(
                        neighbor,
                        probabilities,
                        {max(probabilities, key=lambda key: probabilities[key]): 0.6},
                    )

    def test_weak_or_disagreeing_corroboration_does_not_prove_a_language_switch(self) -> None:
        probabilities = {"ar": 0.38, "en": 0.24, "es": 0.2}
        for corroboration in [{}, {"ar": 0.49, "en": 0.4}, {"en": 0.9, "ar": 0.05}]:
            with self.subTest(corroboration=corroboration):
                self.assertEqual(language_prompt("en", probabilities, corroboration), "en")

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
        for original, retry in [
            (" kept", " replaced"),
            (" ß", " ss"),
            (" re-cover", " recover"),
            (" can't", " cant"),
        ]:
            with self.subTest(original=original, retry=retry):
                with self.assertRaisesRegex(TranscriptionError, "complete word coverage"):
                    verify([word(original, 1, 2)], [word(retry, 1, 2)], 5, 0, 0, 5_000_000)

    def test_boundary_punctuation_does_not_hide_an_existing_lexical_match(self) -> None:
        for original, retry in [
            (" retained,", " retained."),
            (' ( "retained" ) ', " retained!"),
            (" مرحبا،", " مرحبا؟"),
        ]:
            with self.subTest(original=original, retry=retry):
                before, after = [word(original, 1, 2)], [word(retry, 1, 2)]
                expected = [vars(before[0]).copy(), vars(after[0]).copy()]
                verify(before, after, 5, 0, 0, 5_000_000)
                self.assertEqual([vars(before[0]), vars(after[0])], expected)

    def test_punctuation_alone_is_not_missing_lexical_speech(self) -> None:
        verify([word(" . ", 1, 2)], [], 5, 0, 0, 5_000_000)

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
