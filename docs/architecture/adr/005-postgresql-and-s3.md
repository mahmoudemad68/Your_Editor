# ADR-005 — PostgreSQL and S3-compatible object storage

- **Status:** Accepted
- **Date:** 2026-09-29
- **Accepted:** 2026-09-29
- **Acceptance vehicle:** PR #2
- **Approved by:** project team / product owner

## Context

EditAgent stores two kinds of state: structured module data (users, projects, timelines, jobs, analysis documents) and large binary objects (source media, proxies, thumbnails, renders, quarantined downloads). Putting bytes in the database, or metadata only on a filesystem, both fail the deployment model. Development needs an S3-compatible store so production and laptops use the same API.

## Decision

- PostgreSQL is the system of record for module metadata.
- An S3-compatible object store holds binary objects. MinIO is the development implementation.
- Domain code talks to `IObjectStorage` and repository ports. It does not import a Postgres driver or an S3 client.
- Object keys are allocated by the owning module (Media, Assets, or Rendering). The adapter stores bytes and does not assign domain meaning.
- The browser uploads and downloads bytes with presigned URLs. Storage credentials stay in the application trust zone.
- Primary keys and audit columns are specified by US-104. This ADR does not draw the ER diagram.

## Rationale

PostgreSQL matches the relational ownership and consistency the modules need, and the team can run it locally. S3 is the usual API for large media, and MinIO implements that API without a cloud account. Presigned uploads keep multi-gigabyte bodies off the API process.

## Consequences

- Two stores must be backed up and restored together: a row that points at a missing object is a defect.
- Infrastructure adapters for Postgres and S3 are later stories (US-104, US-114, US-122). This slice documents the boundary and does not connect to either store.
- Tests that need a real database wait for the integration harness (US-116), not this slice.
- MinIO in development and a hosted S3 API in production must stay interchangeable behind `IObjectStorage`.

## Alternatives considered

- **Filesystem paths in the database.** Rejected. Paths do not survive a second machine, and they invite path-traversal bugs the threat model already names.
- **SQLite for development and PostgreSQL for production.** Rejected. Two SQL dialects would weaken the repository tests.
- **A document database for analysis JSON and PostgreSQL for the rest.** Rejected for the foundation. Analysis documents fit in PostgreSQL JSON columns validated by JSON Schema. A second database can be revisited if measurement says so.
