"""Isolated ASR handler: authorized durable subject -> bounded S3 staging -> receipt."""

from __future__ import annotations

import hashlib
import json
import os
import resource
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import boto3  # type: ignore[import-untyped]
import jsonschema
import psycopg
from botocore.config import Config  # type: ignore[import-untyped]
from botocore.exceptions import BotoCoreError, ClientError  # type: ignore[import-untyped]
from psycopg.types.json import Jsonb

from editagent_ai_worker.contracts.media_analysis_generated import AnalyzerProvenance, Failure
from editagent_ai_worker.contracts.media_analysis_generated import Transcript as TranscriptContract
from editagent_ai_worker.domain.analysis.transcription import (
    TranscriptionError,
    TranscriptionTimeout,
)
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity, VadTimeout
from editagent_ai_worker.infrastructure.analysis_events import emit_progress
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.config import (
    analysis_workspace_root,
    load_ai_worker_settings,
)
from editagent_ai_worker.infrastructure.faster_whisper import FasterWhisperAdapter


def detect_speech(
    path: Path, identity: AudioIdentity, parameters: dict[str, Any]
) -> dict[str, Any]:
    from editagent_ai_worker.composition.vad import build_voice_activity_detector
    from editagent_ai_worker.infrastructure.speech_schema import to_document
    from editagent_ai_worker.infrastructure.vad_audio import normalized_audio
    from editagent_ai_worker.infrastructure.vad_config import VadSettings, load_vad_settings

    settings = VadSettings.model_validate(
        {**parameters, "model_path": load_vad_settings().model_path}, strict=True
    )
    settings.configuration()
    detector = build_voice_activity_detector(settings)
    with normalized_audio(path, identity, timeout_ms=settings.timeout_ms) as pcm:
        result = detector.detect(pcm, identity, settings.configuration())
    provenance = {
        "analyzer": "silero-vad",
        "analyzerVersion": result.provenance.adapter_version,
        "sourceSha256": identity.source_sha256,
        "inputArtifactId": identity.artifact_id,
        "inputSha256": identity.audio_sha256,
        "runtime": result.provenance.runtime,
        "runtimeVersion": result.provenance.runtime_version,
        "configurationSha256": hashlib.sha256(
            json.dumps(settings.configuration().__dict__, sort_keys=True).encode()
        ).hexdigest(),
        "model": {
            "name": result.provenance.model_name,
            "version": result.provenance.model_version,
            "sha256": result.provenance.model_sha256,
        },
    }
    return {
        "status": "completed",
        "data": {"speech": to_document(result)},
        "provenance": provenance,
    }


