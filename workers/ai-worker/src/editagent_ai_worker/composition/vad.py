"""Trusted local adapter entry point; not a browser API or another queue implementation."""

from __future__ import annotations

import argparse
import json
import resource
import statistics
import time
from pathlib import Path

from editagent_ai_worker.application.voice_activity import analyse_speech
from editagent_ai_worker.domain.analysis.overlap import OverlapMetrics, complement, overlap
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity, VadError
from editagent_ai_worker.infrastructure.silero_vad import SileroVadAdapter
from editagent_ai_worker.infrastructure.speech_schema import parse_document, to_document
from editagent_ai_worker.infrastructure.vad_audio import normalized_audio
from editagent_ai_worker.infrastructure.vad_config import VadSettings, load_vad_settings


def build_voice_activity_detector(settings: VadSettings) -> SileroVadAdapter:
    return SileroVadAdapter(settings.model_path, settings.timeout_ms)


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect speech in a verified local WAV artifact")
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--reference", type=Path)
    args = parser.parse_args()
    try:
        identity_data = json.loads(args.identity.read_text(encoding="utf-8"))
        identity = AudioIdentity(**identity_data)
        settings = load_vad_settings()
        started = time.monotonic()
        detector = build_voice_activity_detector(settings)
        with normalized_audio(
            args.audio, identity, ffmpeg=args.ffmpeg, timeout_ms=settings.timeout_ms
        ) as pcm:
            result = analyse_speech(detector, pcm, identity, settings.configuration())
        document = to_document(result)
        parse_document(document)
        scores = None
        if args.reference:
            gold = json.loads(args.reference.read_text(encoding="utf-8"))
            scope = (identity.scope_start_us, identity.scope_end_us)
            silence = [(int(r["startUs"]), int(r["endUs"])) for r in gold]
            speech = [(r.start_us, r.end_us) for r in result.regions]
            gold_speech = complement(silence, scope)

            def score(m: OverlapMetrics) -> dict[str, str | float]:
                return {
                    "tpUs": str(m.tp_us),
                    "fpUs": str(m.fp_us),
                    "fnUs": str(m.fn_us),
                    "precision": m.precision,
                    "recall": m.recall,
                    "f1": m.f1,
                }

            start_errors, end_errors = [], []
            for a, b in gold_speech:
                matched = [r for r in speech if min(b, r[1]) > max(a, r[0])]
                if matched:
                    best = max(matched, key=lambda r: min(b, r[1]) - max(a, r[0]))
                    start_errors.append(abs(a - best[0]))
                    end_errors.append(abs(b - best[1]))
            scores = {
                "speech": score(overlap(speech, gold_speech, scope)),
                "silence": score(overlap(complement(speech, scope), silence, scope)),
                "boundaryDiagnostics": {
                    "matchedGoldRegions": len(start_errors),
                    "goldRegions": len(gold_speech),
                    "medianOnsetErrorMs": statistics.median(start_errors) / 1000
                    if start_errors
                    else None,
                    "medianOffsetErrorMs": statistics.median(end_errors) / 1000
                    if end_errors
                    else None,
                    "matching": "maximum positive overlap per gold region; diagnostics only",
                },
            }
        print(
            json.dumps(
                {
                    "analysis": document,
                    "scores": scores,
                    "processingWallTimeMs": round((time.monotonic() - started) * 1000, 3),
                    "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 0
    except (VadError, ValueError, OSError, TypeError):
        print(json.dumps({"error": "Voice-activity input, model or configuration is invalid"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
