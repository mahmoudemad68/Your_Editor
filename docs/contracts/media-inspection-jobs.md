# Media inspection Job UI contract (US-131)

The first consumer is the current upload/Media Details workspace. These ports and
components can be reused by US-125; this story does not add a historical library.
JobEvent v1 is unchanged. Its canonical schema remains `job-event.schema.json`.
The browser uses a generated standalone validator from that schema (no runtime
`eval`/`new Function`, compatible with the existing browser CSP).

## Authoritative association and snapshot

`GET /projects/:projectId/media/:mediaAssetId/inspection-job` returns `{job: null}`
until a Job exists, or `{job: {jobId, jobType, status, attempt, reason, createdAt,
updatedAt, sequence}}`. Only persisted `subject_kind = 'media-asset'`,
`subject_id = mediaAssetId`, `job_type = 'media.inspect'` match. Selection is
`created_at DESC, id DESC` among current chain leaves (predecessors with a
persisted canonical `.after.<predecessor UUID>` successor for the same subject/type
are excluded). This avoids resurrecting a predecessor when successor and
predecessor have equal millisecond creation times; the UUID tie-break makes
remaining equal creation times unambiguous. Creation/update times are PostgreSQL epoch milliseconds as decimal
strings; sequence is the last allocated US-130 event cursor, not replay history.
The snapshot supplies status/identity, not a persisted progress percentage.

Owner, Editor, and Viewer use the existing Media Details read predicate.
Non-members, deleted Projects, missing media, and wrong Project/media pairs get
404 without disclosing Job existence. Invalid UUIDv7 identifiers get 400;
unauthenticated requests get 401. The adapter selects only the public fields:
`failure_reason` and `payload` are never loaded into this read model. Failed maps
to `processing_failed`, Cancelled to `cancelled`, otherwise reason is null.

## Retry

`POST /projects/:projectId/media/:mediaAssetId/inspection/retry` takes no policy
or Job identity from the browser, and returns the actual successor snapshot (201).
The server authorizes Owner/Editor; Viewer gets 403 and non-members/wrong pairs
get the same 404. Cookie mutations retain the existing CSRF requirement.
Only the latest Failed or Cancelled inspection is eligible. Queued, Running,
Retrying, Completed, or absent Jobs return 409. A Completed validation rejection
is not a failed processing Job and does not offer Retry.

The infrastructure adapter calls existing `requestMediaRevalidation` with a new
candidate UUIDv7, server correlation context, configured inspection queue, and
canonical configured validation policy. Existing policy-signature/predecessor
idempotency resolves concurrent callers that select the same predecessor to one
winner. A request that starts after the successor becomes active gets 409.
Old terminal history is immutable. Timeout remains 300000 ms and max attempts 2.
No derivative signatures or validation policy are changed.

## Live transport and reconciliation

Browser routes mirror these JSON paths under `/api`. The fixed same-origin
`/api/projects/:projectId/jobs/events` BFF forwards only cookie, explicit CSRF,
and validated/generated request correlation; no user-selected upstream URL or
Host/forwarded-host authority is accepted. It forwards raw SSE bytes with bounded
ReadableStream demand, no-store, no buffering to completion, and aborts upstream
on request abort or downstream stream cancellation. Upstream 401/404 remain those
statuses. Backend authorization, project channels, and forced slow-client socket
cleanup remain US-130's implementation.

`ProjectJobEventStream` ref-counts one connection per Project, shared across
cards. The workspace retains the connection across media changes. SessionClient
supplies authenticated streaming fetch with an explicit AbortSignal, preventing
its default 15-second JSON request timeout. SSE framing handles fragmented chunks,
streaming UTF-8, CR/LF/CRLF, comments, IDs, multiline data, and EOF. Non-job events,
malformed/invalid/wrong-project events and frames over 8192 characters are ignored.
No Last-Event-ID or replay assumption is made.

On startup, the workspace loads Media Details and its controller reads the Job
snapshot. Every stream open/reopen requests snapshot reconciliation; detectable
sequence gaps also schedule one coalesced reconciliation. Reconnection delays
are 250, 500, 1000, 2000, then 5000 ms maximum. Unmount, Project change, or session
loss aborts reads/reconnection and releases subscriptions. 401/403/404 stop the
stream. There is no recurring inspection-details polling.

For the active Job, sequence <= last accepted sequence is ignored. A higher
sequence wins, including percentage reset on a new attempt. Snapshot requests
have generation/revision guards; old responses cannot replace newer live state
or retry identity. New Job identity comes only from a trusted snapshot/retry
response. Up to 64 unknown Jobs retain their latest state/progress pair while
initial identity/retry responses race events. Unknown Queued events can trigger
one 200 ms coalesced snapshot discovery, not permanent polling. The actual retry winner overrides timestamp ties; retired identities prevent
stale predecessor snapshots from replacing it. Old Job events
after retry do not drive the visible card. Terminal state refreshes Media Details
once per Job/status, with the existing response identity/generation guards.

## Presentation and limitations

Statuses read Waiting, Processing, Retrying, Completed, Failed, Cancelled.
Allowlisted stages have fixed human labels; progress uses native semantic
`progress`, integer visible percentage, and 0–100 values. Active Jobs without a
live percentage explicitly show indeterminate progress, never invented 0%.
Only status text has polite live announcements; percentages do not announce
at every report. Failure/cancellation messages are fixed safe strings. Retry is
absent for Viewer, disabled while pending, and retains terminal state with a safe
alert if the request fails. Validation rejection keeps its existing safe message.
Layout uses flexible wrapping and no fixed desktop widths.

Redis pub/sub cannot recover progress emitted while offline. After reconnection,
the database restores identity/status/attempt. A reopened stream clears old
percentages/buffered progress; a still-Running Job is explicitly indeterminate
until a new live report. Subscriber continuity loss closes affected API streams,
which triggers the existing browser reconnect loop and snapshot reconciliation
without polling, page reload or user action. Discovery
of an unpublished initial Job needs its first live event, a reconnect, or manual
Refresh details/status fallback. No snapshot exposes Job payloads. The accepted
US-130 findings F-1, F-3, F-4, F-5, F-6, F-7, N-1, and N-2 are unchanged.

## Web process shutdown

Node instrumentation installs one additional SIGTERM/SIGINT listener pair using
a process-wide symbol-guarded registry. At most 1024 active proxy controllers are
retained; saturation/shutdown rejects new streams with 503. Each request
unregisters on downstream abort, cancel, upstream failure or EOF. Shutdown
synchronously clears the registry and aborts all upstream fetches/readers while
closing downstream bodies. Cleanup is idempotent; Next retains its own graceful
shutdown and exit handling (`NEXT_MANUAL_SIG_HANDLE` is not used). SSE responses
use `Connection: close`: the stream remains open normally, but its completed body
does not leave an idle HTTP keep-alive socket delaying process shutdown.
