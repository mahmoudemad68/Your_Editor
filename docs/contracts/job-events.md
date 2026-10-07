# Job events v1 (US-130, PH1 / Sprint 2)

`packages/domain/src/modules/jobs/job-events.ts` owns the event types and observer
ports. `packages/schemas/src/job-event.schema.json` is the strict JSON Schema
2020-12 wire contract. Browser consumers import the generated `JobEvent` type from
`@editagent/schemas`; `node tools/schema/generate-job-event-types.mjs` generates it
from the domain contract, and schema builds check for drift. Python consumers can
validate the same plain JSON with `jsonschema`. No Redis, BullMQ or Nest types are
part of this contract. US-131 consumption/UI is outside this change.

```json
{
  "schemaVersion": 1,
  "eventId": "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f:4",
  "jobId": "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f",
  "jobType": "media.inspect",
  "projectId": "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4a",
  "sequence": 4,
  "attempt": 1,
  "occurredAt": "2026-10-07T04:00:00.000Z",
  "correlationId": "req_example",
  "kind": "progress",
  "percentage": 25,
  "stage": "probing"
}
```

Every event has the base fields above. `correlationId` is optional and uses the
existing validated request-id format. `occurredAt` is the UTC time the observation
is constructed, not a durability or ordering clock. Progress has `percentage`
and `stage`, and never has `status` or `reason`. State has the durable `status`,
never percentage/stage, and optionally the public reason `processing_failed`
(Failed) or `cancelled` (Cancelled). Internal exceptions, URLs, storage keys,
command output, paths, metadata and payloads are never serialized into events.
The job type is a persisted, bounded application identifier, not a queue name.

## Ordering and attempts

PostgreSQL owns `jobs.event_sequence`. An event increments this cursor atomically
and commits it **before** Redis publication. A per-job session advisory lock
serializes allocation and publication across independent adapters/processes.
`eventId = jobId + ':' + sequence`; sequence is a JSON-safe positive integer.
Deletion of the job deletes its cursor. There are no expiring Redis sequence keys
that could reset while the job is still retained. Sequence orders both event kinds
across retries; clients may deduplicate by eventId and detect gaps. There is no
ordering promise between different jobs or projects.

`attempt` is the PostgreSQL Job attempt count: zero while initially Queued, one
for the first actual run. A supervised Node handler receives the durable attempt
number even during abandoned-run recovery. BullMQ acknowledgement/queue envelope
semantics and Python consumers remain unchanged. Percentage may reset when the
attempt increases. Persisted progress cursors reject regressions within the same
attempt, including reports from overlapping adapters, and stale attempts or
progress for jobs that are no longer Running are ignored. Percentages are planned
pipeline milestones, not an estimate of elapsed time or FFmpeg frame percentage.

## State notifications

| Status    | Notification boundary                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Queued    | Persisted row exists, immediately before making work available to BullMQ; outbox recovery uses the same path.                         |
| Running   | Job start and attempt history are saved; before invoking the handler.                                                                 |
| Retrying  | Durable retry transition, including abandoned-run recovery; before retry acknowledgement.                                             |
| Completed | `recordCompletion` has committed both Job and attempt in PostgreSQL.                                                                  |
| Failed    | Durable failed Job/attempt/dead-letter path; before queue failure acknowledgement. Invalid envelopes also notify the durable failure. |
| Cancelled | Durable cancellation, including queued/delayed cancellation and running cancellation.                                                 |

The existing `emitLifecycle`/`onLifecycle` boundary provides the running lifecycle
observations and logs. Recovery's Retrying notification now follows persistence.
Queue acknowledgements and idempotent re-enqueues of already terminal work do not
manufacture transitions: `event_state_token` deduplicates each status/attempt
observation. An invalid envelope need not have progress or a Running observation.
Lock-loss/unconfirmed execution does not invent a terminal state.

## Redis, transport failures and shutdown

Channels are `editagent:project-job-events:<projectId>`. The publisher resolves
project ownership from the **persisted Job subject**, then Project, MediaAsset or
DerivedAsset rows. A producer's payload projectId is never routing authority.
Missing ownership fails closed. The earlier raw job-specific progress channel is
removed; `JobQueue.publishProgress` now accepts the structured domain report and
forwards it to the same observer transport as lifecycle states.

The publisher has its own command Redis connection with offline queuing disabled,
bounded command timeouts and one retry of the identical encoded event/ID on
publication failure. A dedicated two-connection PostgreSQL event pool uses 250 ms
connection/query/statement deadlines; it cannot deadlock on a media source-lock
connection. Advisory lock acquisition is bounded. The API has one dedicated
subscriber Redis connection with automatic resubscription after reconnect, one
message listener, and reference-counted per-project subscriptions. Subscriber
connections are never used for normal commands or BullMQ.

This is **best-effort live delivery**, not a durable event outbox or exactly-once
stream. The one publication retry may deliver duplicates with the same ID. A
crash, Redis outage or timeout can lose progress or state events and leave cursor
gaps. An ambiguous publish response can also leave uncertainty about delivery.
The raw publisher rejects a failed operation and logs only safe service/job/kind/
correlation fields; reporting boundaries catch observational failures so completed
media work cannot become failed work. Redis never overrides the PostgreSQL ledger.
State tokens suppress duplicate transition observations; they do not constitute
replay of an observation lost during an outage. Consumers must not infer the
ledger's current status solely from an incomplete live stream.

