"""JSON logs for the AI worker. Every job line carries the request correlation id."""

from __future__ import annotations

import json
from typing import Any

import structlog


def configure_logging() -> None:
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(20),
        cache_logger_on_first_use=False,
    )


def log_job(correlation_id: str, message: str, **fields: str) -> None:
    if correlation_id.strip() == "":
        raise ValueError("A log line requires a correlation ID.")
    configure_logging()
    structlog.get_logger("ai-worker").info(message, correlationId=correlation_id, **fields)


def run_logged_job(raw: str) -> None:
    parsed: Any = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Job payload must be a JSON object.")
    correlation_id = str(parsed.get("correlationId", "")).strip()
    job_type = str(parsed.get("jobType", "")).strip()
    subject_id = str(parsed.get("subjectId", "")).strip()
    if correlation_id == "" or job_type == "" or subject_id == "":
        raise ValueError("A job payload requires a correlation ID, job type, and subject.")
    log_job(correlation_id, "job.started", jobType=job_type, subjectId=subject_id)
    log_job(correlation_id, "job.finished", jobType=job_type, subjectId=subject_id)
