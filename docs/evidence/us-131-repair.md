# US-131 F31-1 / F31-2 implementation repair evidence

Previous independent QA target: `a39270f56b8106b2fd925727f01abf265a45d5c0`.
Same Draft PR [#31](https://github.com/mahmoudemad68/Your_Editor/pull/31).
Focused independent re-QA is pending for the repaired HEAD recorded in the PR.
No merge, deployment, Ready status, retry redesign or US-125 work.

[Measured timelines and outcomes](us-131-repair.json).

F31-1: a process-wide symbol-guarded registry retains at most 1024 active SSE
proxy controllers. Node instrumentation installs one extra SIGTERM/SIGINT pair.
Shutdown synchronously clears/aborts controllers; ordinary cancellation, EOF,
failure and downstream abort unregister idempotently. The BFF closes its readable
body and cancels the upstream reader/fetch. `Connection: close` avoids idle
HTTP keep-alive after EOF. Next retains its own lifecycle/exit; no application
`process.exit()` or `NEXT_MANUAL_SIG_HANDLE` override was added.

Real child-process tests use authenticated HTTP SSE with the browser/client kept
connected when actual SIGTERM is sent. Both `next start` and the exact standalone
server layout are tested with one and three streams across two Projects. In the
final shutdown regression, maximum exit times were 51.8 ms / 48.1 ms respectively;
maximum upstream subscription release was 9.5 ms / 8.3 ms. Both application
subscription counts and physical Redis channel counts return to zero. Registry/subscriptions
return to zero; no established server socket remains. Process listener counts
are two per signal: one Next listener and one repair listener, unchanged across
repeated requests. Normal disconnect release was at most 11.6 ms (HTTP control
polling included; this is an observed upper bound, not a browser-read guarantee).

The real non-root web production image was built and its unmodified runtime CMD
tested with three streams. The JSON records image identity and Docker timings.
Build-only CA/proxy settings were supplied through a temporary Dockerfile and
BuildKit secret for this managed environment; the repository Dockerfile and final
runtime layout/base image were unchanged. No CA/credential was baked into runtime.

F31-2: the subscriber port has an optional transport-reset callback. Real loss
of a previously ready Redis connection notifies every existing subscription once;
initial readiness is silent. The shared connection resets all affected Projects.
API SSE closes without emitting a fake JobEvent. Blocked output uses the existing
forced socket-abort path, preserving the accepted slow-client protection.
Unavailable subscriptions return 503. Existing browser backoff/reopen/snapshot
reconciliation remains the only reconnect engine. Old percentages are discarded
on reopen: Running without fresh progress is indeterminate.

Real Redis `CLIENT KILL` tests verify initial-ready silence and reset coalescing.
The browser reproduction uses actual Chromium, Next BFF, Nest API, PostgreSQL,
Redis, BullMQ and the production media-worker entry point. A test-only real TCP
proxy interrupts just the API subscriber, leaving Redis/workers available.
Two uploaded inspection Jobs complete during the gap while the visible card is
still Waiting. Restoring transport leads to SSE reopen, exactly one visible-card
snapshot and automatic Completed DOM within 2007 ms after acknowledged readiness.
Old SSE EOF is observed; no page reload or manual action; one active Project
stream; zero cross-project events. Earlier passing recovery runs took 37/39 ms;
2007 ms is the maximum measured across these runs. Retired channels are explicitly
unsubscribed after Redis recovery, avoiding orphan auto-resubscriptions. Revoked Project access returns 404 on reconnect
and delivers no further protected events. The fixture preserves a valid Owner and
membership chronology when revoking the browser user.

Healthy worker report → DOM latency samples: 7/9/10 ms (min/median/max).
Real Failed → safe reason → Retry click → distinct queued successor → actual
BullMQ execution → Completed passes; predecessor remains identical, one stream,
no reload. Access refresh on reconnect, logout cleanup, re-login stream creation
and expired-session loop termination pass. Snapshot JSON, JobEvent v1 and retry
policy/authorization/idempotency remain unchanged.

Full local checks pass: roadmap, frozen install, build, lint, architecture,
typecheck, tests, `pnpm check`, generated API client and standard/GPU Compose.
92 web tests, 107 API suite tests plus real slow-client regression, and 16
Playwright tests pass. US-130 real ordered/unique events, retry/cancel/isolation
and 200 ms throttle pass (worker→SSE maximum 217 ms, cross-project count zero).
16000-write slow-client regression closes three blocked sockets after
4572/4562/4562 ms; kernel sockets absent and queued bytes zero. US-127 validation/
sandbox/timeout recovery, US-128 audio-led derivatives/idempotency, and US-129
queue/retry/cancellation/lock/Python regressions pass. Final passing processes
terminate naturally; test-owned services are removed before handoff.

Intermediate runs caught test-only issues: missing explicit Node test globals,
a sample worker needing a second invocation for the second Project, invalid
revocation fixture chronology, and an incorrect indeterminate DOM assertion.
The assertion correction initially touched the wrong occurrence; both assertions
are corrected. A five-second default session-test wait did not accommodate the
existing five-second maximum reconnect delay plus authentication; its wait is
seven seconds. The product outage recovery assertion remains six seconds and
healthy report→DOM remains one second. No tests/assertions were disabled.

Exact repaired-HEAD CI and supply-chain run links/counts are recorded in the Draft
PR after completion. Baseline debt is not fixed: 0 Critical, 342 HIGH image rows /
23 unique HIGH CVEs, Node 1 HIGH + 2 Moderate, Python/secret findings zero.
No dependency, lockfile resolution or production base-image change.

Preserved non-blocking findings: F31-3 one snapshot/card/reopen; F31-4 crafted
DB-only suffix edge; F31-5 Viewer/current-upload consumer limitation; F31-6
pre-existing mobile header overflow; F31-7 minor hygiene; US-130 F-1/F-3/F-4/
F-5/F-6/F-7/N-1/N-2 where not superseded by subscriber-reset recovery. Redis
pub/sub still has no replay; this repair restores authoritative state, not lost
percentages or historical events.
