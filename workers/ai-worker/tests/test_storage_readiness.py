import time
from threading import BoundedSemaphore, Event
from typing import Any

import pytest

from editagent_ai_worker.infrastructure import readiness


def probe() -> bool:
    return readiness.storage_ready(
        "http://storage.test", "test", "bucket", "test-key", "test-secret"
    )


def test_stalled_resolver_is_bounded_without_queued_threads_or_cached_success(
    monkeypatch: Any,
) -> None:
    release, closed = Event(), Event()
    slot = BoundedSemaphore(1)
    monkeypatch.setattr(readiness, "_STORAGE_PROBE_SLOT", slot)
    calls = []

    def stalled(*args: Any) -> bool:
        calls.append(1)
        try:
            assert release.wait(timeout=5)
            return True
        finally:
            closed.set()

    monkeypatch.setattr(readiness, "_storage_answers", stalled)
    started = time.monotonic()
    try:
        assert probe() is False
        assert 0.8 <= time.monotonic() - started < 1.5
        for _ in range(20):
            assert probe() is False
        assert calls == [1]
    finally:
        release.set()
        assert closed.wait(timeout=2)
        assert slot.acquire(timeout=2)
        slot.release()
    # Once the original probe settles, a fresh failure cannot reuse its late success.
    monkeypatch.setattr(readiness, "_storage_answers", lambda *args: False)
    assert probe() is False
    monkeypatch.setattr(readiness, "_storage_answers", lambda *args: True)
    assert probe() is True


@pytest.mark.parametrize("fail", [False, True])
def test_real_client_is_closed_and_request_limits_are_retained(
    monkeypatch: Any, fail: bool
) -> None:
    import boto3  # type: ignore[import-untyped]

    closed = []

    def client(*args: Any, **kwargs: Any) -> Any:
        config = kwargs["config"]
        assert config.connect_timeout == config.read_timeout == 1
        assert config.retries == {"max_attempts": 0}

        class Storage:
            def head_bucket(self, **values: Any) -> None:
                assert values == {"Bucket": "bucket"}
                if fail:
                    raise OSError("synthetic unavailable storage")

            def close(self) -> None:
                closed.append(True)

        return Storage()

    monkeypatch.setattr(boto3, "client", client)
    assert probe() is (not fail)
    assert closed == [True]
