"""US-130 transport adapter: existing schema/channel/cursor, no private event protocol."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import jsonschema
import psycopg
import redis


def emit_progress(
    database_url: str, redis_url: str, job_id: str, attempt: int, percentage: int
) -> None:
    if (
        type(percentage) is not int
        or not 0 <= percentage <= 100
        or type(attempt) is not int
        or attempt < 1
    ):
        raise ValueError("Invalid progress")
    try:
        with psycopg.connect(
            database_url, connect_timeout=1, options="-c statement_timeout=250 -c lock_timeout=250"
        ) as c:
            locked = c.execute(
                "SELECT pg_try_advisory_lock(hashtextextended(%s,130))", (job_id,)
            ).fetchone()
            if not locked or not locked[0]:
                return
            try:
                row = c.execute(
                    """SELECT j.job_type,j.attempt_count,m.project_id,j.status,
                  j.event_progress_attempt,j.event_progress_percentage FROM jobs j
                  JOIN media_assets m ON m.id=j.subject_id WHERE j.id=%s AND j.attempt_count=%s""",
                    (job_id, attempt),
                ).fetchone()
                if row is None or row[3] != "Running" or (row[4] == row[1] and percentage < row[5]):
                    return
                sequence = c.execute(
                    """UPDATE jobs SET event_sequence=event_sequence+1,
                  event_progress_attempt=attempt_count,event_progress_percentage=%s
                  WHERE id=%s RETURNING event_sequence""",
                    (percentage, job_id),
                ).fetchone()
                if not sequence:
                    return
                event = {
                    "schemaVersion": 1,
                    "eventId": f"{job_id}:{sequence[0]}",
                    "jobId": job_id,
                    "jobType": row[0],
                    "projectId": str(row[2]),
                    "sequence": int(sequence[0]),
                    "attempt": int(row[1]),
                    "occurredAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "kind": "progress",
                    "percentage": percentage,
                    "stage": "asr",
                }
                schema = Path(__file__).with_name("job-event.schema.json")
                if not schema.exists():
                    for parent in Path(__file__).resolve().parents:
                        candidate = parent / "packages/schemas/src/job-event.schema.json"
                        if candidate.is_file():
                            schema = candidate
                            break
                jsonschema.validate(event, json.loads(schema.read_text()))
                c.commit()  # Cursor commits before Redis; outages leave gaps, never reused IDs.
                client = redis.Redis.from_url(
                    redis_url, socket_timeout=0.2, socket_connect_timeout=0.5
                )
                try:
                    client.publish("editagent:project-job-events:" + str(row[2]), json.dumps(event))
                finally:
                    client.close()
            finally:
                c.execute("SELECT pg_advisory_unlock(hashtextextended(%s,130))", (job_id,))
    except Exception:
        # Progress transport cannot change an authoritative inference outcome or leak errors.
        return
