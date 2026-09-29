from editagent_ai_worker.domain.health import worker_identity


def health_status() -> dict[str, str]:
    return {"worker": worker_identity(), "status": "ok"}
