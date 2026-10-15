"""Score saved ASR and VAD hypotheses against manifest references.

Missing references produce INSUFFICIENT_REFERENCE and reported_pass false.
This module does not download models.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from manifest import load_manifest, resolve_under, validate_manifest
from metrics import median, vad_scores, word_error_rate, word_timestamp_errors


def _read_json(path: Path) -> dict[str, object]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise TypeError(f"{path} must contain a JSON object")
    return document


def _intervals(document: dict[str, object]) -> list[tuple[float, float]]:
    raw = document.get("intervals")
    if not isinstance(raw, list):
        raise TypeError("intervals must be a list")
    intervals: list[tuple[float, float]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise TypeError("interval must be an object")
        intervals.append((float(item["start"]), float(item["end"])))
    return intervals


def _words(document: dict[str, object]) -> list[dict[str, float | str]]:
    raw = document.get("words")
    if not isinstance(raw, list):
        raise TypeError("words must be a list")
    words: list[dict[str, float | str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise TypeError("word must be an object")
        words.append(
            {
                "word": str(item["word"]),
                "start": float(item["start"]),
                "end": float(item["end"]),
            }
        )
    return words


def evaluate_manifest(
    manifest_path: Path,
    dataset_root: Path,
    hypothesis_dir: Path,
    vad_dir: Path | None = None,
) -> dict[str, object]:
    checked = validate_manifest(
        load_manifest(manifest_path), dataset_root, require_files=True
    )
    if not checked["ok"]:
        raise ValueError("manifest is invalid: " + "; ".join(checked["errors"]))
    clips_by_id = {str(clip["id"]): clip for clip in checked["clips"]}
    per_language: dict[str, dict[str, object]] = {}
    timestamp_groups: dict[str, list[float]] = {}
    timestamp_counts: dict[str, int] = {}
    vad_precision: list[float] = []
    vad_recall: list[float] = []
    vad_f1: list[float] = []
    vad_start: list[float] = []
    vad_end: list[float] = []
    vad_clips = 0
    for path in sorted(hypothesis_dir.glob("**/*.json")):
        hypothesis = _read_json(path)
        clip = clips_by_id.get(
            str(hypothesis.get("clip_id") or path.name.split("-")[0])
        )
        if clip is None:
            continue
        transcript_path = resolve_under(dataset_root, str(clip["transcript_path"]))
        reference_text = transcript_path.read_text(encoding="utf-8")
        scored = word_error_rate(
            reference_text, str(hypothesis.get("text", "")), str(clip["language"])
        )
        group = "{}|{}|{}|{}".format(
            hypothesis.get("model", "unspecified"),
            hypothesis.get("compute_type", "unspecified"),
            hypothesis.get("device", "unspecified"),
            clip["language"],
        )
        bucket = per_language.setdefault(group, {"wers": [], "clips": 0})
        if scored["wer"] is not None:
            bucket["wers"].append(scored["wer"])
            bucket["clips"] = int(bucket["clips"]) + 1
        word_path = clip.get("word_timestamps_path")
        if isinstance(word_path, str):
            reference_words = _words(_read_json(resolve_under(dataset_root, word_path)))
            hypothesis_words = hypothesis.get("words")
            if not isinstance(hypothesis_words, list):
                hypothesis_words = []
            timed = word_timestamp_errors(
                reference_words, hypothesis_words, str(clip["language"])
            )
            if (
                timed["status"] == "EVALUATED"
                and timed["median_abs_start_error_seconds"] is not None
            ):
                timestamp_counts[group] = timestamp_counts.get(group, 0) + 1
                timestamp_groups.setdefault(group, []).append(
                    float(timed["median_abs_start_error_seconds"])
                )
    for clip in checked["clips"]:
        vad_path = clip.get("speech_intervals_path")
        if isinstance(vad_path, str) and vad_dir is not None:
            reference_intervals = _intervals(
                _read_json(resolve_under(dataset_root, vad_path))
            )
            vad_file = vad_dir / f"{clip['id']}.json"
            predicted = _intervals(_read_json(vad_file)) if vad_file.is_file() else []
            scored_vad = vad_scores(reference_intervals, predicted)
            if scored_vad["status"] == "EVALUATED":
                vad_clips += 1
                vad_precision.append(float(scored_vad["precision"]))
                vad_recall.append(float(scored_vad["recall"]))
                vad_f1.append(float(scored_vad["f1"]))
                if scored_vad["median_abs_start_error_seconds"] is not None:
                    vad_start.append(
                        float(scored_vad["median_abs_start_error_seconds"])
                    )
                if scored_vad["median_abs_end_error_seconds"] is not None:
                    vad_end.append(float(scored_vad["median_abs_end_error_seconds"]))
    languages = {}
    for code, bucket in per_language.items():
        languages[code] = {
            "clips": bucket["clips"],
            "mean_wer": (sum(bucket["wers"]) / len(bucket["wers"]))
            if bucket["wers"]
            else None,
        }
    timestamp_clips = max(timestamp_counts.values(), default=0)
    timestamp_status = "EVALUATED" if timestamp_clips >= 3 else "INSUFFICIENT_REFERENCE"
    best_group = max(timestamp_counts, key=timestamp_counts.get, default="")
    vad_status = "EVALUATED" if vad_clips else "INSUFFICIENT_REFERENCE"
    return {
        "asr": {
            "status": "EVALUATED" if languages else "INSUFFICIENT_REFERENCE",
            "by_configuration": languages,
            "reported_pass": None if languages else False,
        },
        "word_timestamps": {
            "status": timestamp_status,
            "clips": timestamp_clips,
            "required_clips": 3,
            "median_abs_start_error_seconds": (
                median(timestamp_groups.get(best_group, []))
                if timestamp_clips >= 3
                else None
            ),
            "reported_pass": False
            if timestamp_status == "INSUFFICIENT_REFERENCE"
            else None,
        },
        "vad": {
            "status": vad_status,
            "clips": vad_clips,
            "precision": (sum(vad_precision) / len(vad_precision))
            if vad_status == "EVALUATED"
            else None,
            "recall": (sum(vad_recall) / len(vad_recall))
            if vad_status == "EVALUATED"
            else None,
            "f1": (sum(vad_f1) / len(vad_f1)) if vad_status == "EVALUATED" else None,
            "median_abs_start_error_seconds": median(vad_start)
            if vad_status == "EVALUATED"
            else None,
            "median_abs_end_error_seconds": median(vad_end)
            if vad_status == "EVALUATED"
            else None,
            "reported_pass": False if vad_status == "INSUFFICIENT_REFERENCE" else None,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score US-105 hypotheses against references"
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--hypotheses", type=Path, required=True)
    parser.add_argument("--vad", type=Path, default=None)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    report = evaluate_manifest(
        args.manifest, args.dataset_root, args.hypotheses, args.vad
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
