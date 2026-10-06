# Media worker

The US-129 consumer reserves jobs from `MEDIA_INSPECT_QUEUE` (default `media`), records the durable job lifecycle/correlation ID, and uses the existing child-process supervisor. `media.inspect` retains its existing acknowledgement integration; manual inspection uses the real US-126 adapters below. US-128 adds `media.derive` to the same dispatcher, not a second processing system.

## Inspection and derivation triggers

```bash
node dist/inspect.js <mediaAssetId>
ALLOW_UNVALIDATED_DERIVATION=true node dist/enqueue-derive.js <projectId> <mediaAssetId>
```

The derivation command is an explicit **operator-only** trigger. The worker must also have `ALLOW_UNVALIDATED_DERIVATION=true` to execute it. The default is **false**. There is no API/browser trigger and no automatic upload/inspect-to-derive transition. Inspection completion is technical metadata, **not hostile-media validation**. US-127 is not implemented or claimed. Before enabling automatic production scheduling, US-127 must replace the temporary operator gate with a durable validation check and publish only validated sources. The application `DerivationGate` runs even when every result is reusable. This seam preserves `upload → inspect → validate → derive` without inventing validation status here.

The job subject is the source MediaAsset. Payload fields are exactly `mediaAssetId`, `projectId`, `correlationId`, `version: us128-v1`; other fields are rejected. Paths, keys, URLs, commands, credentials and filenames cannot be supplied by jobs. Source/project binding is checked against PostgreSQL, and keys come from trusted persisted source identity.

## Versioned output policy (`us128-v1`)

| Variant | Kind            | Format / parameters                                                                                                                                                                                                                                                                                                                             |
| ------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| proxy   | proxy           | Video-only MP4, libx264 H.264, yuv420p, veryfast, CRF 23, VBV maxrate 4 Mbit/s / buffer 8 Mbit, two encoder threads, fast-start. Fixed 30 fps CFR; maximum frame count is ceil(source duration × 30). GOP/keyint 30 frames (one second), scene-cut disabled.                                                                                    |
| asr     | extracted-audio | RF64-auto WAV, PCM signed 16-bit little-endian, 16,000 Hz, mono.                                                                                                                                                                                                                                                                                |
| mix     | extracted-audio | RF64-auto WAV, PCM float32 little-endian at source sample rate and channel count; lossless storage of decoded float samples, no lossy re-encoding, no loudness/dynamics normalization.                                                                                                                                                          |
| poster  | thumbnail       | JPEG (mjpeg q=3), aspect-fit in a 320×180 black-padded canvas; timestamp min(3 seconds, duration/3), safely clamped by duration.                                                                                                                                                                                                                |
| sprite  | thumbnail       | JPEG (mjpeg q=3); 160×90 aspect-fit/padded tiles, at most five columns, ceil(count/columns) rows. count = clamp(ceil(duration/5 seconds), 1, 20). Samples are evenly spaced source midpoints (i+0.5)×duration/count. The nearest frame index on a zero-origin 30 fps CFR sampling timeline is explicitly selected; unused grid cells are black. |

The proxy preserves display orientation through FFmpeg autorotation and display aspect ratio (including source sample aspect ratio), converts to square pixels, and uses even dimensions. Height is min(source display height, 540); width follows aspect, with a subpixel rounding difference from even dimensions. Small sources are not upscaled. Fixed 30 fps provides a reproducible seeking grid for CFR and VFR sources. A cloned final frame covers the declared duration before frame-count limiting. `ceil(duration × 30)` is a cap/target, not a guaranteed exact output count: 1.001 seconds can produce 30 frames under a cap of 31. The historical signature field `frameCount: ceil-duration-times-fps` denotes that cap; its value stays unchanged to preserve compatible proxy reuse. The acceptance invariant is 30 CFR and duration parity within one frame. Duration is independently probed and must be within one 30 fps frame (33,333.333 µs) of inspected source duration before publication.

The sprite sampling policy is now `even-midpoints-cfr-nearest-index-v3`, with `samplingFps: 30`, `frameSelection: round-midpoint-us-times-fps` and `finalFramePadding: source-duration-before-pts-reset`. Clone the final frame **before** resetting PTS, then establish the zero-origin 30 fps timeline, explicitly select index `round(timestampUs × 30 / 1,000,000)` for each unchanged persisted midpoint, and tile in timestamp order. Padding uses the inspected source/container duration (bounded to 30 minutes by the existing contract), rather than assuming the video extends as long as its audio. The tile stops after its required samples; the existing child timeout and output bounds apply. At most 20 selected frames and five columns remain.

