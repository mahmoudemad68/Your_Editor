"""Dependency checks for the AI worker /ready endpoint."""

from __future__ import annotations


def dependencies_ready(database_url: str, redis_url: str) -> bool:
    try:
        import psycopg
        import redis

        with psycopg.connect(database_url, connect_timeout=2) as connection:
            connection.execute("SELECT 1")
        client = redis.Redis.from_url(redis_url, socket_connect_timeout=2)
        try:
            return bool(client.ping())
        finally:
            client.close()
    except Exception:
        return False
