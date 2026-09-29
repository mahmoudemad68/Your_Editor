from editagent_ai_worker.domain.health import worker_identity


def adapter_label() -> str:
    """Legal infrastructure → domain dependency. No model runtime is loaded."""
    return worker_identity()