On pinned FFmpeg 7.1.5, the v2 order (`setpts,tpad,fps,select`) did not extend the video as intended. A midpoint could select an unavailable frame, leaving a terminal failed job with partial artifacts. v3 uses `tpad,setpts,fps,select`; midpoint metadata is unchanged. Only the sprite signature/key changes: v1 interval-end sampling, v2 incorrect padding and v3 corrected padding all have different signatures. Proxy, ASR, mix and poster signatures remain unchanged. Immutable v1/v2 sprites coexist with v3 and are never overwritten/deleted to force reuse.

Content regression fixtures visibly encode each original frame's identity as decimal digits and binary cells. Tests crop/read every actual JPEG cell for 2, 11 and 120 seconds, a one-frame source, VFR with missing midpoint frames, and a rotated source. CFR/rotated tolerance is one 30 fps frame (33,333.333 µs); the VFR fixture tolerance is its largest original presentation gap (66,666.667 µs), plus at most 1 µs for integer timestamp quantization. For other VFR sources, content precision is limited by available original presentation frames as well as the 30 fps sampling grid; resampling cannot invent an original frame at an unavailable timestamp.

The proxy deliberately has no audio; future preview combines it with an audio derivative. When no source audio stream exists, neither audio record nor artificial silent audio is created (three image/video outputs remain). For an existing shorter audio stream, timestamp-gap/trailing silence padding and trimming align the source timeline/duration; this is not loudness normalization. Mix fidelity refers to decoded source audio, not recovering information already lost by the source codec. Extremely short video produces one poster and one sprite cell, repeating the decoded final frame as needed.

`metadata.parameters` includes the pipeline version, source SHA-256/duration, variant and all output settings. `parameterSignature` is SHA-256 over recursively sorted canonical JSON. Changing output policy or FFmpeg runtime requires a version bump. Multiple audio/image variants share the existing DerivedAsset kinds and differ by signature. Persisted image parameters include rows/columns, tile dimensions and sample timestamps for future US-125; no library UI is added.

## Persistence, storage and crash consistency

Migration `0010_derived_assets.sql` stores the existing domain DerivedAsset with object key, parameter signature, MIME, byte count, SHA-256, generation metadata and millisecond audit timestamps. `(media_asset_id, kind, parameter_signature)` is unique. A composite FK binds project/source; the checked key binds project, source, kind, signature and variant. Stored rows are immutable. `PostgresDerivedAssets.listByMediaAsset(id, projectId)` and `findBySignature` supply the future read model.

Keys: `projects/<projectId>/derived/<mediaAssetId>/<kind>/<parameterSignature>/<variant>.<extension>`.

Objects remain private with Content-Type set explicitly. Writes stream a local file with Content-Length and `If-None-Match: *`; large outputs are never loaded into a Uint8Array. Incremental file hashing adds a bounded-memory local read. Final-object metadata contains SHA-256, expected byte count, source SHA-256, signature and a small recovery descriptor; recovery rejects an actual size mismatch. no signed URL or secret is persisted. A successful object write precedes its valid DB row. Existing mismatched objects are rejected, never silently overwritten. A retry reconciles all four cases:

- row + object: validate matching identity/metadata and reuse without staging/FFmpeg;
- row + missing object: regenerate only that variant, require the same bytes/metadata, retain the row ID;
- object + missing row: reconstruct the validated descriptor and insert the row without FFmpeg;
- neither: generate, store conditionally, then insert.

Session-level advisory locks serialize per-source work across workers. Each locked operation uses the same checked-out connection for all repository queries, including a one-connection pool. Each successful row autocommits, so partial outputs survive later failures. Conditional storage writes and the unique constraint also protect against writers outside the coordinator. Job idempotency uses project/source/version; derivative idempotency remains authoritative across replay/crash.

## Runtime, bounds and cleanup