Timers are cleared on terminal reporting and close. Pending latest progress is
flushed before durable completion/retry/failure transitions without waiting for
the throttle deadline. Media child publishers flush before normal exit. API
shutdown closes client streams/subscriptions and Redis; worker shutdown releases
observer connections, stops consuming, aborts lost reservations and reaps handlers.
API shutdown also stops outbox recovery before closing pools.

## Throttle and stages

Same-stage progress reports coalesce into the latest value in a **200 ms** window;
the leading observation and trailing latest change are emitted. Stage/attempt
changes emit immediately. Each pending entry expires after its window; there is
no permanently retained per-job timer. Terminal states bypass the throttle. The
healthy-path product requirement is <= 1000 ms from worker report to SSE receipt;
the integration test enforces that independently of event occurrence time.

| Path          | Stable stages / milestones                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| media.inspect | staging 0; validating 10; probing 25; decoding 55; finalizing 95/100 after verdict persistence. Rejected files may stop before later stages.                                                                    |
| media.derive  | staging 0; proxy/asr/mix/poster/sprite at per-plan milestones; uploading and finalizing per plan; finalizing 100. Milestones use completed plan count and remain <=100. Cached artifacts skip expensive stages. |

These names come from the existing validator and derivative plan variants.
US-128 onStage remains an application callback; validation adds the same safe
callback across its port. No progress data enters artifact parameter signatures,
identity, storage or FFmpeg arguments. Invalid percentages (including NaN,
Infinity and values outside 0..100), attempts and stages fail fast at the producer
boundary; runtime JSON validation rejects invalid messages before SSE delivery.

## SSE and authorization

`GET /projects/:projectId/jobs/events` uses `requireActor`, UUIDv7 parsing and the
same Project read predicate as media details: listed, accessible Project and a
membership (Owner, Editor or Viewer). Missing, deleted and non-member Projects
all use the existing identical 404 response. Unauthorized requests get 401;
invalid identifiers get 400; unavailable subscriptions get 503. Authorization is
checked again before each event and heartbeat, so revocation/deletion closes an
active stream before subsequent delivery. No browser filtering is needed.

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-store`,
`Connection: keep-alive`, `X-Accel-Buffering: no`. Events use `event: job`, `id:
<eventId>` and JSON `data`. Comments `: connected` and `: heartbeat` (15 seconds)
are connection liveness, never domain events. The HTTP response close event
releases subscription, heartbeat, drain listener and any pending buffer.

Backpressure stops writes when `response.write` returns false. Each client has a
maximum of 64 pending observations. Pending progress for a job coalesces to its
latest value, appended in sequence order; state observations are retained ahead
of intermediate progress. An overflow first evicts intermediate progress. If
all 64 slots are state observations, the API forcibly destroys that client's
HTTP response/socket rather than storing unlimited state. For non-draining
output, a single watchdog uses a **5000 ms** deadline measured from the last
successful Node write callback or `drain`, using a monotonic clock. When `write`
first returns false, it computes the remaining interval and aborts immediately
if the confirmed-progress deadline has already expired. Additional queued events
do not renew the deadline. Only a completed write callback or `drain` confirms
writable progress; a returning `true` merely accepts data for buffering.
The watchdog resets the underlying HTTP TCP socket (`resetAndDestroy`) and
destroys the response at the bounded deadline,
instead of calling `end()` and leaving blocked output awaiting a remote read.
Within the bounded connection buffer, latest progress and terminal states are
preserved and flushed on drain. A disconnected connection has no guarantee of
receiving its queued events. Redis publication and workers never wait for browser
writes, drain events or client acknowledgements.

A client application can stop reading while its kernel receive buffer and the
server's kernel send buffer still accept output. SSE has no browser read
acknowledgements, so the server cannot know precisely when the application stopped
reading. Node write callbacks and `drain` indicate local writable progress, not
remote application consumption. The 5000 ms enforcement starts from confirmed
local progress once Node exposes backpressure; it is **not** a promise to close
a socket exactly five seconds after the browser stops reading. Once output is
blocked and no further writable progress occurs, forced destruction prevents an
indefinitely retained server-side established connection. Scheduler delays may
slightly exceed the configured deadline.

Ordinary browser disconnect, authorization revocation and application shutdown
use idempotent graceful cleanup. Slow timeout/state-buffer overflow use a distinct
forced-abort path. Both stop accepting events, clear pending buffers and
heartbeat/watchdog timers, remove drain/close listeners, untrack the stream and
release its project subscription. Forced abort then resets/destroys the HTTP TCP socket and response, releasing
queued kernel output as well as the Node handle; it does not rely on graceful
HTTP response ending or leave a zero-window orphan in FIN_WAIT1.

Reconnection resumes authorized **live** delivery only. `Last-Event-ID` is not a
replay request and no initial snapshot is emitted. Clients must reconcile with
PostgreSQL-authoritative application state after gaps/disconnects; adding a
snapshot/state-query UX belongs to a later application decision. The old
connection's resources are released on close; every replacement is independently
authorized.

The shared Redis subscriber closes all affected Project SSE streams when a
previously ready connection loses continuity. Initial Redis readiness is not a
reset. Each old subscription is notified once, even across repeated retries.
This is a transport EOF/reset, not a JobEvent; v1 JSON is unchanged. API clients
reconnect and reconcile PostgreSQL state because messages in the gap are lost.
Unavailable subscriptions fail with 503; ordinary heartbeat comments do not
prove Redis continuity. Reconnect rechecks authentication and Project membership.
A reset while output is blocked uses the existing forced socket-abort cleanup,
so graceful response ending cannot strand a blocked socket.
