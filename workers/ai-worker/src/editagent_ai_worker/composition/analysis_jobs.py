"""Production ASR queue composition; existing BullMQ leases and process-tree supervision."""

from __future__ import annotations

import asyncio

from editagent_ai_worker.infrastructure.job_queue import BullMqConsumer, run_analysis_handler


async def consume_analysis(redis_url: str, database_url: str, stop: asyncio.Event) -> None:
    consumers = [
        BullMqConsumer(
            redis_url, database_url, "media-analysis-v1-" + analyzer, 30000, run_analysis_handler
        )
        for analyzer in ("transcript", "speech")
    ]
    try:
        while not stop.is_set():
            try:
                results = [await consumer.consume_one() for consumer in consumers]
                if all(result.get("result") == "idle" for result in results):
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=0.2)
                    except TimeoutError:
                        pass
            except Exception:
                # Fixed safe failure; no connection string or adapter traceback escapes.
                await asyncio.sleep(0.2)
    finally:
        for consumer in consumers:
            await consumer.close()
