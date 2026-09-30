import os
import subprocess
import sys

import pytest

from editagent_ai_worker.infrastructure.config import ConfigurationError, load_ai_worker_settings

_REQUIRED = {
    "DATABASE_URL": "postgresql://editagent:editagent-dev-password@postgres:5432/editagent",
    "REDIS_URL": "redis://redis:6379/0",
    "S3_ENDPOINT": "http://minio:9000",
    "S3_BUCKET": "editagent",
    "S3_ACCESS_KEY_ID": "editagent",
    "S3_SECRET_ACCESS_KEY": "editagent-dev-secret",
    "S3_REGION": "us-east-1",
}

_CONFIG_ENV = (
    "DATABASE_URL",
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_REGION",
    "EDITAGENT_AI_DEVICE",
)


def _apply(monkeypatch: pytest.MonkeyPatch, values: dict[str, str]) -> None:
    for name in _CONFIG_ENV:
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)


def test_missing_database_url_fails_with_a_readable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    values = dict(_REQUIRED)
    del values["DATABASE_URL"]
    _apply(monkeypatch, values)

    with pytest.raises(ConfigurationError, match=r"DATABASE_URL is required") as caught:
        load_ai_worker_settings()

    message = str(caught.value)
    assert "AI worker configuration error" in message
    assert "postgresql://" in message


def test_invalid_database_url_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    _apply(monkeypatch, {**_REQUIRED, "DATABASE_URL": "http://postgres:5432/editagent"})

    with pytest.raises(ConfigurationError, match=r"DATABASE_URL"):
        load_ai_worker_settings()


def test_invalid_device_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    _apply(monkeypatch, {**_REQUIRED, "EDITAGENT_AI_DEVICE": "gpu"})

    with pytest.raises(ConfigurationError, match=r"EDITAGENT_AI_DEVICE"):
        load_ai_worker_settings()


def test_valid_settings_default_to_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    _apply(monkeypatch, _REQUIRED)

    settings = load_ai_worker_settings()

    assert str(settings.database_url).startswith("postgresql://")
    assert settings.editagent_ai_device == "cpu"
    assert settings.s3_bucket == "editagent"


def test_process_exits_when_database_url_is_absent() -> None:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "REDIS_URL": _REQUIRED["REDIS_URL"],
        "S3_ENDPOINT": _REQUIRED["S3_ENDPOINT"],
        "S3_BUCKET": _REQUIRED["S3_BUCKET"],
        "S3_ACCESS_KEY_ID": _REQUIRED["S3_ACCESS_KEY_ID"],
        "S3_SECRET_ACCESS_KEY": _REQUIRED["S3_SECRET_ACCESS_KEY"],
        "S3_REGION": _REQUIRED["S3_REGION"],
    }
    result = subprocess.run(
        [sys.executable, "-m", "editagent_ai_worker"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )

    assert result.returncode == 1
    assert "AI worker configuration error" in result.stderr
    assert "DATABASE_URL is required" in result.stderr
