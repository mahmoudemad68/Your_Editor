import json

from pytest import CaptureFixture

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
