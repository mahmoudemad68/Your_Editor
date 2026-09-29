# ADR-004 — Redis and BullMQ

- **Status:** Accepted
- **Date:** 2026-09-29
- **Accepted:** 2026-09-29
- **Acceptance vehicle:** PR #2
- **Approved by:** project team / product owner

## Context

Transcription, media preparation, rendering, and the agent loop are slow and must be retryable. The roadmap moves the job queue forward because later increments are asynchronous from their first version. Workers need a shared queue port so the three Node workers can be merged later without rewriting producers.

## Decision

- Redis is the broker.
- BullMQ is the Node client behind the `IJobQueue` port.
- The Python AI worker consumes the same Redis-backed queues through an adapter that implements the same job semantics. It does not import BullMQ.
- Application and domain code depend on `IJobQueue`, never on BullMQ or Redis types.
- Job payloads are JSON validated against `packages/schemas`.

The queue implementation, the job state machine, and the worker loops are US-129. This ADR does not add them.

## Rationale

BullMQ gives delayed jobs, retries, and backoff on Redis, which the platform already needs for progress fan-out. A port keeps that choice replaceable. One broker for Node and Python avoids a second queue technology at the boundary where analysis jobs are enqueued by the API and consumed by the AI worker.

## Consequences

- Local development needs Redis. Container wiring is US-114 and is intentionally absent here.
- The Python adapter must agree with BullMQ on payload layout and acknowledgement. That agreement is a schema plus contract tests in the queue story, not a shared library.
- Progress events can use Redis pub/sub or BullMQ events without a second broker. The web process still receives them through the API.
- Redis is not the system of record. Job state that must survive a flush lives in PostgreSQL through `IJobRepository`.

## Alternatives considered

- **PostgreSQL as the queue (SKIP LOCKED).** Rejected as the default. It is a credible fallback behind `IJobQueue`, and the port exists so it can be introduced without rewriting modules. It is a weaker fit for high-frequency progress fan-out.
- **A dedicated broker such as NATS or RabbitMQ.** Rejected for the foundation. It adds a third data system beside PostgreSQL and object storage before the job model is proven.
- **In-process async calls.** Rejected. A crashed render or a long transcription would share the API's lifetime, which ADR-001 separates.
