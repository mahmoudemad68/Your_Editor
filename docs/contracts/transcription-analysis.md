# Transcription and durable MediaAnalysis (US-201 / US-210)

The JSON Schemas and generated bindings in `packages/schemas` own the persisted
contract. New documents use MediaAnalysis **1.1.0**; the published 1.0.0 readers
and explicit 1.0.0 → 1.1.0 migration remain available. Stored 1.0.0 documents
are returned as 1.0.0; a new analyzer write explicitly validates and migrates them
with the canonical pure migration before producing 1.1.0. Unknown versions fail closed. Timestamps are source-coordinate
integer microseconds serialized as decimal strings. Model, application, dataset
and schema versions are distinct.

## Production flow

The main-branch implementation audit at `e5a2abb42f440e4730c5304d3b2c80052c836c9e`
found US-128 derivatives, US-202 VAD, US-204 acoustic analysis, US-208 schemas,
and US-129 queues. It found no production transcriber, durable analysis aggregate
or analysis-read API. This batch composes those merged components; it does not
copy unmerged US-105 implementation code.

The media worker discovers validated sources, durably schedules the existing
US-128 derivation job, then admits transcript, speech and acoustic-analysis jobs
once their immutable audio derivatives exist. PostgreSQL atomically owns each
job, its configuration and publication intent; BullMQ delivery is at least once.
Recovery republishes queued intents with stable IDs, reconciles terminal jobs,
and expires unfinished tasks using their durable deadline. Redis failures do not
change source identity or manufacture analysis results.

The existing upload API and US-127 validator accept video uploads. The scheduler
admits that supported asset kind only; this batch does not introduce audio-only
uploads or widen MIME/hostile-media policy. The transcriber port itself consumes
verified PCM audio, independently of the upload API.

Transcription and US-202 VAD use the existing mono PCM16 / 16 kHz `asr` derivative.
US-204 acoustic analysis uses the existing `mix` derivative, preserving source
channel semantics before that analyzer's own documented resampling. Original
media is never changed. Staging verifies SHA-256, uses internal temporary paths,
and accepts no caller URL, executable, model path or storage key. ASR staging is
bounded to 64 MiB; acoustic staging retains US-204's 2 GiB bound.

Each analyzer has its own generation, durable Job, immutable configuration and
receipt. A failed analyzer leaves other sections available. Acoustic and VAD
receipts compose the audio section without treating acoustic silence as
non-speech. Unimplemented scenes, faces and objects remain `not_available`.
Specific reruns use a terminal predecessor Job ID; repeated requests for that
predecessor reuse the next generation. Result commits check current job attempt,
deadline, generation, source identity, live project and initiating membership.
An automatic system job has no initiating human; an explicit rerun requires
current Owner/Editor permission. Late cancelled/superseded results cannot become
completed sections.

## ASR runtime and word integrity

`ITranscriber` contains ordinary immutable values, without tensor/framework types.
The infrastructure adapter uses pinned Faster-Whisper 1.2.1 and CTranslate2 4.8.2.
The default production model is `small`; CI uses `tiny`. CPU uses int8. CUDA is
configurable with an explicit CPU fallback; GPU accuracy/performance requires a
separate measured run and is not inferred from CPU tests.

`pnpm asr:setup --root .local/asr-models --model small` acquires immutable
Systran model revisions at setup/build time, checking the size and SHA-256 of
weights, tokenizer, vocabulary and configuration. Production startup verifies the
bundle; inference has no model download or remote-code path. The image includes
the selected model in the virtualenv share directory. Model-root configuration
is an operator setting, never a Job payload.

All `EDITAGENT_ASR_*` settings are validated: model, device, compute type,
CPU fallback, threads (1–8), beam (1–10), seed, timeout (≤600,000 ms), chunk and
context sizes, Silero threshold/hysteresis, minimum silence and padding.
Defaults use 24-second cores, two-second context, beam 5, seed 0 and two CPU
threads. Context never exceeds the model's 30-second alignment window.
Temperature is zero; previous-text conditioning is disabled; one native model
worker runs per isolated inference process. Silero VAD operates on the original
bounded PCM window. Timestamp conversion uses decimal rounding before adding
exact source offsets.

