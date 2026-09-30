"""Typed configuration for the AI worker.

The process entry point calls ``load_ai_worker_settings`` once. Domain and
application code do not read the environment.
"""

from typing import Literal

from pydantic import AnyHttpUrl, Field, PostgresDsn, RedisDsn, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigurationError(Exception):
    """Missing or invalid AI worker configuration."""


class AiWorkerSettings(BaseSettings):
    """Runtime settings loaded from the process environment."""

    model_config = SettingsConfigDict(extra="ignore", env_file=None, env_ignore_empty=True)

    database_url: PostgresDsn
    redis_url: RedisDsn
    s3_endpoint: AnyHttpUrl
    s3_bucket: str = Field(min_length=1)
    s3_access_key_id: str = Field(min_length=1)
    s3_secret_access_key: str = Field(min_length=1)
    s3_region: str = Field(min_length=1)
    editagent_ai_device: Literal["cpu", "cuda"] = "cpu"


_FIELD_ENV = {
    "database_url": "DATABASE_URL",
    "redis_url": "REDIS_URL",
    "s3_endpoint": "S3_ENDPOINT",
    "s3_bucket": "S3_BUCKET",
    "s3_access_key_id": "S3_ACCESS_KEY_ID",
    "s3_secret_access_key": "S3_SECRET_ACCESS_KEY",
    "s3_region": "S3_REGION",
    "editagent_ai_device": "EDITAGENT_AI_DEVICE",
}

_REQUIRED_HINTS = {
    "DATABASE_URL": (
        "DATABASE_URL is required. Set it to a postgresql:// connection URL. "
        "The AI worker cannot start without a database URL."
    ),
    "REDIS_URL": "REDIS_URL is required. Set it to a redis:// URL.",
    "S3_ENDPOINT": "S3_ENDPOINT is required. Set it to an http:// or https:// endpoint.",
    "S3_BUCKET": "S3_BUCKET is required. Set it to the development bucket name.",
    "S3_ACCESS_KEY_ID": "S3_ACCESS_KEY_ID is required.",
    "S3_SECRET_ACCESS_KEY": "S3_SECRET_ACCESS_KEY is required.",
    "S3_REGION": "S3_REGION is required.",
    "EDITAGENT_AI_DEVICE": "EDITAGENT_AI_DEVICE must be cpu or cuda.",
}


def _format_validation_error(exc: ValidationError) -> str:
    lines: list[str] = []
    for error in exc.errors():
        location = error.get("loc", ())
        field = str(location[0]) if location else "environment"
        env_name = _FIELD_ENV.get(field, field)
        message = str(error.get("msg", "invalid value"))
        if message == "Field required":
            message = _REQUIRED_HINTS.get(env_name, f"{env_name} is required.")
        elif env_name == "DATABASE_URL":
            message = f"DATABASE_URL must be a valid postgres:// or postgresql:// URL ({message})."
        elif env_name == "REDIS_URL":
            message = f"REDIS_URL must be a valid redis:// URL ({message})."
        elif env_name == "S3_ENDPOINT":
            message = f"S3_ENDPOINT must be a valid http:// or https:// URL ({message})."
        elif env_name == "EDITAGENT_AI_DEVICE":
            message = _REQUIRED_HINTS["EDITAGENT_AI_DEVICE"]
        lines.append(f"- {env_name}: {message}")
    detail = "\n".join(lines)
    return f"AI worker configuration error. Fix the environment and restart.\n{detail}"


def load_ai_worker_settings() -> AiWorkerSettings:
    """Parse process environment once and fail before the worker stays up."""
    try:
        return AiWorkerSettings()
    except ValidationError as exc:
        raise ConfigurationError(_format_validation_error(exc)) from exc