Required environment: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`.

Optional: `FFPROBE_PATH` (ffprobe), `FFPROBE_TIMEOUT_MS` (30,000), `FFMPEG_PATH` (ffmpeg), `PROBE_TMPDIR` (absolute directory), `ALLOW_UNVALIDATED_DERIVATION` (false), `MEDIA_INSPECT_QUEUE` (media).

The pinned custom FFmpeg 7.1.5 build has no network protocols or MPEG-DASH/libxml2. US-128 adds only the PCM float encoder, JPEG encoder/image2 muxer and required fps/pad/tile/rotation filters; this repair adds only the `select` filter, no demuxer or protocol. The worker image contains the actual codecs. Argument arrays, no shell, local staged inputs, `file` protocol whitelist, bounded diagnostics, two encode threads, one filter thread and 30-minute per-job deadline are used. Probe subprocesses have their own 30-second deadline. Cancellation propagates through S3, staging, FFmpeg and probing; FFmpeg receives SIGTERM then SIGKILL after 150 ms if needed. The existing isolated-job supervisor additionally reaps the whole process group on cancel/timeout/lock loss.

Source streams once into a private unpredictable directory and is incrementally SHA-256 checked against the persisted upload identity before FFmpeg; all derivatives use that file. Scratch-space checks reserve source-rate PCM, bounded proxy/ASR/image output and headroom; output files are capped at 64 GiB. Successful/cancelled/failed/upload-failed paths release processor and staging directories in `finally`. SIGKILL/host loss cannot run finally: use ephemeral worker scratch volumes, clear stale private scratch directories only when their worker is confirmed stopped, and provision disk for concurrent jobs. Full US-127 sandbox/hostile-media policy remains future work.

Storage/local-runtime errors are retryable (three attempts, one-second exponential queue backoff); deterministic FFmpeg rejection, duration/format mismatch, invalid payload and ownership conflicts are permanent. Existing queue cancellation/deadline semantics remain authoritative. Low-frequency stage callbacks (`staging`, variant, `uploading`, `finalizing`) publish through the existing queue progress port. Publication is best-effort and does not expose secrets; no US-130 SSE/progress UI is added.

## Tests

```bash
pnpm --filter @editagent/media-worker... build
node tools/test/run-node-tests.mjs workers/media-worker/dist/infrastructure/derivatives.integration.test.js
pnpm --filter @editagent/media-worker test
```

Synthetic source bytes and existing licensed synthetic fixtures exercise real FFmpeg/FFprobe, PostgreSQL, Redis/BullMQ and private SeaweedFS. The F-11 tests enqueue and execute real media.derive jobs for 33,333 / 33,334 / 40,000 µs one-frame sources, 0.5 s video with 1.4 s audio, and short no-audio video. They assert Completed (not merely a consumed reservation), complete rows/objects, actual final-frame pixels, duration parity, unchanged IDs/keys and zero generation on reuse.

**O-8 test environment:** Turbo hashes/passes `FFMPEG_PATH` and `FFPROBE_PATH` to tests. Run pinned validation with absolute paths to the binaries built by the pinned runtime; generic tests without these variables remain host fallback evidence. The real storage/job test prints resolved derivation binary paths/version. Source inspection and output validation inside the production processor use the selected FFprobe. Fixture synthesis still explicitly uses host FFmpeg/lavfi, and independent JPEG/pixel measurements use host tools because the restricted runtime does not include rawvideo/JPEG input demuxing; these host tools do not generate the derivatives. Tests print exact duration/reuse evidence; independent QA and Owner acceptance are separate.

```bash
FFMPEG_PATH=/absolute/pinned/ffmpeg FFPROBE_PATH=/absolute/pinned/ffprobe \
  pnpm --filter @editagent/media-worker test
```

## Independent QA findings and repair boundary

Independent QA on `ac701f21d7cda3f321916cebe56e587c596f5bba` failed: **F-1** sprite midpoint metadata did not match tile pixel content. The v2 repair addressed F-1 with explicit frame selection and real pixel-content tests. Independent re-QA on `427d32c4109017fe69c9a0b8aa0128f9e8f06020` then failed on **F-11**, the short-source padding regression. The v3 repair preserves the F-1 midpoint design and fixes padding order/bounds, with real pinned-runtime queued-job regressions and v1/v2/v3 coexistence evidence. Any repair push invalidates the prior QA result for the new HEAD; independent re-QA and Project Owner decisions remain pending.

**F-2** is a claim correction: the proxy ceil frame count is a cap/target, not a guaranteed exact count. Real tests cover just below/at/above one frame, exact three frames, three frames + 1 µs, and 1.001 seconds. Proxy encoding is not rewritten.

The following findings remain unresolved tracked debt, not fixes in this repair:

- **F-3 (Medium, non-blocking):** no supported operator re-enqueue after a terminal media.derive failure for the same source/version. US-129/job idempotency is unchanged.
- **F-4:** no forced input demuxer. QA's shipped pinned runtime blocked local-file escape; US-127 must provide full hostile-input validation before automatic derivation.
- **F-5:** outside the shipped image, default FFmpeg/FFprobe can resolve from PATH. Production/US-127 hardening should validate absolute pinned executable paths.
- **F-6:** canonical JSON sorts with localeCompare; QA found 138/138 signatures consistent, with no demonstrated current defect.
- **F-7:** fake multi-process FFmpeg can expose pre-existing zombie/init behavior. Container init/subreaper hardening remains operational work.
- **F-8:** object-only recovery trusts stored SHA metadata rather than independently re-reading/re-hashing object bytes.
- **F-9:** row-only regeneration that conflicts with an immutable row can prevent automatic self-healing.
- **F-10:** some deterministic derivation errors are retried under generic transient job semantics.

Existing US-119 authentication and supply-chain debt remains unchanged. No independent acceptance, merge or deployment is claimed.
