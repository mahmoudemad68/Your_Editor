"""Consume one BullMQ job and persist the Job row."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from editagent_ai_worker.infrastructure.job_queue import BullMqConsumer


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) not in {4, 5}:
        print(
            "usage: consume_job REDIS_URL DATABASE_URL QUEUE_NAME consume|probe [LOCK_MS]",
            file=sys.stderr,
        )
        return 2
    redis_url, database_url, queue_name, action = args[:4]
    lock_ms = 5000 if len(args) == 4 else int(args[4])
    try:
        result = asyncio.run(_run(redis_url, database_url, queue_name, action, lock_ms))
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result))
    if result.get("result") == "idle" and action == "consume":
        return 3
    return 0


async def _run(
    redis_url: str,
    database_url: str,
    queue_name: str,
    action: str,
    lock_ms: int,
) -> dict[str, Any]:
    consumer = BullMqConsumer(redis_url, database_url, queue_name, lock_ms)
    try:
        if action == "probe":
            job_id = await consumer.probe()
            if job_id is None:
                return {"result": "idle"}
            return {"result": "reserved", "jobId": job_id}
        if action == "consume":
            return await consumer.consume_one()
        raise RuntimeError(f"unknown action {action}")
    finally:
        await consumer.close()


if __name__ == "__main__":
    raise SystemExit(main())
