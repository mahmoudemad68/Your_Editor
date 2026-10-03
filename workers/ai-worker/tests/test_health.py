import json
import urllib.error
import urllib.request

from editagent_ai_worker.composition.bootstrap import bootstrap
from editagent_ai_worker.infrastructure.clock import adapter_label
from editagent_ai_worker.infrastructure.health_server import (
    health_response,
    ready_response,
    start_health_server,
)


def test_health_status() -> None:
    assert bootstrap() == {"worker": "ai-worker", "status": "ok"}
    assert health_response() == (200, {"status": "ok"})
    assert ready_response(True) == (200, {"status": "ready"})
    assert ready_response(False) == (503, {"status": "not-ready"})


def test_ready_http_is_distinct_from_health() -> None:
    server = start_health_server(0, ready=lambda: False)
    port = server.server_address[1]
    try:
        health = urllib.request.urlopen(f"http://127.0.0.1:{port}/health")
        assert health.status == 200
        assert json.loads(health.read()) == {"status": "ok"}
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/ready")
            raise AssertionError("a failed dependency probe must not return 200")
        except urllib.error.HTTPError as exc:
            assert exc.code == 503
            assert json.loads(exc.read()) == {"status": "not-ready"}
    finally:
        server.shutdown()
        server.server_close()


def test_infrastructure_may_call_domain() -> None:
    assert adapter_label() == "ai-worker"
