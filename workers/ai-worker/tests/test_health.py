from editagent_ai_worker.composition.bootstrap import bootstrap
from editagent_ai_worker.infrastructure.clock import adapter_label


def test_health_status() -> None:
    assert bootstrap() == {"worker": "ai-worker", "status": "ok"}


def test_infrastructure_may_call_domain() -> None:
    assert adapter_label() == "ai-worker"
