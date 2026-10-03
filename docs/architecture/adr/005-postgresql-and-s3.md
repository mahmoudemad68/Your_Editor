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

## Proposed revision — not accepted

- **Status of this revision:** Proposed
- **Date:** 2026-10-03
- **Approval:** none

The decision above stays Accepted. This revision is not approved and does not change the running system.

The open-source MinIO tag used by EditAgent still contains CVE-2026-33322 and CVE-2026-33419. A disposable SeaweedFS 4.48 proof is recorded in `docs/operations/us113-seaweedfs-feasibility.md`. Independent QA rejected `weed mini` because the Filer served private bytes with no credentials. A later multi-component topology kept those bytes behind S3 in a local adversarial test. That topology is evidence for a later decision. It is not a decision, and it is not deployed.

The proposed replacement text, if later accepted, would change only the development object-store sentence:

> An S3-compatible object store holds binary objects. SeaweedFS 4.48, image digest `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`, is the development implementation only in the secure multi-component topology: master, volume, filer, and S3 gateway, with Filer and volume HTTP authenticated and only the S3 gateway reachable from the application network. A host firewall must block the internal subnet. MinIO volumes are not reused. `weed mini` is not sufficient.

The alternative that stays on MinIO is a named patched AIStor release, which needs a license and procurement approval. That alternative is also not accepted.