def main() -> int:
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024**2, 512 * 1024**2))
    phase = "admission"
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("Invalid analysis envelope")
        envelope = json.loads(raw)
        schema = Path(__file__).resolve().parent.parent / "infrastructure/analysis-job.schema.json"
        if not schema.is_file():
            for parent in Path(__file__).resolve().parents:
                candidate = parent / "packages/schemas/src/analysis-job.schema.json"
                if candidate.is_file():
                    schema = candidate
                    break
        jsonschema.validate(envelope["payload"], json.loads(schema.read_text()))
        settings = load_ai_worker_settings()
        with psycopg.connect(
            str(settings.database_url),
            connect_timeout=5,
            options="-c statement_timeout=5000 -c lock_timeout=5000",
        ) as connection:
            row = connection.execute(
                """SELECT t.media_asset_id,t.input_artifact_id,t.configuration_sha256,
              a.source_sha256,d.content_sha256,d.storage_key,m.duration,t.result,t.deadline_at_ms,t.configuration,t.analyzer,t.generation
              FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id
              JOIN media_analyses a ON a.media_asset_id=t.media_asset_id
              JOIN media_assets m ON m.id=t.media_asset_id
              JOIN derived_assets d ON d.id=t.input_artifact_id
              JOIN projects p ON p.id=a.project_id WHERE j.id=%s AND j.status='Running'
              AND j.subject_id=t.media_asset_id AND j.job_type=%s AND j.attempt_count=%s
              AND p.deleted_at IS NULL
              AND m.content_sha256=a.source_sha256 AND m.validation_status='validated'
              AND d.media_asset_id=m.id AND d.project_id=a.project_id
              AND (t.initiated_by IS NULL OR EXISTS(SELECT 1 FROM project_memberships pm
                WHERE pm.project_id=a.project_id AND pm.user_id=t.initiated_by
                AND pm.role IN ('owner','editor')))
              AND NOT EXISTS(SELECT 1 FROM analysis_tasks n WHERE n.media_asset_id=t.media_asset_id
                AND n.analyzer=t.analyzer AND n.generation>t.generation)""",
                (envelope["jobId"], envelope["jobType"], envelope["attempt"]),
            ).fetchone()
            if row is None:
                raise ValueError("Analysis admission unavailable")
            (
                asset,
                artifact,
                configuration,
                source_hash,
                audio_hash,
                key,
                duration,
                result,
                deadline,
                configuration_parameters,
                analyzer,
                generation,
            ) = row
            p = envelope["payload"]
            if int(deadline) <= time.time() * 1000:
                raise TranscriptionTimeout("Analysis timed out.")
            if (
                envelope["subject"] != {"kind": "media-asset", "id": str(asset)}
                or p.get("mediaAssetId") != str(asset)
                or p.get("inputArtifactId") != str(artifact)
                or p.get("configurationSha256") != configuration
                or p.get("analyzer") != analyzer
                or p.get("generation") != generation
            ):
                raise ValueError("Analysis intent mismatch")
            if result is not None:
                return 0
            if not str(key).startswith("projects/") or ".." in str(key):
                raise ValueError("Invalid derivative identity")
            s3 = boto3.client(
                "s3",
                endpoint_url=str(settings.s3_endpoint),
                region_name=settings.s3_region,
                aws_access_key_id=settings.s3_access_key_id,
                aws_secret_access_key=settings.s3_secret_access_key,
                config=Config(
                    connect_timeout=3,
                    read_timeout=3,
                    retries={"max_attempts": 2},
                    s3={"addressing_style": "path"},
                ),
            )
            with tempfile.TemporaryDirectory(
                prefix="editagent-asr-", dir=analysis_workspace_root()
            ) as temporary:
                path = Path(temporary) / "audio.wav"
                phase = "staging"
                response = s3.get_object(Bucket=settings.s3_bucket, Key=key)
                size = int(response["ContentLength"])
                if not 0 < size <= 64 * 1024**2:
                    raise ValueError("Audio exceeds analysis staging bound")
                digest = hashlib.sha256()
                seen = 0
                body = response["Body"]
                try:
                    with path.open("xb") as output:
                        while block := body.read(65536):
                            seen += len(block)
                            if seen > size or time.time() * 1000 >= int(deadline):
                                raise ValueError("Audio admission expired")
                            digest.update(block)
                            output.write(block)
                finally:
                    body.close()
                    s3.close()
                if seen != size or digest.hexdigest() != audio_hash:
                    raise ValueError("Staged audio identity mismatch")
                identity = AudioIdentity(
                    str(asset),
                    source_hash,
                    str(artifact),
                    audio_hash,
                    int(duration),
                    0,
                    int(duration),
                )
                effective_parameters = {"deployment": configuration_parameters}
                phase = "inference"
                if envelope["jobType"] == "analysis.speech.v1":
                    section = detect_speech(path, identity, configuration_parameters["vad"])
                else:
                    deployment = AsrSettings()
                    adapter = FasterWhisperAdapter(
                        AsrSettings.model_validate(
                            {
                                **configuration_parameters["asr"],
                                "model_root": deployment.model_root,
                            },
                            strict=True,
                        )
                    )
                    if (
                        adapter.model_identity["version"]
                        != configuration_parameters["modelRevision"]
                    ):
                        raise ValueError("Analysis model identity mismatch")
                    print(
                        json.dumps(
                            {
                                "event": "analysis.inference.started",
                                "jobId": envelope["jobId"],
                                "pid": os.getpid(),
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    )
                    effective_parameters["asr"] = adapter.parameters()
                    transcript = adapter.transcribe(
                        str(path),
                        identity,
                        progress=lambda done, total: emit_progress(
                            str(settings.database_url),
                            str(settings.redis_url),
                            envelope["jobId"],
                            envelope["attempt"],
                            done * 100 // total,
                        ),
                    )
                    segments = []
                    for i, w in enumerate(transcript.words):
                        word = {
                            "text": w.text,
                            "startUs": str(w.start_us),
                            "endUs": str(w.end_us),
                            "confidence": w.confidence,
                        }
                        segments.append(
                            {
                                "id": f"word-{i}",
                                "text": w.text,
                                "startUs": str(w.start_us),
                                "endUs": str(w.end_us),
                                "confidence": w.confidence,
                                "words": [word],
                            }
                        )
                    data = TranscriptContract.model_validate(
                        {
                            "language": transcript.language,
                            "languageConfidence": transcript.language_confidence,
                            "segments": segments,
                        }
                    ).model_dump(mode="json")
                    provenance = AnalyzerProvenance.model_validate(
                        adapter.provenance(identity)
                    ).model_dump(mode="json")
                    section = {
                        "status": "completed",
                        "data": data,
                        "provenance": provenance,
                    }
                phase = "receipt"
                written = connection.execute(
                    "UPDATE analysis_tasks SET result=%s,inference_parameters=%s,result_attempt=%s "
                    "WHERE job_id=%s "
                    "AND result IS NULL RETURNING job_id",
                    (
                        Jsonb(section),
                        Jsonb(effective_parameters),
                        envelope["attempt"],
                        envelope["jobId"],
                    ),
                ).fetchone()
                if written is None:
                    raise ValueError("Analysis result fenced")
        print('{"result":"complete"}')
        return 0
    except Exception as error:
        print(
            json.dumps(
                {"event": "analysis.failed", "phase": phase, "exceptionType": type(error).__name__}
            ),
            file=sys.stderr,
        )
        retryable = isinstance(error, (BotoCoreError, psycopg.OperationalError))
        if isinstance(error, ClientError):
            retryable = (
                int(error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 400)) >= 500
            )
        code = (
            "unavailable"
            if retryable or isinstance(error, ClientError)
            else "timeout"
            if isinstance(error, (TranscriptionTimeout, VadTimeout))
            else "internal"
            if isinstance(error, TranscriptionError)
            else "invalid_input"
        )
        reason = {
            "unavailable": "Analyzer is unavailable.",
            "internal": "Analysis failed.",
            "timeout": "Analysis timed out.",
            "invalid_input": "Analysis input is invalid.",
        }[code]
        try:
            with psycopg.connect(str(settings.database_url), connect_timeout=1) as receipt:
                receipt.execute(
                    "UPDATE analysis_tasks SET failure=%s WHERE job_id=%s AND result IS NULL "
                    "AND deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint "
                    "AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=job_id AND j.status='Running' "
                    "AND j.attempt_count=%s)",
                    (
                        Jsonb(
                            Failure.model_validate(
                                {"code": code, "reason": reason, "retryable": retryable}
                            ).model_dump(mode="json")
                        ),
                        envelope["jobId"],
                        envelope["attempt"],
                    ),
                )
        except Exception:
            pass
        print(json.dumps({"error": reason, "mode": "retry" if retryable else "permanent"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
