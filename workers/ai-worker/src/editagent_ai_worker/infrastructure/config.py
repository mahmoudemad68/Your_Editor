"""Typed configuration for the AI worker.

The process entry point calls ``load_ai_worker_settings`` once. Domain and
application code do not read the environment.
"""

import os
import platform
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Literal

from pydantic import AnyHttpUrl, Field, PostgresDsn, RedisDsn, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigurationError(Exception):
    """Missing or invalid AI worker configuration."""


ASR_NATIVE_PROFILE = "onednn-avx2-strict-v4"
ASR_NATIVE_ENVIRONMENT = MappingProxyType(
    {
        "CT2_USE_MKL": "0",
        "CT2_PACKED_GEMM": "0",
        "CT2_FORCE_CPU_ISA": "AVX2",
        "ONEDNN_MAX_CPU_ISA": "AVX2",
        "DNNL_MAX_CPU_ISA": "AVX2",
        "ONEDNN_DEFAULT_FPMATH_MODE": "strict",
        "DNNL_DEFAULT_FPMATH_MODE": "strict",
        "MKL_DYNAMIC": "FALSE",
        "OMP_DYNAMIC": "FALSE",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "OMP_WAIT_POLICY": "PASSIVE",
        "GOMP_SPINCOUNT": "0",
    }
)
ASR_NATIVE_RESERVED_ENVIRONMENT = (
    "MKL_CBWR",
    "MKL_ENABLE_INSTRUCTIONS",
    "MKL_DEBUG_CPU_TYPE",
)


def require_asr_native_environment() -> None:
    """Reject an unrecorded CPU backend; callers configure before native import."""
    if any(os.environ.get(key) != value for key, value in ASR_NATIVE_ENVIRONMENT.items()):
        raise ConfigurationError("ASR native execution profile is not configured.")
    if any(key in os.environ for key in ASR_NATIVE_RESERVED_ENVIRONMENT):
        raise ConfigurationError("ASR native execution profile has unsupported dispatch overrides.")


def configure_asr_native_environment() -> None:
    """Pin CT2 and its separate convolution/GEMM dispatch before native import.

    CT2 otherwise chooses MKL versus oneDNN by CPU vendor. Its float32 CPU
    convolution uses oneDNN even when its GEMM uses MKL. Constraining only MKL
    leaves the encoder and CT2's own kernels independently dispatched. Select
    oneDNN on both Intel and AMD, cap both dispatchers at verified AVX2, and
    retain strict float32 math instead of hardware-dependent reduced precision.
    Its GNU OpenMP
    workers must block while idle instead of spending the job's CPU quota on
    busy waiting between native calls and original-PCM preprocessing.
    ISA selection in CT2
    alone does not constrain its BLAS backend. Never switch an already-imported
    native library into a profile its initialized state cannot establish.
    """
    if "ctranslate2" in sys.modules or "faster_whisper" in sys.modules:
        raise ConfigurationError(
            "ASR native runtime is already imported; this startup profile is not configured."
        )
    if platform.machine().lower() not in {"x86_64", "amd64"}:
        raise ConfigurationError("ASR CPU execution requires the supported x86-64 runtime.")
    try:
        with Path("/proc/cpuinfo").open(encoding="ascii") as stream:
            description = stream.read(65536)
        flags = next(
            line.partition(":")[2].split()
            for line in description.splitlines()
            if line.partition(":")[0].strip() == "flags"
        )
    except (OSError, UnicodeError, StopIteration) as exc:
        raise ConfigurationError("ASR CPU instruction support cannot be verified.") from exc
    if not {"avx2", "fma"}.issubset(flags):
        raise ConfigurationError("ASR CPU execution requires verified AVX2 and FMA support.")
    for key in ASR_NATIVE_RESERVED_ENVIRONMENT:
        os.environ.pop(key, None)
    os.environ.update(ASR_NATIVE_ENVIRONMENT)


def analysis_child_environment(workspace: str) -> dict[str, str]:
    """Internal supervisor-owned process configuration; never supplied by a job."""
    return {
        **{
            key: value
            for key, value in os.environ.items()
            if key not in ASR_NATIVE_RESERVED_ENVIRONMENT
        },
        **ASR_NATIVE_ENVIRONMENT,
        "EDITAGENT_ANALYSIS_TEMP": workspace,
    }


def analysis_workspace_root() -> Path:
    raw = os.environ.get("EDITAGENT_ANALYSIS_TEMP", "")
    value = Path(raw)
    if (
        not raw
        or "\0" in raw
        or not value.is_absolute()
        or not value.is_dir()
        or value.is_symlink()
    ):
        raise ConfigurationError("Invalid analysis child configuration.")
    return value


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
