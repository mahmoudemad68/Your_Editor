# Architecture decision records

Decisions for the EditAgent foundation. The overview and the diagrams live in [../README.md](../README.md).

| ADR                                             | Title                                                               | Status                                                      | Date       |
| ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| [ADR-001](001-modular-monolith-plus-workers.md) | Modular monolith plus workers                                       | Accepted                                                    | 2026-09-29 |
| [ADR-002](002-typescript-and-python.md)         | TypeScript for API, Web, and Node workers; Python for the AI worker | Accepted                                                    | 2026-09-29 |
| [ADR-003](003-json-schema-contract.md)          | JSON Schema as the cross-language contract                          | Accepted                                                    | 2026-09-29 |
| [ADR-004](004-redis-bullmq.md)                  | Redis and BullMQ                                                    | Accepted                                                    | 2026-09-29 |
| [ADR-005](005-postgresql-and-s3.md)             | PostgreSQL and S3-compatible object storage                         | Accepted; a SeaweedFS revision is Proposed and not approved | 2026-09-29 |
| [ADR-006](006-llm-provider-abstraction.md)      | LLM provider abstraction                                            | Accepted                                                    | 2026-09-29 |
| [ADR-007](007-trunk-based-development.md)       | Trunk-based development with short-lived branches                   | Accepted                                                    | 2026-09-29 |
| [ADR-008](008-integer-time.md)                  | Time representation as integer microseconds and frames              | Accepted                                                    | 2026-09-29 |

## Status of this set

ADR-001 through ADR-008 were accepted on 2026-09-29. Acceptance was recorded through PR #2. The project team / product owner approved them. US-103 acceptance criterion AC2 is satisfied.

The decision date on each record remains 2026-09-29. CODEOWNERS placeholders and the deferred CI pipeline (US-112) are unchanged by this acceptance.
