# Architecture decision records

Decisions for the EditAgent foundation. The overview and the diagrams live in [../README.md](../README.md).

| ADR                                             | Title                                                               | Status   | Date       |
| ----------------------------------------------- | ------------------------------------------------------------------- | -------- | ---------- |
| [ADR-001](001-modular-monolith-plus-workers.md) | Modular monolith plus workers                                       | Proposed | 2026-09-29 |
| [ADR-002](002-typescript-and-python.md)         | TypeScript for API, Web, and Node workers; Python for the AI worker | Proposed | 2026-09-29 |
| [ADR-003](003-json-schema-contract.md)          | JSON Schema as the cross-language contract                          | Proposed | 2026-09-29 |
| [ADR-004](004-redis-bullmq.md)                  | Redis and BullMQ                                                    | Proposed | 2026-09-29 |
| [ADR-005](005-postgresql-and-s3.md)             | PostgreSQL and S3-compatible object storage                         | Proposed | 2026-09-29 |
| [ADR-006](006-llm-provider-abstraction.md)      | LLM provider abstraction                                            | Proposed | 2026-09-29 |
| [ADR-007](007-trunk-based-development.md)       | Trunk-based development with short-lived branches                   | Proposed | 2026-09-29 |
| [ADR-008](008-integer-time.md)                  | Time representation as integer microseconds and frames              | Proposed | 2026-09-29 |

## Status of this set

Every ADR in this directory is **Proposed**. The team has not accepted them. US-103 acceptance criterion AC2 requires that acceptance to happen in a reviewed pull request. Merging documentation that records a proposal does not satisfy AC2.

When the team accepts an ADR, change its status to Accepted and add the pull request reference. Do not mark an ADR Accepted in anticipation of that review.
