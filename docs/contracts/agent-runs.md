# AgentRun and AgentStep v1.0.0

US-303 and US-306 implement durable execution infrastructure. The production
driver is `infrastructure-v1`; it reaches Planning and fails with
`PLANNER_NOT_CONFIGURED`. It neither runs an LLM nor reports a successful AI edit.
US-301/302/304/305 and CP1 remain separate dependencies. CP2 remains NOT_MET.

## Admission and state

`POST /projects/{projectId}/agent-runs` accepts only an `idempotencyKey` (16–96
ASCII letters, digits, hyphens or underscores) and optionally BOTH `timelineId`
and `stateSha256`. No prompts, tools, scripts or caller-selected executable paths
are accepted. Owner/Editor can start/cancel; current project members can read.
Foreign and nonexistent resources produce the same 404. Cookie mutation requests
retain the existing CSRF guard. Authentication uses the existing session boundary.

Admission is unique by project, actor and hash of idempotency key. Reusing a key
with different source identity returns 409. At most eight nonterminal runs per
project are admitted under a project advisory lock. The original Timeline snapshot
and content hash are captured inside the admission transaction, never reconstructed
from a changed timeline. Snapshots remain private database data.

The normal graph is Pending → Observing → Planning → Executing → Rendering →
Evaluating → Completed. Executing may skip Rendering and enter Evaluating for a
command-only run. Any nonterminal state may become Failed or Cancelled. Terminal
states cannot be reopened. Retries resume a checkpoint; they do not rewind states.
There are at most 64 tool steps, 256 events, three broker attempts and a 120-second
run admission deadline. This does not change the separate 600,000 ms ASR deadline.

Stop reasons are `PLANNER_NOT_CONFIGURED`, `CANCELLED`, `ACCESS_REVOKED`,
`DEADLINE_EXCEEDED`, `EXECUTION_UNCONFIRMED`, `TOOL_FAILED`, `STALE_SOURCE`,
`STEP_LIMIT` and `INTERNAL`. Public summaries are enum values, never exception text.
Runtime Zod schemas live in `packages/schemas/src/agent-run.ts`. MediaAnalysis and
JobEventV1 contracts are unchanged.

## Durable execution and effects

Migration 0022 adds run, immutable step identity and append-only event tables.
All checkpoints, event sequences and revisions advance in a single PG transaction.
The existing US-129 JobRepository and BullMQ adapter perform delivery, retry and
broker lease handling. Nonterminal PG rows form the durable admission outbox and
are rechecked by the worker after Redis outages. Readiness probes PG, Redis and the
AgentRun table; accepting TCP alone is insufficient.

Agent leases last five seconds, with a 250 ms heartbeat during controlled tool
execution. Every write checks generation, owner, deadline, current membership and
project deletion. Durable cancellation increments generation and immediately makes
the run terminal. The database admission trigger orders stable ToolExecutor receipt
creation with cancellation/revocation. Only existing `editing.trim-video@1.0.0` and
`editing.split-video@1.0.0` proposals are admitted by the guarded primitive.
Production does not select or execute either tool without a future qualified planner.

A tool intent and stable execution identity are persisted before invocation. The
Tool SDK audit primary key admits that identity once; duplicate identity requests
do not reexecute. Successful proposals, canonical Timeline changes, causal receipts,
checkpoint and result event commit atomically. A deferred trigger rechecks deadline
and lease at commit, including lock waits. Completed checkpoints are resumed at the
next ordinal. A running intent after death has an unconfirmed outcome and fails
closed; no proposal or external effect is guessed or repeated. This is not a claim
of exactly-once arbitrary external side effects.

Scripted drivers exist only in `*.test.ts` fixtures and are removed from production
images. No request or environment configuration enables them in the production
composition root. SQL and Redis transport failures are not reported as successful
agent work. A completed Job means its infrastructure driver finished, not that its
AgentRun succeeded; consumers must read AgentRun state and stopReason.

## Audit, export and replay

`GET .../{runId}`, `POST .../{runId}/cancel`, `GET .../{runId}/audit`, and
`GET .../{runId}/export` authorize every request against current membership.
Audit/export pages default to 50, maximum 100. The first page captures an immutable
through-sequence. Cursors bind the run and both persisted event anchors; invalid,
cross-run, missing or forged anchors fail. They are navigation tokens, not access
grants. Sequence is authoritative; event UUID/time is not an ordering mechanism.

Each actual tool admission has a tool-intent event, allowlisted name/version, input
SHA-256 and stable receipt. Confirmed results record output hash, measured duration,
actual SDK cost, command receipt and checkpoint. Unconfirmed results explicitly
have unknown timing/output/cost. No LLM ran, so tokens are null with
`tokenMeasurement=not_applicable` and `decision=no_llm`, not fabricated zeros.
The internal correlation UUID is generated by the server. The request correlation
is represented only by its SHA-256, preventing arbitrary header text entering audit.
No raw tool input, transcript, prompt, storage key, media, stack or account data is
included. Trim/split command payloads contain IDs and coordinates only.

Exports include source project/timeline identity, original snapshot hash and
versioned commands with pre/post hashes and receipts, paginated with the same
through-sequence. Obtain the immutable original snapshot through an authorized
project-data channel; it is deliberately not dumped into the default export.
`replayAgentCommands(original, pages)` validates the original hash, contiguous full
event sequence, receipts and every intermediate command hash. It applies domain
commands offline. It never invokes tools, publishes changes or repeats effects.
All pages must be supplied, in order, from the first page through nextCursor=null.

## SSE reconnect and limits

`GET .../{runId}/events` uses PG-backed catch-up, distinct from live-only JobEventV1.
Each SSE id is `{sequence}.{eventUuid}`. Resume with `Last-Event-ID` or `after`;
conflicting headers/query cursors are rejected. The anchor must exist in this run.
PG fetches at most 32 events at once, always ordered. Duplicate delivery is handled
by sequence/event identity; clients must ignore already applied identities and
reject a conflicting event for an applied sequence. There is no claim of Redis
replay. API/worker restarts retain PG history.

Session signatures/expiry and project membership are reverified while subscribed,
including immediately before every event write. A revoked or expired stream is
reset; reconnect performs fresh authentication. One write is in flight, with a
five-second completion deadline. Each stream ends after 120 seconds or 256 events;
clients reconnect from the last applied id. Limits are four streams per actor and
64 per API process. Shutdown closes tracked connections. Export/stream limits do
not grant access to private history. No browser security setting changes are needed.
