from editagent_ai_worker.application.health import health_status


def bootstrap() -> dict[str, str]:
    return health_status()
