import asyncio
import signal
import sys

import structlog
from pydantic import ValidationError

from editagent_ai_worker.composition.bootstrap import bootstrap
from editagent_ai_worker.domain.analysis.transcription import TranscriptionError
from editagent_ai_worker.domain.analysis.voice_activity import VadModelError
from editagent_ai_worker.infrastructure.analysis_workspace import recover_workspaces
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.asr_model import required_models, verify_asr_model
from editagent_ai_worker.infrastructure.config import (
    ConfigurationError,
    configure_asr_native_environment,
    load_ai_worker_settings,
)
from editagent_ai_worker.infrastructure.health_server import start_health_server
from editagent_ai_worker.infrastructure.lifecycle import READY_FILE_PATH
from editagent_ai_worker.infrastructure.logging import configure_logging
from editagent_ai_worker.infrastructure.readiness import dependencies_ready, storage_ready
from editagent_ai_worker.infrastructure.tracing import start_noop_tracing
from editagent_ai_worker.infrastructure.vad_config import load_vad_settings


def main() -> None:
    try:
        settings = load_ai_worker_settings()
        configure_asr_native_environment()
        # Reject missing deployment configuration before importing native runtimes.
        from editagent_ai_worker.composition.vad import build_voice_activity_detector

        recover_workspaces()
        _detector = build_voice_activity_detector(load_vad_settings())
        asr = AsrSettings()
        for model in required_models(asr.model):
            verify_asr_model(asr.model_root / model, model)
    except (ConfigurationError, VadModelError, TranscriptionError, ValidationError) as exc:
        print(
            str(exc)
            if isinstance(exc, ConfigurationError)
            else "AI worker configuration or model is invalid.",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
    start_noop_tracing("ai-worker")
    health = start_health_server(
        ready=lambda: (
            READY_FILE_PATH.is_file()
            and dependencies_ready(str(settings.database_url), str(settings.redis_url))
            and storage_ready(
                str(settings.s3_endpoint),
                settings.s3_region,
                settings.s3_bucket,
                settings.s3_access_key_id,
                settings.s3_secret_access_key,
            )
        ),
    )
    status = bootstrap()
    configure_logging()
    structlog.get_logger("ai-worker").info(
        "service.started", service="ai-worker", status=status["status"]
    )

    async def run() -> None:
        from editagent_ai_worker.composition.analysis_jobs import consume_analysis

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        READY_FILE_PATH.write_text("ok\n", encoding="utf-8")
        task = asyncio.create_task(
            consume_analysis(str(settings.redis_url), str(settings.database_url), stop)
        )
        try:
            waiting = asyncio.create_task(stop.wait())
            await asyncio.wait({task, waiting}, return_when=asyncio.FIRST_COMPLETED)
            waiting.cancel()
            if task.done():
                await task
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            READY_FILE_PATH.unlink(missing_ok=True)
            health.shutdown()
            health.server_close()

    asyncio.run(run())


if __name__ == "__main__":
    main()
