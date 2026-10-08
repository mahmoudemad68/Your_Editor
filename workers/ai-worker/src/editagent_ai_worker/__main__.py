import sys

import structlog

from editagent_ai_worker.composition.bootstrap import bootstrap
from editagent_ai_worker.infrastructure.config import ConfigurationError, load_ai_worker_settings
from editagent_ai_worker.infrastructure.health_server import start_health_server
from editagent_ai_worker.infrastructure.lifecycle import keep_process_alive
from editagent_ai_worker.infrastructure.logging import configure_logging
from editagent_ai_worker.infrastructure.readiness import dependencies_ready
from editagent_ai_worker.infrastructure.tracing import start_noop_tracing


def main() -> None:
    try:
        settings = load_ai_worker_settings()
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
    start_noop_tracing("ai-worker")
    start_health_server(
        ready=lambda: dependencies_ready(str(settings.database_url), str(settings.redis_url)),
    )
    status = bootstrap()
    configure_logging()
    structlog.get_logger("ai-worker").info(
        "service.started", service="ai-worker", status=status["status"]
    )
    keep_process_alive()


if __name__ == "__main__":
    main()
