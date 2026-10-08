import json

from pytest import CaptureFixture, MonkeyPatch

from editagent_ai_worker.infrastructure.logging import run_logged_job


def test_job_logs_repeat_the_request_correlation_id(capsys: CaptureFixture[str]) -> None:
    run_logged_job(
        json.dumps(
            {
                "correlationId": "web-request-1",
                "jobType": "media.inspect",
                "subjectId": "asset-1",
            }
        )
    )
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]
    assert len(lines) == 2
    assert {line["correlationId"] for line in lines} == {"web-request-1"}
    assert [line["event"] for line in lines] == ["job.started", "job.finished"]
    for line in lines:
        assert line["service"] == "ai-worker"
        assert "stack" not in line
        assert "Traceback" not in json.dumps(line)


def test_job_logs_reject_injection_and_omit_credentials(capsys: CaptureFixture[str]) -> None:
    import pytest

    from editagent_ai_worker.infrastructure.logging import log_job

    for value in ("ok\n", "\rok", "ok\x00", "ok\x1b", "x" * 129):
        with pytest.raises(ValueError):
            log_job(value, "job.failed")
    log_job(
        "safe-request",
        "job.failed",
        jobId="safe-job",
        password="PRIVATE_CANARY",
        authorization="Bearer PRIVATE_CANARY",
        url="X-Amz-Signature=PRIVATE_CANARY",
    )
    line = capsys.readouterr().out
    assert "PRIVATE_CANARY" not in line
    assert json.loads(line)["correlationId"] == "safe-request"


def test_tracing_idempotent_and_no_network_export(monkeypatch: MonkeyPatch) -> None:
    import socket

    from opentelemetry import trace

    from editagent_ai_worker.infrastructure.tracing import start_noop_tracing

    attempts: list[bool] = []

    def denied(*args: object, **kwargs: object) -> None:
        attempts.append(True)
        raise AssertionError("No-exporter tracing must not open a network connection")

    monkeypatch.setattr(socket, "create_connection", denied)
    start_noop_tracing("ai-worker")
    provider = trace.get_tracer_provider()
    start_noop_tracing("ai-worker")
    assert trace.get_tracer_provider() is provider
    with trace.get_tracer("test").start_as_current_span("no-export"):
        pass
    assert attempts == []
