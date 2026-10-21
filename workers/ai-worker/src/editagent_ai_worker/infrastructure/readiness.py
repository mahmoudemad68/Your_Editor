"""Dependency checks for the AI worker /ready endpoint.

Each Postgres and Redis command must finish within one second. A paused or
silent server makes /ready return 503 inside that deadline. /health does not
call this module.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import BoundedSemaphore, Event, Thread

READY_DEADLINE_SECONDS = 1
_STORAGE_PROBE_SLOT = BoundedSemaphore(1)


def dependencies_ready(database_url: str, redis_url: str) -> bool:
    try:
        if not _postgres_answers(database_url):
            return False
        return _redis_answers(redis_url)
    except Exception:
        return False


def _postgres_answers(database_url: str) -> bool:
    holder: dict[str, object] = {}
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_postgres_query, database_url, holder)
    try:
        future.result(timeout=READY_DEADLINE_SECONDS)
        return True
    except Exception:
        _close_quietly(holder.get("connection"))
        return False
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _postgres_query(database_url: str, holder: dict[str, object]) -> None:
    import psycopg

    with psycopg.connect(
        database_url,
        connect_timeout=READY_DEADLINE_SECONDS,
        autocommit=True,
    ) as connection:
        holder["connection"] = connection
        timeout_ms = str(READY_DEADLINE_SECONDS * 1000)
        connection.execute(
            "SELECT set_config('statement_timeout', %s, false)",
            (timeout_ms,),
        )
        connection.execute("SELECT 1")


def _redis_answers(redis_url: str) -> bool:
    import redis

    client = redis.Redis.from_url(
        redis_url,
        socket_connect_timeout=READY_DEADLINE_SECONDS,
        socket_timeout=READY_DEADLINE_SECONDS,
    )
    try:
        return bool(client.ping())
    finally:
        client.close()


def _close_quietly(connection: object) -> None:
    close = getattr(connection, "close", None)
    if close is None:
        return
    try:
        close()
    except Exception:
        return


def storage_ready(
    endpoint: str, region: str, bucket: str, access_key: str, secret_key: str
) -> bool:
    """Bound DNS/client setup too; one in-flight probe, no cached healthy result.

    Socket connect/read limits do not bound a stalled resolver. An unavailable
    probe cannot occupy the HTTP request past the existing readiness deadline,
    accumulate replacement threads, or prevent process shutdown.
    """
    if not _STORAGE_PROBE_SLOT.acquire(blocking=False):
        return False
    finished = Event()
    result = {"ready": False}

    def probe() -> None:
        try:
            result["ready"] = _storage_answers(endpoint, region, bucket, access_key, secret_key)
        except Exception:
            result["ready"] = False
        finally:
            _STORAGE_PROBE_SLOT.release()
            finished.set()

    thread = Thread(target=probe, name="s3-readiness", daemon=True)
    try:
        thread.start()
    except RuntimeError:
        _STORAGE_PROBE_SLOT.release()
        return False
    return finished.wait(timeout=READY_DEADLINE_SECONDS) and result["ready"]


def _storage_answers(
    endpoint: str, region: str, bucket: str, access_key: str, secret_key: str
) -> bool:
    """No mutation and no credential details in responses; always close the client."""
    import boto3  # type: ignore[import-untyped]
    from botocore.config import Config  # type: ignore[import-untyped]

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            connect_timeout=1,
            read_timeout=1,
            retries={"max_attempts": 0},
            s3={"addressing_style": "path"},
        ),
    )
    try:
        client.head_bucket(Bucket=bucket)
        return True
    except Exception:
        return False
    finally:
        client.close()
