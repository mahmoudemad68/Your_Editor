"""Deterministic checks for the US-105 benchmark. No model downloads."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import benchmark
import evaluate
import manifest
import metrics


def clip(
    clip_id: str, language: str, duration: float, **extra: object
) -> dict[str, object]:
    document = {
        "id": clip_id,
        "audio_path": f"audio/{clip_id}.wav",
        "language": language,
        "duration_seconds": duration,
        "source": "owner recording",
        "license": "owner-granted benchmark use",
        "transcript_path": f"transcripts/{clip_id}.txt",
    }
    document.update(extra)
    return document


class ManifestTests(unittest.TestCase):
    def test_duration_totals_and_minimum(self) -> None:
        document = {"clips": [clip("en", "english", 400), clip("ar", "arabic", 250)]}
        checked = manifest.validate_manifest(document)
        self.assertTrue(checked["ok"])
        self.assertEqual(checked["total_duration_seconds"], 650)
        self.assertEqual(checked["duration_by_language"], {"en": 400.0, "ar": 250.0})
        self.assertTrue(checked["meets_minimum_total"])

    def test_rejects_escape_and_duplicate_ids(self) -> None:
        document = {
            "clips": [
                clip("same", "en", 1, audio_path="../secret.wav"),
                clip("same", "en", 1),
            ]
        }
        checked = manifest.validate_manifest(document)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("escapes" in error for error in checked["errors"]))
        self.assertTrue(any("duplicate" in error for error in checked["errors"]))

    def test_rejects_unknown_language(self) -> None:
        checked = manifest.validate_manifest({"clips": [clip("x", "fr", 1)]})
        self.assertFalse(checked["ok"])


class MetricTests(unittest.TestCase):
    def test_real_time_factor_and_throughput(self) -> None:
        self.assertEqual(metrics.real_time_factor(600, 180), 0.3)
        self.assertEqual(metrics.throughput(600, 180), 600 / 180)
        self.assertIsNone(metrics.throughput(600, 0))

    def test_english_wer(self) -> None:
        scored = metrics.word_error_rate("the cat sat", "the cat", "en")
        self.assertEqual(scored["deletions"], 1)
        self.assertEqual(scored["substitutions"], 0)
        self.assertEqual(scored["insertions"], 0)
        self.assertAlmostEqual(scored["wer"], 1 / 3)

    def test_arabic_normalization_ignores_diacritics_and_alef_variants(self) -> None:
        reference = "أَنا"
        hypothesis = "انا"
        scored = metrics.word_error_rate(reference, hypothesis, "ar")
        self.assertEqual(scored["wer"], 0)

    def test_word_timestamp_median(self) -> None:
        reference = [
            {"word": "one", "start": 0.0, "end": 0.5},
            {"word": "two", "start": 0.5, "end": 1.0},
        ]
        hypothesis = [
            {"word": "one", "start": 0.2, "end": 0.6},
            {"word": "two", "start": 0.7, "end": 1.1},
        ]
        scored = metrics.word_timestamp_errors(reference, hypothesis, "en")
        self.assertEqual(scored["status"], "EVALUATED")
        self.assertEqual(scored["matched_words"], 2)
        self.assertAlmostEqual(scored["median_abs_start_error_seconds"], 0.2)
        self.assertIsNone(scored["reported_pass"])

    def test_missing_timestamp_reference_is_not_a_pass(self) -> None:
        scored = metrics.word_timestamp_errors([], [], "en")
        self.assertEqual(scored["status"], "INSUFFICIENT_REFERENCE")
        self.assertFalse(scored["reported_pass"])

    def test_vad_perfect_overlap(self) -> None:
        scored = metrics.vad_scores([(0.0, 1.0)], [(0.0, 1.0)])
        self.assertEqual(scored["status"], "EVALUATED")
        self.assertAlmostEqual(scored["precision"], 1)
        self.assertAlmostEqual(scored["recall"], 1)
        self.assertAlmostEqual(scored["f1"], 1)
        self.assertIsNone(scored["reported_pass"])

    def test_missing_vad_reference_is_not_a_pass(self) -> None:
        scored = metrics.vad_scores(None, [(0.0, 1.0)])
        self.assertEqual(scored["status"], "INSUFFICIENT_REFERENCE")
        self.assertFalse(scored["reported_pass"])
        self.assertIsNone(scored["f1"])

    def test_cp1_observation_does_not_close_the_formal_gate(self) -> None:
        passed = metrics.cp1_asr_observation(600, 180)
        failed = metrics.cp1_asr_observation(600, 181)
        short = metrics.cp1_asr_observation(599, 10)
        self.assertTrue(passed["observed_pass"])
        self.assertEqual(passed["formal_cp1"], "NOT_VERIFIED")
        self.assertFalse(failed["observed_pass"])
        self.assertIsNone(short["observed_pass"])


class PlanTests(unittest.TestCase):
    def test_cpu_float16_is_unsupported_and_absent_gpu_is_recorded(self) -> None:
        records = benchmark.build_plan_records(
            {"gpu_available": False, "cuda_float16": False, "cpu_float16": False},
            include_cpu=True,
            present_languages={"en", "ar"},
        )
        self.assertEqual(len(records), 24)
        float16_cpu = [
            record
            for record in records
            if record["device"] == "cpu" and record["compute_type"] == "float16"
        ]
        self.assertEqual({record["status"] for record in float16_cpu}, {"UNSUPPORTED"})
        self.assertIn("CPU", str(float16_cpu[0]["reason"]))
        cuda = [record for record in records if record["device"] == "cuda"]
        self.assertTrue(all(record["status"] == "UNSUPPORTED" for record in cuda))

    def test_budget_keeps_skipped_records(self) -> None:
        records = benchmark.build_plan_records(
            {"gpu_available": True, "cuda_float16": True},
            include_cpu=True,
            present_languages={"en", "ar"},
        )
        gated = benchmark.apply_execution_budget(
            records, budget_seconds=0, elapsed_seconds=0
        )
        ready = [record for record in gated if record["status"] == "READY"]
        exhausted = [
            record
            for record in gated
            if record["reason"] == "execution budget exhausted"
        ]
        self.assertEqual(ready, [])
        self.assertEqual(len(gated), len(records))
        self.assertGreater(len(exhausted), 0)

    def test_result_round_trip_and_fake_run_writes_every_plan_row(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(
                json.dumps({"clips": [clip("en-1", "en", 600)]}),
                encoding="utf-8",
            )
            output = root / "out"
            written = benchmark.run_benchmark(
                manifest_path,
                root,
                output,
                "abc123",
                include_cpu=False,
                repeats=1,
                warmup=0,
                probe={"gpu_available": True, "cuda_float16": True},
                transcribe=lambda _clip: {"text": "hello", "words": []},
            )
            self.assertEqual(len(written), 24)
            saved = list((output / "runs").glob("*.json"))
            self.assertEqual(len(saved), 24)
            loaded = json.loads(benchmark.serialize_result(written[0]))
            self.assertEqual(loaded["commit_sha"], "abc123")
            successes = [record for record in written if record["status"] == "SUCCESS"]
            self.assertEqual(len(successes), 6)
            self.assertEqual(
                successes[0]["cp1_observation"]["formal_cp1"], "NOT_VERIFIED"
            )


class QualityGateTests(unittest.TestCase):
    def test_fewer_than_three_alignments_is_not_a_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "audio").mkdir()
            (root / "transcripts").mkdir()
            (root / "audio" / "only.wav").write_bytes(b"")
            (root / "transcripts" / "only.txt").write_text("hello", encoding="utf-8")
            manifest_path = root / "manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "clips": [
                            clip(
                                "only",
                                "en",
                                600,
                                word_timestamps_path="align/only.json",
                            )
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (root / "align").mkdir()
            (root / "align" / "only.json").write_text(
                json.dumps({"words": [{"word": "hello", "start": 0, "end": 1}]}),
                encoding="utf-8",
            )
            hypotheses = root / "hypotheses"
            hypotheses.mkdir()
            (hypotheses / "only-cuda.json").write_text(
                json.dumps(
                    {
                        "text": "hello",
                        "words": [{"word": "hello", "start": 0.1, "end": 1.1}],
                    }
                ),
                encoding="utf-8",
            )
            report = evaluate.evaluate_manifest(manifest_path, root, hypotheses)
            self.assertEqual(
                report["word_timestamps"]["status"], "INSUFFICIENT_REFERENCE"
            )
            self.assertFalse(report["word_timestamps"]["reported_pass"])
            self.assertEqual(report["vad"]["status"], "INSUFFICIENT_REFERENCE")
            self.assertFalse(report["vad"]["reported_pass"])


class DocumentTests(unittest.TestCase):
    def test_asr_section_is_pending_and_rendering_cp1_is_unchanged(self) -> None:
        document = (
            Path(__file__).resolve().parents[4]
            / "docs"
            / "research"
            / "technology-evaluation.md"
        ).read_text(encoding="utf-8")
        self.assertIn("**CP1 rendering gate: NOT_VERIFIED.**", document)
        self.assertIn("139.644", document)
        self.assertIn("Observed ASR measurements: **PENDING**.", document)
        self.assertIn("Formal CP1 ASR status: **NOT_VERIFIED**.", document)


if __name__ == "__main__":
    unittest.main()
