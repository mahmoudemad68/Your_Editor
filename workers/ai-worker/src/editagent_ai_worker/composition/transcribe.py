"""Trusted staged WAV -> canonical transcript section; not an arbitrary-path public API."""

from __future__ import annotations

import argparse
import json
import resource
import sys
import time
from pathlib import Path

from editagent_ai_worker.contracts.media_analysis_generated import AnalyzerProvenance
from editagent_ai_worker.domain.analysis.transcription import TranscriptionError
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.config import (
    ConfigurationError,
    configure_asr_native_environment,
)
from editagent_ai_worker.infrastructure.transcript_schema import to_document as transcript_document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--identity", required=True, type=Path)
    args = parser.parse_args()
    started = time.monotonic()
    try:
        configure_asr_native_environment()
        from editagent_ai_worker.infrastructure.faster_whisper import FasterWhisperAdapter

        identity = AudioIdentity(**json.loads(args.identity.read_text()))
        adapter = FasterWhisperAdapter(AsrSettings())
        transcript = adapter.transcribe(str(args.audio), identity)
        data = transcript_document(transcript)
        provenance = AnalyzerProvenance.model_validate(adapter.provenance(identity)).model_dump(
            mode="json"
        )
        print(
            json.dumps(
                {
                    "section": {"status": "completed", "data": data, "provenance": provenance},
                    "wallTimeMs": round((time.monotonic() - started) * 1000, 3),
                    "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                    "inferenceParameters": adapter.parameters(),
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 0
    except (TranscriptionError, ConfigurationError, ValueError, OSError, TypeError) as error:
        print(
            json.dumps(
                {
                    "event": "asr.failed",
                    "reason": str(error)
                    if isinstance(error, TranscriptionError)
                    else "Canonical input or output validation failed",
                }
            ),
            file=sys.stderr,
        )
        print(json.dumps({"error": "Transcription input, model or output is invalid"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
