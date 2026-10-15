"""PostgreSQL job history for the Python queue consumer.

The TypeScript Job aggregate remains the domain model. This module writes the
same tables after the Python worker reserves a BullMQ job.
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

import psycopg


def uuid7() -> str:
    timestamp_ms = int(time.time() * 1000)
    entropy = secrets.token_bytes(10)
    raw = bytearray(16)
    raw[0] = (timestamp_ms >> 40) & 0xFF
    raw[1] = (timestamp_ms >> 32) & 0xFF
    raw[2] = (timestamp_ms >> 24) & 0xFF
    raw[3] = (timestamp_ms >> 16) & 0xFF
    raw[4] = (timestamp_ms >> 8) & 0xFF
    raw[5] = timestamp_ms & 0xFF
    raw[6] = 0x70 | (entropy[0] & 0x0F)
    raw[7] = entropy[1]
    raw[8] = 0x80 | (entropy[2] & 0x3F)
    raw[9:16] = entropy[3:10]
    text = raw.hex()
    return f"{text[0:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:32]}"


def _now_ms(floor: int) -> int:
    return max(int(time.time() * 1000), floor + 1)


class JobHistory:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def read_status(self, job_id: str) -> str | None:
        with psycopg.connect(
            self._database_url,
            connect_timeout=3,
            options="-c statement_timeout=3000 -c lock_timeout=3000",
        ) as connection:
            row = connection.execute("SELECT status FROM jobs WHERE id = %s", (job_id,)).fetchone()
        if row is None:
            return None
        return str(row[0])

    def validate_analysis(self, envelope: dict[str, Any]) -> int:
        with psycopg.connect(
            self._database_url, connect_timeout=3, options="-c statement_timeout=3000"
        ) as connection:
            row = connection.execute(
                "SELECT j.job_type,j.payload,j.subject_kind,j.subject_id,"
                "j.timeout_ms,j.max_attempts,t.deadline_at_ms "
                "FROM jobs j JOIN analysis_tasks t ON t.job_id=j.id WHERE j.id=%s",
                (envelope["jobId"],),
            ).fetchone()
            if row is None or (row[0], row[1], row[2], str(row[3]), row[4], row[5]) != (
                envelope["jobType"],
                envelope["payload"],
                envelope["subject"]["kind"],
                envelope["subject"]["id"],
                envelope["timeoutMs"],
                envelope["maxAttempts"],
            ):
                raise ValueError("Invalid durable analysis intent")
            return int(row[6])

    def begin(self, job_id: str, envelope: dict[str, Any] | None = None) -> tuple[str, int]:
        """Move Queued or Retrying work to Running. Recover a leftover Running row."""
        with psycopg.connect(
            self._database_url,
            connect_timeout=3,
            options="-c statement_timeout=3000 -c lock_timeout=3000",
        ) as connection:
            row = connection.execute(
                """
                SELECT status, attempt_count, max_attempts, updated_at
                FROM jobs WHERE id = %s FOR UPDATE
                """,
                (job_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"job {job_id} is not in Postgres")
            status, attempt_count, max_attempts, updated_at = row
            now = _now_ms(int(updated_at))
            if status == "Running":
                if int(attempt_count) >= int(max_attempts):
                    self._fail(
                        connection, job_id, now, "worker failed", envelope, int(attempt_count)
                    )
                    return ("exhausted", int(attempt_count))
                connection.execute(
                    """
                    UPDATE job_attempts
                    SET status = 'Retrying', finished_at = %s, reason = 'worker failed'
                    WHERE job_id = %s AND finished_at IS NULL
                    """,
                    (now, job_id),
                )
                connection.execute(
                    """
                    UPDATE jobs
                    SET status = 'Retrying', failure_reason = 'worker failed', updated_at = %s
                    WHERE id = %s
                    """,
                    (now, job_id),
                )
                now = now + 1
                status = "Retrying"
            if status not in {"Queued", "Retrying"}:
                raise RuntimeError(f"job {job_id} cannot start from {status}")
            started = connection.execute(
                """
                UPDATE jobs
                SET status = 'Running', attempt_count = attempt_count + 1,
                    failure_reason = NULL, updated_at = %s
                WHERE id = %s AND status IN ('Queued', 'Retrying')
                RETURNING attempt_count
                """,
                (now, job_id),
            ).fetchone()
            if started is None:
                raise RuntimeError(f"job {job_id} was not queued")
            attempt_number = int(started[0])
            connection.execute(
                """
                INSERT INTO job_attempts (
                  id, job_id, attempt_number, status, started_at, finished_at, reason
                ) VALUES (%s, %s, %s, 'Running', %s, NULL, NULL)
                """,
                (uuid7(), job_id, attempt_number, now),
            )
            return ("running", attempt_number)

    def cancel(self, job_id: str, expected_attempt: int | None = None) -> None:
        with psycopg.connect(
            self._database_url,
            connect_timeout=3,
            options="-c statement_timeout=3000 -c lock_timeout=3000",
        ) as connection:
            now = self._later_than_job(connection, job_id)
            changed = connection.execute(
                """
                UPDATE jobs
                SET status = 'Cancelled', updated_at = %s
                WHERE id = %s AND status = 'Running'
                  AND (%s::integer IS NULL OR attempt_count=%s)
                """,
                (now, job_id, expected_attempt, expected_attempt),
            )
            if changed.rowcount != 1:
                return
            connection.execute(
                """
                UPDATE job_attempts
                SET status = 'Cancelled', finished_at = %s, reason = 'cancelled'
                WHERE job_id = %s AND finished_at IS NULL
                """,
                (now, job_id),
            )

    def complete(self, job_id: str, expected_attempt: int | None = None) -> None:
        with psycopg.connect(
            self._database_url,
            connect_timeout=3,
            options="-c statement_timeout=3000 -c lock_timeout=3000",
        ) as connection:
            now = self._later_than_job(connection, job_id)
            changed = connection.execute(
                """
                UPDATE jobs
                SET status = 'Completed', failure_reason = NULL, updated_at = %s
                WHERE id = %s AND status = 'Running'
                  AND (%s::integer IS NULL OR attempt_count=%s)
                """,
                (now, job_id, expected_attempt, expected_attempt),
            )
            if changed.rowcount != 1:
                return
            connection.execute(
                """
                UPDATE job_attempts
                SET status = 'Completed', finished_at = %s, reason = NULL
                WHERE job_id = %s AND finished_at IS NULL
                """,
                (now, job_id),
            )

    def retry(self, job_id: str, reason: str, expected_attempt: int | None = None) -> None:
        with psycopg.connect(
            self._database_url,
            connect_timeout=3,
            options="-c statement_timeout=3000 -c lock_timeout=3000",
        ) as connection:
            now = self._later_than_job(connection, job_id)
            changed = connection.execute(
                """
                UPDATE jobs
                SET status = 'Retrying', failure_reason = %s, updated_at = %s
                WHERE id = %s AND status = 'Running'
                  AND (%s::integer IS NULL OR attempt_count=%s)
                """,
                (reason, now, job_id, expected_attempt, expected_attempt),
            )
            if changed.rowcount != 1:
                return
            connection.execute(
                """
                UPDATE job_attempts
                SET status = 'Retrying', finished_at = %s, reason = %s
                WHERE job_id = %s AND finished_at IS NULL
                """,
                (now, reason, job_id),
            )

    def fail(
        self,
        job_id: str,
        reason: str,
        envelope: dict[str, Any],
        expected_attempt: int | None = None,
    ) -> None:
        with psycopg.connect(
            self._database_url,
            connect_timeout=3,
            options="-c statement_timeout=3000 -c lock_timeout=3000",
        ) as connection:
            now = self._later_than_job(connection, job_id)
            self._fail(connection, job_id, now, reason, envelope, expected_attempt)

    def _fail(
        self,
        connection: psycopg.Connection[tuple[Any, ...]],
        job_id: str,
        now: int,
        reason: str,
        envelope: dict[str, Any] | None,
        expected_attempt: int | None = None,
    ) -> None:
        changed = connection.execute(
            """
            UPDATE jobs
            SET status = 'Failed', failure_reason = %s, updated_at = %s
            WHERE id = %s AND status IN ('Running', 'Retrying', 'Queued')
              AND (%s::integer IS NULL OR attempt_count=%s)
            """,
            (reason, now, job_id, expected_attempt, expected_attempt),
        )
        if changed.rowcount != 1:
            return
        connection.execute(
            """
            UPDATE job_attempts
            SET status = 'Failed', finished_at = %s, reason = %s
            WHERE job_id = %s AND finished_at IS NULL
            """,
            (now, reason, job_id),
        )
        if envelope is not None:
            connection.execute(
                """
                INSERT INTO job_dead_letters (job_id, reason, envelope, created_at)
                VALUES (%s, %s, %s::jsonb, %s)
                ON CONFLICT (job_id) DO UPDATE
                  SET reason = EXCLUDED.reason, envelope = EXCLUDED.envelope
                """,
                (job_id, reason, json.dumps(envelope), now),
            )

    def _later_than_job(self, connection: psycopg.Connection[tuple[Any, ...]], job_id: str) -> int:
        row = connection.execute("SELECT updated_at FROM jobs WHERE id = %s", (job_id,)).fetchone()
        floor = int(row[0]) if row is not None else 0
        return _now_ms(floor)
