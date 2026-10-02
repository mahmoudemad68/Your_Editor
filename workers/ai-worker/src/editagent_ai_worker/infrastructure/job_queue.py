"""Python BullMQ consumer.

This is the official BullMQ Python client, which speaks the same Redis
scripts as the Node adapter. It stays in infrastructure. Domain code does
not import it. The shared JSON Schema is still packages/schemas.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any
from uuid import uuid4

import jsonschema
from bullmq import Worker  # type: ignore[import-untyped]
from bullmq.custom_errors import UnrecoverableError  # type: ignore[import-untyped]

from editagent_ai_worker.infrastructure.job_envelope import load_job_envelope_schema
from editagent_ai_worker.infrastructure.job_history import JobHistory


class QueueProtocolError(RuntimeError):
    """BullMQ rejected a reserve, acknowledgement, or lock renewal."""


async def _noop(_job: Any, _token: str) -> None:
    return None


class BullMqConsumer:
    def __init__(self, redis_url: str, database_url: str, queue_name: str, lock_ms: int) -> None:
        self._history = JobHistory(database_url)
        self._lock_ms = lock_ms
        self._worker = Worker(
            queue_name,
            _noop,
            {
                "connection": redis_url,
                "prefix": "bull",
                "autorun": False,
                "lockDuration": lock_ms,
                "lockRenewTime": max(50, lock_ms // 2),
                "stalledInterval": 200,
                "maxStalledCount": 5,
            },
        )

    async def close(self) -> None:
        await self._worker.close()

    async def probe(self) -> str | None:
        await self._sweep()
        token = uuid4().hex
        job = await self._worker.getNextJob(token)
        if job is None:
            return None
        await job.moveToFailed(UnrecoverableError("probe reserved a job"), token, False)
        raise QueueProtocolError(f"probe reserved {job.id}")

    async def consume_one(self) -> dict[str, Any]:
        await self._sweep()
        token = uuid4().hex
        job = await self._worker.getNextJob(token)
        if job is None:
            return {"result": "idle"}
        stop = asyncio.Event()
        renewal = asyncio.create_task(self._renew(str(job.id), token, stop))
        try:
            envelope = _envelope(job.data, int(getattr(job, "attemptsStarted", 0) or 0))
            started, _attempt_number = self._history.begin(str(job.id))
            if started == "exhausted":
                await job.moveToFailed(UnrecoverableError("worker failed"), token, False)
                return {"result": "failed", "jobId": str(job.id), "status": "Failed"}
            outcome = await _execute(envelope)
            if outcome == "complete":
                await job.moveToCompleted("completed", token, False)
                self._history.complete(str(job.id))
                return {"result": "completed", "jobId": str(job.id), "status": "Completed"}
            if outcome[0] == "retry":
                await job.moveToFailed(RuntimeError(outcome[1]), token, False)
                self._history.retry(str(job.id), outcome[1])
                return {"result": "retrying", "jobId": str(job.id), "status": "Retrying"}
            await job.moveToFailed(UnrecoverableError(outcome[1]), token, False)
            self._history.fail(str(job.id), outcome[1], envelope)
            return {"result": "failed", "jobId": str(job.id), "status": "Failed"}
        finally:
            stop.set()
            renewal.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await renewal

    async def _sweep(self) -> None:
        await self._worker.backend.moveStalledJobsToWait(
            self._worker.opts.get("maxStalledCount"),
            self._worker.opts.get("stalledInterval"),
        )

    async def _renew(self, job_id: str, token: str, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=max(0.05, self._lock_ms / 2000))
                return
            except TimeoutError:
                extended = await self._worker.backend.extendLock(job_id, token, self._lock_ms)
                if int(extended) != 1:
                    raise QueueProtocolError(f"lost lock for {job_id}") from None


def _envelope(data: Any, attempts_started: int) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise QueueProtocolError("BullMQ job data must be a JSON object")
    document = dict(data)
    stored_attempt = int(document.get("attempt", 1))
    document["attempt"] = attempts_started if attempts_started > 0 else stored_attempt
    jsonschema.validate(document, load_job_envelope_schema())
    return document


async def _execute(envelope: dict[str, Any]) -> str | tuple[str, str]:
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        return ("permanent", "job payload must be an object")
    mode = payload.get("mode", "ok")
    attempt = int(envelope.get("attempt", 1))
    max_attempts = int(envelope.get("maxAttempts", 1))
    if mode == "hold":
        delay_ms = int(payload.get("delayMs", 1000))
        await asyncio.sleep(delay_ms / 1000)
        marker = payload.get("markerPath")
        if isinstance(marker, str) and marker:
            with open(marker, "a", encoding="utf-8") as handle:
                handle.write(f"done {delay_ms}\n")
        return "complete"
    if mode == "transient" and attempt < max_attempts:
        return ("retry", "blip")
    if mode == "transient":
        return "complete"
    if mode == "permanent":
        return ("permanent", "disk corrupt")
    if mode == "ok":
        return "complete"
    return ("permanent", f"unknown payload mode {mode}")
