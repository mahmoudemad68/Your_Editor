# ADR-001 — Modular monolith plus workers

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Not yet accepted. Pending team review (US-103 AC2).

## Context

EditAgent has twelve bounded modules and several expensive, independent workloads: perception, FFmpeg, Remotion rendering, and the agent loop. A single process would couple those runtimes. A microservice per module would split the database, the transactions, and the team before the domain model is stable.

The roadmap requires a modular monolith with workers. The API hosts synchronous use cases. Workers host one runtime responsibility each. Agent, media, and render workers are Node processes and can later share a process because they share the job-queue port. The AI worker stays separate because it is Python.

## Decision

EditAgent is a modular monolith plus workers.

- One NestJS API process hosts synchronous use cases for the bounded modules.
- One Next.js web process is presentation only.
- Four worker processes consume jobs: `agent-worker`, `ai-worker`, `media-worker`, and `render-worker`.
- Modules are code boundaries, not network boundaries. They share PostgreSQL and object storage through ports.
- Workers do not call each other over HTTP. They exchange work through `IJobQueue`.
- The Node workers may later run in one process without changing module code, because they depend on the queue port rather than on a specific process layout.
- The AI worker remains its own process.

## Rationale

Module boundaries need enforcement now, while the product still changes quickly. In-process module rules (dependency-cruiser, import-linter, one public interface per module) give that enforcement without operational split. Workers exist where the runtime, the dependency set, or the resource profile is different: a Python model process, an FFmpeg process, a headless render process, and an agent process that calls external LLMs.

Sharing the database keeps a timeline, a job, and a media asset in one transaction model. Private databases per module would freeze boundaries that US-104 has not drawn yet.

## Consequences

- A worker may open PostgreSQL and object storage through its own adapters. That is shared-kernel persistence, not a service API.
- Failure isolation is by process. A render crash does not stop the API.
- Cross-module workflows are application use cases, not remote calls.
- Deploying four workers is more moving parts than one process. Docker Compose for that deployment is US-114 and is not part of this decision's implementation.
- Merging the three Node workers later must not require edits inside domain modules.

## Alternatives considered

- **Microservices per module.** Rejected for the foundation. It multiplies deployment and consistency costs before the boundaries have been tested in code.
- **One process for everything.** Rejected. Python model dependencies, FFmpeg, and headless Chromium should not share a crash and dependency domain with the API.
- **Serverless functions per job type.** Rejected. Long media and render jobs do not fit a short-lived function model, and the local development story would move further from the production story.
