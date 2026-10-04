# ADR-005 — PostgreSQL and S3-compatible object storage

- **Status:** Accepted
- **Date:** 2026-09-29
- **Accepted:** 2026-09-29
- **Acceptance vehicle:** PR #2
- **Approved by:** project team / product owner
- **Object-store revision:** Accepted 2026-10-04. The 2026-09-29 text below is unchanged. The revision follows it and supersedes only the MinIO implementation sentence.

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

## Revision — Accepted 2026-10-04

- **Status of this revision:** Accepted
- **Date:** 2026-10-04
- **Approved by:** Molomo9, project owner
- **Acceptance vehicle:** comment on PR #18, 2026-10-04
- **Evidence:** Independent QA of `b075d38e22ce7888e32255c9f7912887c81627c9` returned `PASS_WITH_FINDINGS` and `SAFE_TO_PROCEED_WITH_ADR_REVIEW: YES`. That QA result authorized review. This section records the owner’s later architectural approval.

The 2026-09-29 decision stays in the record. This revision replaces only the sentence that named MinIO as the development implementation.

> An S3-compatible object store holds binary objects. SeaweedFS 4.48, image `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`, is the development and staging implementation. It runs as master, volume, filer, and S3 gateway. `weed mini` is not sufficient. Filer and volume HTTP require JWT. Only the S3 gateway joins the application network. Object Ingress remains the external object entry point. The existing `S3ObjectStorage` adapter stays. MinIO volumes are not mounted and are not deleted.

The owner’s approval is conditional: preserve checksum and conditional-upload behavior, keep secrets at mode `0600` owned by the runtime uid, verify host and IPv6 isolation, do not destroy existing MinIO data, pass the supply-chain gate, and pass a fresh Independent Integration QA. The approval does not merge PR #18, accept vulnerabilities, or deploy to a staging host.

### Consequences of this revision

- Development and staging Compose use the four-component topology and persistent volumes for master, volume, and filer.
- Existing MinIO data, if any, is copied later through the S3 API. The procedure is `docs/operations/us113-seaweedfs-migration.md`.
- Internal gRPC is not configured with mTLS in this revision. The accepted isolation is placement on the internal network, no published gRPC port, and a host firewall that drops IPv4 to that subnet and drops IPv6 on that bridge. `infra/seaweedfs/install-host-isolation.sh` fails if those rules are not installed or if the network has IPv6 enabled. This is the explicit security review of internal gRPC for this cutover.
- Master HTTP and volume `/status` stay unauthenticated. They expose topology and counts, not object bytes, and only on the internal network. Untrusted workloads must not join that network.
- AIStor remains an unchosen alternative. It was not procured.

## Proposed revision — superseded

- **Status of this revision:** Superseded by the accepted revision above
- **Date:** 2026-10-03
- **Approval at the time it was written:** none

This block remains so the proposal is not rewritten as if it had been accepted on 2026-10-03. The owner accepted the direction on 2026-10-04.
