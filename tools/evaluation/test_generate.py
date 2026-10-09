"""Synthetic conversion tests only; never generate or approve real human gold."""

import unittest

from generate import microseconds, silence_in_source, words_in_source


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.scope = {"startUs": "30000000", "endUs": "90000000"}

    def test_decimal_half_up(self):
        self.assertEqual(microseconds(0.0000005), 1)
        self.assertEqual(microseconds(1.25), 1250000)

    def test_arabic_source_coordinates(self):
        result, omitted = words_in_source(
            [{"text": " مرحباً،", "start": 1.25, "end": 1.5}], self.scope
        )
        self.assertEqual(
            result, [{"text": "مرحباً،", "startUs": "31250000", "endUs": "31500000"}]
        )
        self.assertFalse(omitted)

    def test_zero_duration_is_omitted_without_invention(self):
        result, omitted = words_in_source(
            [
                {"text": "a", "start": 0, "end": 1},
                {"text": "bad", "start": 2, "end": 2},
            ],
            self.scope,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(len(omitted), 1)

    def test_overlap_fails(self):
        with self.assertRaises(ValueError):
            words_in_source(
                [
                    {"text": "a", "start": 0, "end": 2},
                    {"text": "b", "start": 1, "end": 3},
                ],
                self.scope,
            )

    def test_sample_complement(self):
        self.assertEqual(
            silence_in_source([{"start": 16000, "end": 32000}], self.scope, 960000),
            [
                {"startUs": "30000000", "endUs": "31000000"},
                {"startUs": "32000000", "endUs": "90000000"},
            ],
        )

    def test_full_speech_has_no_invented_silence(self):
        self.assertEqual(
            silence_in_source([{"start": 0, "end": 960000}], self.scope, 960000), []
        )

    def test_invalid_duration_and_bounds(self):
        with self.assertRaises(ValueError):
            silence_in_source([], self.scope, 3)
        with self.assertRaises(ValueError):
            silence_in_source([{"start": 0, "end": 960001}], self.scope, 960000)
