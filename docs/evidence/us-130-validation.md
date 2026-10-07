# US-130 implementation validation

Base: `a517db2f598712af8d6911ccd24323bbcdb694b7` (accepted US-127 / PR #28).
This is implementation evidence. Independent QA and Project Owner acceptance are pending.
The final implementation SHA and exact-head CI/security runs are recorded in the Draft PR.

## Real application flow

See [live flow](us-130-live-flow.json) for exact worker report timestamps, receive
timestamps, event JSON, sequences and retry flow. It uses PostgreSQL, Redis,
production JWT verification/actor binding, persisted project authorization, a real
HTTP SSE client, BullMQ and a separate sample worker process. The fixture uses IPC
configuration rather than reading runtime configuration outside the established boundary.

- Project P: `01a114c8-655b-71b5-82d0-005e5b07cfc7`.
- Job: `01a114c8-663a-75ea-a098-15e09c90567f`; final durable PostgreSQL status: Completed.
- Sequences 1–7: Queued, Running, staging 0, proxy 25, proxy 75, finalizing 100, Completed.
- AC1 maximum report-to-receive latency: **206 ms**, asserted <=1000 ms.
- Project Q: `01a114c8-655b-7df7-aff9-b18f55e6f05a`; job `01a114c8-68be-7bd1-96ff-f088dc3acb72` also completed.
- Project-P subscriber received **0** Project-Q events.
- A **103**-report burst produced **4** progress events, including the latest 100%.
- Completed arrived 2 ms after event construction and was not dropped.
- Retry states: Queued:0 → Running:1 → Retrying:1 → Running:2 → Completed:2;
  percentages reset on attempt 2 and sequences continue increasing.
- Normal failure, running cancellation, queued cancellation, idempotent duplicate
  acknowledgement, abandoned-run recovery and concurrent publishers are exercised.
- Owner/Viewer access succeeds; anonymous 401; invalid UUID 400; non-member,
  nonexistent and deleted project requests share the existing 404 response.
- Revoking Viewer membership closes the active stream before subsequent delivery.
- MediaAsset and DerivedAsset ownership override spoofed payload project IDs;
  missing persisted ownership publishes nothing.
- Redis disconnect/reconnect resumes the existing live subscription. Malformed JSON
  and events whose project disagrees with their channel are ignored.
- Outage tests use a real unavailable Redis publisher for state/progress; raw
  publication rejects, while the job still completes in PostgreSQL.
- Client disconnect/reconnect ends with zero registered subscriptions. Paused real
  clients cannot block Redis or job execution. Controller backpressure tests retain
  latest progress and Completed on drain, and disconnect at 64 pending states.
- Python `jsonschema.Draft202012Validator` independently validates all seven observed
  events against the shared JSON Schema. No Python producer was added.

## Checks

All final commands finish without persistent subscribers, test HTTP servers or workers.
`pnpm check` passes, including the following invoked checks:

| Command / suite                                                                                        | Result                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| python3 tools/roadmap/build_roadmap.py --check                                                         | PASS                                                                |
| pnpm install --frozen-lockfile                                                                         | PASS                                                                |
| pnpm build                                                                                             | PASS                                                                |
| pnpm lint                                                                                              | PASS                                                                |
| pnpm architecture                                                                                      | PASS                                                                |
| pnpm typecheck                                                                                         | PASS                                                                |
| pnpm test                                                                                              | PASS (workspace, architecture/integration and 13 browser E2E tests) |
| pnpm check                                                                                             | PASS                                                                |
| pnpm --filter @editagent/web check:api-client                                                          | PASS                                                                |
| infra/scripts/validate-compose.sh                                                                      | PASS (standard and GPU profile)                                     |
| Job queue / API / media-worker / SSE focused suites                                                    | PASS                                                                |
| US-129 Node/Python queue, lock, retry, cancellation, recovery and ledger regressions                   | PASS                                                                |
| US-127 hostile validation, sandbox, source identity, revalidation, 300s timeout and transient recovery | PASS                                                                |
| US-128 derivative regressions                                                                          | PASS                                                                |

The US-127 suite performs actual 40-second staging and genuine historical 30-second
outer timeouts, followed by recovery with the accepted 300-second intent. It
retains the derive gate and produces zero outbound hostile-file canary requests.
[Derivative measurements](us-130-derivative-regressions.json) cover both requested
0.5-second video / 6.4- and 18.4-second audio cases: proxy/ASR/mix durations match,
poster/sprite sampling and last-frame clone remain correct, five current private
objects/records exist, and a second run creates zero artifacts. Progress does not
enter output signatures or identity.

### Managed environment setup

The final check uses the repository's existing development PostgreSQL/Redis/S3
settings explicitly; one older media-page test otherwise defaults to ports
5433/9002. Chrome executable settings are now forwarded and included in Turborepo's
test hash. The installed Chromium executes the real authentication/browser tests.

This container's PID 1 does not reap orphaned job descendants. A temporary test
wrapper calls Linux `PR_SET_CHILD_SUBREAPER` and reaps adopted children while
running the unchanged process-group assertions. This fixes the execution environment,
not the supervisor or its assertions. Normal GitHub runners have a reaping init.
Initial setup runs found missing Chrome settings and migration-list expectations;
the final full check passes after correcting both. An earlier API shutdown run
also exposed the outbox recovery timer; production shutdown now stops it.

The standard storage-start script cannot establish the required host IPv6 firewall
in this managed environment. Local media regressions use an authenticated SeaweedFS
test container exposing only loopback S3; its internal service ports are not
published. Both standard/GPU Compose configurations validate. Exact-head GitHub CI
runs the normal storage firewall/trust-boundary checks on its runner. Test services
are removed after local verification; no staging/production deployment occurs.

## Supply chain and actual transport limits

Dependency manifests/lockfiles and Docker base images are unchanged. The current
Node audit reports 0 Critical, 1 HIGH (`source-map-js`, CVE-2026-93749 /
GHSA-68fv-2mgg-jv7q), and 2 Moderate (Ajv and OpenTelemetry core) findings. Python
audit reports no known vulnerabilities. The accepted baseline's downloaded image
reports contain 0 Critical and 342 HIGH occurrences across 23 unique advisory IDs.
These are unresolved baseline debt, not fixed by US-130; the PR records final-head
scan counts and comparison evidence.

Redis pub/sub has no replay or durable delivery guarantee. One identical-ID publish
retry can duplicate an event; outages can lose states/progress and create sequence
gaps. Slow clients may be disconnected when the bounded state buffer fills. No
initial PostgreSQL snapshot or US-131 UI is implemented. See the
[contract](../contracts/job-events.md) for full ordering, throttle, authorization,
backpressure and failure semantics.
