# US-303 / US-306 qualification inventory

Batch: [Issue #76](https://github.com/mahmoudemad68/Your_Editor/issues/76).
Base: `00074f22f1325307bfc6c6a24a270ee10601bc9b` (merged PR #73).
Independent QA is pending. This document describes the executable self-test scope;
it is not an independent QA verdict. Exact-head results belong in the frozen handoff.

## Existing code reused and implementation gap

Main had an identity-only AgentRun and a health-only agent-worker. This batch adds
the lifecycle substrate while reusing the existing domain IDs/Timeline/EditCommand,
JobRepository/BullMQ admission, retry and delivery, ToolRegistry/ToolExecutor audit
and budget reservation, PostgreSQL membership fences, JWT/CSRF middleware, API
composition and generated OpenAPI client. `packages/agent-core` is shared by API and
worker; it does not introduce a second queue, Timeline or planning architecture.

See [the versioned contract](../contracts/agent-runs.md) for state transitions,
limits, cancellation, effect reconciliation, event redaction and replay semantics.
Migration 0022 is additive; existing MediaAnalysis 1.0/1.1/1.2, JobEventV1, tool
manifest and public ToolCall formats remain unchanged. A new trusted coordinator
method admits a persisted ToolExecutor identity once; no public route accepts it.

## Acceptance evidence map

| Requirement                                                                    | Executable evidence                                                                     | Qualification boundary                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Legal graph, terminal states, stop reasons                                     | domain `lifecycle.test.ts`, exhaustive edges and generated stop-reason cases            | Portable                                               |
| Versioned bounded run/step/event schemas                                       | agent-core `contracts.test.ts`                                                          | Portable; strict unknown-field rejection               |
| Authenticated start/get/cancel; owner/editor/viewer and foreign 404            | API `agent-runs.integration.test.ts`                                                    | Real PG/API/session/CSRF                               |
| Unique admission, monotonic ordered events, fixed pagination, cursor rejection | same integration suite                                                                  | Real PG transactions                                   |
| Durable cancellation/revocation, lease/deadline and publication fences         | same integration suite, migration 0022 triggers                                         | Real PG + actual ToolExecutor proposals                |
| BullMQ delivery, duplicate admission, database rollback and Redis interruption | same integration suite                                                                  | Real PG + Redis/BullMQ, bounded proxy interruption     |
| SIGKILL after checkpoint, restart, no completed tool replay                    | test-only `fixtures/agent-run-child.test.ts` driven by integration suite                | Real subprocess, ToolExecutor, PG and Timeline effects |
| Unconfirmed tool result before checkpoint                                      | same child fixture and integration suite                                                | Explicit failure; no guessed/repeated effect           |
| Ordered safe trail and original-snapshot command replay                        | export pagination plus `replayAgentCommands` integration assertions                     | Offline domain command replay, no tool execution       |
| SSE resume, authorization revocation and token expiry                          | API integration suite                                                                   | Real HTTP stream/session + PG                          |
| Slow-client cleanup, input bounds                                              | `presentation/agent-runs.controller.test.ts`                                            | Controlled stalled transport plus real-service tests   |
| Tool SDK budgets/auth/security and existing editing proposals                  | existing complete Tool SDK unit suite plus stable-identity regression                   | Portable; real PG receipt checks in integration        |
| Existing media analysis/edit/render/browser-export functionality               | existing CI regression, real ASR container, production render and graduation demo gates | Requires exact-head Linux execution                    |

## Reproduction

Use repository-pinned Node/pnpm and `pnpm install --frozen-lockfile`. Supply the
existing disposable development PostgreSQL and Redis connection configuration.
The integration suite creates/drops its own `editagent_agent76_*` database and
uses Redis database 12. It must never be pointed at production services.

```sh
pnpm --filter @editagent/api... --filter @editagent/agent-worker... build
pnpm --filter @editagent/agent-core test
pnpm --filter @editagent/domain test
pnpm --filter @editagent/tool-sdk test
node --test apps/api/dist/presentation/agent-runs.controller.test.js
node --test apps/api/dist/agent-runs.integration.test.js
pnpm build
pnpm lint
pnpm architecture
pnpm typecheck
pnpm test
```

CI's existing repository job includes the new API integration and controller tests
through the API test script; no integration assertions are skipped. Existing Linux
CI, Walking Skeleton and Supply Chain budgets/security settings are preserved.
Windows portable checks do not qualify native Linux ASR or real containers.

## Security review and limitations

Threats covered include cross-project reads, role escalation, forged identities,
CSRF, expired sessions, mid-stream membership revocation, stale leases, duplicate
receipts, unknown effects, stale Timeline basis, cursor tampering, oversized requests,
raw input/error exposure and slow/unbounded streams. The API never accepts tools,
prompts, executable code, storage keys or runtime module selection.

The production driver is intentionally infrastructure-only and fails honestly at
Planning. Scripted integration drivers are test-only and stripped from images.
No LLM, autonomous edit/render, full Agent UI or token accounting is claimed. The
effect primitive currently supports existing trim/split proposals; arbitrary external
effects require future proven reconciliation. Export command replay requires the
authorized immutable original snapshot matching the recorded source hash.

CP1 remains unaccepted, CP2 NOT_MET, Tiny Arabic NOT_QUALIFIED, language annotation
accuracy NOT_MEASURED, hidden host parent resource limits NOT_VERIFIED. Existing
held files, immutable gold/model identities and graduation packages are excluded
from this change. Merge-time security-sensitive review remains required; the Coding
Agent does not self-certify that approval or Independent QA.
