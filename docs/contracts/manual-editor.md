# Manual graduation editor

The Media Library links validated videos to the manual editor. Upload, validation,
inspection, derivatives and MediaAnalysis retain their existing contracts. The
editor uses the canonical Timeline, migration-0018 snapshot storage, audited
`editing.trim-video` / `editing.split-video` proposals and the existing
`render.remotion` Job with `SelectingRenderStrategy`. No automatic silence removal,
agent planning, scene detection or new job state machine is added.

The API creates a single video track from inspected source identity and timing.
It retains the source duration, and ends the composition at its last complete
frame. Trim and split accept absolute timeline microseconds, snap through the
existing SDK and apply canonical commands. Trim preserves placement and the
composition duration; gaps are rendered using the existing black/silent-gap
semantics. Every mutation binds the expected snapshot SHA-256. The PostgreSQL
adapter fences that hash and current Owner/Editor membership atomically. Viewers
may read timelines and completed exports, but cannot edit, render or cancel.

Routes under `/projects/:projectId`:

- `POST /timelines`: inspected `mediaAssetId` only.
- `GET /timelines/:timelineId`: canonical snapshot and `stateSha256`.
- `POST /timelines/:timelineId/trim`: hash, clip ID and `startUs`/`endUs`.
- `POST /timelines/:timelineId/split`: hash, clip ID and `atUs`.
- `POST /timelines/:timelineId/render`: hash and stable `req_` request identity.
- `GET /exports/:jobId`: persisted status/attempt; no payload, keys or raw errors.
- `POST /exports/:jobId/cancel`: the existing cancellation lifecycle.
- `GET /exports/:jobId/download`: authenticated, 60-second preview/download links
  for a Completed project-owned render. Membership is rechecked after signing.

Caller identity comes from the existing session middleware. Cookie mutations
retain CSRF enforcement. The BFF forwards only cookies, CSRF and correlation to
fixed routes, bounds JSON bodies/responses and never accepts storage keys, URLs,
filters, executable code, actor IDs or timeline snapshots for mutation.

The operator must set `EDITAGENT_RENDER_VERSION` to the actual coordinator image's
`dist/bundle/catalog.json` `renderVersion`. The existing default queue is
`render-remotion-v1`. An absent version produces an explicit unavailable response;
no placeholder version or fake completion is used. API, media/AI workers and the
render coordinator/executor must share the intended database, Redis and bucket.

Run `pnpm render:test --graduation-demo` after the normal build and
`pnpm asr:container`. It retains the full render regression suite, then creates a
separate real database/Redis namespace/bucket and exercises signup, project creation,
upload, inspection, actual Small analysis, durable trim/split/reload, production
render, browser playback and browser download. Independent FFprobe checks the
downloaded media's codecs, dimensions, duration, frame count and frame clock.
No domain rows or successful job states are inserted by the demo harness.
The disposable MinIO fixture uses server-side loopback-only CORS because its
pinned release rejects bucket-CORS writes. The harness requires actual PUT/GET
preflights for the browser origin; production SeaweedFS policy is unchanged.

The demonstration input is repository-generated animation with the immutable,
licensed English human-speech fixture. It is demonstration media, not independent
accuracy gold. Its actual processing uses production adapters. Public evidence is
limited to the explicitly named report, masked screenshots and that newly generated
demo export; all native diagnostics, private logs, evaluation gold and prior render
artifacts remain excluded. A failed/incomplete run cannot establish full MVP PASS.
H1/H2/H3, WER, production performance, US-210 recovery and Independent QA remain
separate acceptance gates. No merge, deployment or Ready transition is implied.
