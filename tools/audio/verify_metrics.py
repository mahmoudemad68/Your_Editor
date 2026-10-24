"""Independent endpoint-sweep score verification and read-only PCM characterization.

No JS scorer, ASR/VAD inference, threshold fitting, annotation edits, or human claims.
"""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import re
import sys
import wave
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


def score(
    predictions: list[dict[str, str]], gold: list[dict[str, str]]
) -> dict[str, Any]:
    """Integrate labelled occupancy across sorted endpoints, independent of JS range subtraction."""
    events: dict[int, list[int]] = {}
    for channel, ranges in enumerate((predictions, gold)):
        for item in ranges:
            if any(
                not re.fullmatch(r"0|[1-9][0-9]{0,19}", item[k])
                for k in ("startUs", "endUs")
            ):
                raise ValueError("Invalid interval")
            start, end = int(item["startUs"]), int(item["endUs"])
            if start >= end:
                raise ValueError("Empty or reversed interval")
            events.setdefault(start, [0, 0])[channel] += 1
            events.setdefault(end, [0, 0])[channel] -= 1
    occupied = [0, 0]
    previous = 0
    tp = fp = fn = 0
    for at, delta in sorted(events.items()):
        duration = at - previous
        if occupied[0] and occupied[1]:
            tp += duration
        elif occupied[0]:
            fp += duration
        elif occupied[1]:
            fn += duration
        occupied = [a + b for a, b in zip(occupied, delta, strict=True)]
        previous = at
    return {
        "tpUs": str(tp),
        "fpUs": str(fp),
        "fnUs": str(fn),
        "precision": tp / (tp + fp) if tp + fp else 1,
        "recall": tp / (tp + fn) if tp + fn else 1,
        "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 1,
    }