Native zero-length or overlapping lexical intervals are not valid output.
Supported CTranslate2 forced alignment uses the original PCM and complete
recognized text; unresolved intervals fail closed rather than dropping words or
inventing epsilon durations. The bounded fallback first aligns complete context,
then complete segments with one-second context, then two-to-four neighboring
words with 400 ms context. It retains complete lexical text and requires ordered
outside anchors. The exact algorithm and parameters contribute to the recorded
configuration hash. Whole words are owned by their midpoint in disjoint
chunk cores. Chunk reconciliation must preserve meaningful recognized text.
Zero-time punctuation may attach to an exactly touching timed word, retaining
every character and that word's existing interval and lexical probability.
Every persisted word has positive ordered boundaries and confidence in [0,1].
Confidence is the model's word probability, not calibrated human accuracy.

Jobs share US-129 PostgreSQL attempts/BullMQ leases and US-130 progress events.
A native inference child is in an owned process group, has Linux parent-death
protection before native imports, and is killed/reaped on cancellation/timeout.
The durable deadline includes queue waiting. Once it expires, another attempt
cannot extend it; recovery and worker settlement retain the canonical timeout
failure even when transport publication arrives late.
Progress reports completed source time after each bounded chunk. Model concurrency
is one per AI-worker process; deployment must bound replica count as well.
The CPU Compose service is non-root with dropped capabilities, no-new-privileges,
read-only image, bounded tmpfs, CPU, memory and PID limits. Readiness checks live
PostgreSQL, Redis and S3 bucket availability; liveness is independent.

## API and downstream consumers

Authenticated `GET /media/{id}/analysis` resolves the persisted asset's project;
`GET /projects/{projectId}/media/{id}/analysis` also verifies that scope. Responses
are schema-validated and `private, no-store`. Current membership is checked on
each request and again after the durable read. No local path, bucket credential,
signed URL or staging key is returned. A source without analysis returns 404.

`POST /media/{id}/analysis/{transcript|audio|speech}/retry` accepts only
`{"previousJobId":"<canonical UUIDv7>"}` and returns the stable new Job ID.
Only the named analyzer's new receipt changes its section; transcript bytes
remain unchanged by an audio retry.

Future US-223 consumers must verify source UUID/SHA, schema version, source duration,
completed transcript status and per-word confidence/provenance. The preparatory
`assertOutsideProtectedWords` contract rejects half-open cuts intersecting words
and fails closed for missing transcript data. It does not implement automated
silence removal or project editing.

## Evaluation

`pnpm asr:evaluate --root .local/evaluation` runs the production adapter against
all three pinned licensed windows and reports S/D/I/N, pooled language WER,
model provenance, source/scope identity and resource measurements. It validates
the existing US-110 Owner decision and artifact/evidence hashes before reading
gold. `--require-human-gold` is a separate strict gate and fails when absent.
Normalization follows the metric registry, including NFC/casefold and its Arabic
normalization. WER is undefined for an empty reference, reported as `null`.
The evaluation command uses `.local/asr-models` by default; an operator may
override `EDITAGENT_ASR_MODEL_ROOT`. Run model setup explicitly before evaluation.

Owner-approved generated word labels are project gold under the recorded deviation;
they are not independent human ground truth. Do not claim human accuracy, hand
annotation or CP2 acceptance from this diagnostic. Issue #43 remains open:
acoustic silence and Silero non-speech are different measurements and CP2 is
**NOT_MET**. Evaluation scores and outstanding verification belong in the PR's
measured evidence; no acceptance score is hardcoded into inference.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @editagent/ai-worker test
pnpm --filter @editagent/analysis-core test
node --test tests/integration/media-analysis-orchestration.test.mjs
pnpm asr:container
pnpm schemas:check
pnpm asr:setup --root .local/asr-models --model small
pnpm asr:evaluate --root .local/evaluation
node tools/asr/long-input.mjs .local/evaluation
```

The service test uses real PostgreSQL, Redis/BullMQ, S3-compatible storage,
US-128 extraction, CPU ASR, VAD and FFmpeg acoustic analysis. It requires Docker
and sufficient scratch space. Model weights and evaluation media remain local,
never committed. Source fixture licensing and exact hashes are recorded in
`tests/fixtures/asr/manifest.json`. Existing Issues #50, #51, #54 and #58 remain
separate; this batch does not change rendering isolation or Tool SDK accounting.

Compose passes the same ASR settings to the media admission coordinator and AI
worker, and builds the selected model into the image. Changing model selection
requires rebuilding. GPU operators must set the shared device/compute settings
explicitly; selecting the GPU profile alone does not change persisted ASR intent.
Actual CUDA inference and nightly GPU accuracy remain unproven on CPU-only CI.
