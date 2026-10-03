"""Dependency checks for the AI worker /ready endpoint.

Each Postgres and Redis command must finish within one second. A paused or
silent server makes /ready return 503 inside that deadline. /health does not
call this module.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

READY_DEADLINE_SECONDS = 1


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