def assert_score(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    for key, value in actual.items():
        if value != expected[key]:
            raise ValueError(f"Independent score disagreement: {key}")


def read_json(path: Path) -> Any:
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Diagnostic JSON exceeds bound")
    return json.loads(path.read_bytes())


def verify(report: dict[str, Any], pcm_root: Path) -> dict[str, Any]:
    manifest = read_json(ROOT / "docs/evaluation/manifest.json")
    sources = {s["id"]: s for s in manifest["sources"]}
    expected_ids = {
        s["id"]
        for s in manifest["sources"]
        if any(a["type"] == "silence_labels" for a in s["referenceArtifacts"])
    }
    supplied_ids = [c["sourceId"] for c in report["original"]["clips"]]
    if len(supplied_ids) != len(expected_ids) or set(supplied_ids) != expected_ids:
        raise ValueError("Original benchmark clips are missing or duplicated")
    clips = []
    pooled_predictions: list[dict[str, str]] = []
    pooled_gold: list[dict[str, str]] = []
    # Separate disjoint coordinate spaces let the independent sweep pool exact duration counts.
    offset = 0
    for clip in report["original"]["clips"]:
        source = sources[clip["sourceId"]]
        if not re.fullmatch(r"[a-zA-Z0-9-]+", source["id"]):
            raise ValueError("Invalid source id")
        with (pcm_root / f"{source['id']}.{source['extension']}").open(
            "rb"
        ) as source_file:
            source_hash = hashlib.file_digest(source_file, "sha256").hexdigest()
        if (
            source_hash != source["sha256"]
            or source_hash != clip["identities"]["sourceSha256"]
        ):
            raise ValueError("Original source identity changed")
        artifact = next(
            a for a in source["referenceArtifacts"] if a["type"] == "silence_labels"
        )
        gold_path = ROOT / artifact["metadataPath"]
        gold_hash = hashlib.sha256(gold_path.read_bytes()).hexdigest()
        if (
            gold_hash != artifact["sha256"]
            or gold_hash != clip["identities"]["goldSha256"]
        ):
            raise ValueError("Original gold identity changed")
        gold = read_json(gold_path)
        pcm_path = pcm_root / f"{source['id']}-scoped-pcm.wav"
        pcm_hash = hashlib.sha256(pcm_path.read_bytes()).hexdigest()
        evidence = next(
            e for e in source["producerEvidence"] if e["type"] == "scoped_pcm"
        )
        if (
            pcm_hash != evidence["sha256"]
            or pcm_hash != clip["identities"]["scopedPcmSha256"]
        ):
            raise ValueError("Original scoped PCM identity changed")
        prediction = clip["analysis"]["data"]["silence"]
        measured = score(prediction, gold["intervals"])
        assert_score(measured, clip["scores"])
        word_artifact = next(
            a for a in source["referenceArtifacts"] if a["type"] == "word_alignment"
        )
        word_path = ROOT / word_artifact["metadataPath"]
        word_hash = hashlib.sha256(word_path.read_bytes()).hexdigest()
        if word_hash != word_artifact["sha256"]:
            raise ValueError("Original word gold identity changed")
        words = read_json(word_path)["words"]
        padded_words = [
            {
                "startUs": str(max(0, int(w["startUs"]) - 50000)),
                "endUs": str(min(int(source["durationUs"]), int(w["endUs"]) + 50000)),
            }
            for w in words
        ]
        for ranges, target in (
            (prediction, pooled_predictions),
            (gold["intervals"], pooled_gold),
        ):
            target.extend(
                {
                    "startUs": str(int(r["startUs"]) + offset),
                    "endUs": str(int(r["endUs"]) + offset),
                }
                for r in ranges
            )
        offset += int(source["durationUs"]) + 1
        with wave.open(str(pcm_path), "rb") as wav:
            if (
                wav.getnchannels() != 1
                or wav.getsampwidth() != 2
                or wav.getcomptype() != "NONE"
            ):
                raise ValueError("Characterization requires verified mono PCM16")
            rate = wav.getframerate()
            samples = array.array("h", wav.readframes(wav.getnframes()))
            if sys.byteorder != "little":
                samples.byteswap()
        intervals = []
        for r in gold["intervals"]:
            lower = int(r["startUs"]) - int(gold["scope"]["startUs"])
            upper = int(r["endUs"]) - int(gold["scope"]["startUs"])
            values = samples[
                (lower * rate + 999999) // 1000000 : upper * rate // 1000000
            ]
            if not values:
                raise ValueError("No original PCM in labelled interval")
            peak = max(abs(v) for v in values) / 32768
            rms = math.sqrt(sum(v * v for v in values) / len(values)) / 32768
            intervals.append(
                {
                    **r,
                    "durationUs": str(upper - lower),
                    "shorterThanProductionMinimum": upper - lower < 200000,
                    "peakDbfs": 20 * math.log10(peak) if peak else -200,
                    "rmsDbfs": 20 * math.log10(rms) if rms else -200,
                    "samplesAtOrAboveMinus60Dbfs": sum(
                        abs(v) >= 32.768 for v in values
                    ),
                    "sampleCount": len(values),
                }
            )
        clips.append(
            {
                "sourceId": source["id"],
                "sourceSha256": source_hash,
                "goldSha256": gold_hash,
                "scopedPcmSha256": pcm_hash,
                "scores": measured,
                "wordGoldSha256": word_hash,
                "wordGoldIsGeneratedNotIndependentHumanTruth": True,
                "predictedSilenceOverlappingWordsUs": score(prediction, words)["tpUs"],
                "predictedSilenceOverlappingPaddedWordsUs": score(
                    prediction, padded_words
                )["tpUs"],
                "nonSpeechGoldOverlappingWordsUs": score(gold["intervals"], words)[
                    "tpUs"
                ],
                "nonSpeechAmplitudeEvidence": intervals,
            }
        )
    pooled = score(pooled_predictions, pooled_gold)
    assert_score(pooled, report["original"])
    for clip in report["acoustic"]["clips"]:
        assert_score(score(clip["predictions"], clip["gold"]), clip)
    acoustic_total = {
        key: sum(int(c[key]) for c in report["acoustic"]["clips"])
        for key in ("tpUs", "fpUs", "fnUs")
    }
    for key, value in acoustic_total.items():
        if str(value) != report["acoustic"][key]:
            raise ValueError("Acoustic pooled counts disagree")
    return {
        "verifier": "independent Python endpoint sweep; no JS scorer",
        "original": pooled,
        "clips": clips,
        "acousticClipsVerified": len(report["acoustic"]["clips"]),
        "AMPLITUDE_IS_NOT_A_CONTENT_CLASS_LABEL": True,
        "CP2_STATUS": "NOT_MET",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--pcm-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(read_json(args.report), args.pcm_root), indent=2))


if __name__ == "__main__":
    main()
