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
The default production model is `small`; the CI queue fixture uses `tiny`, and
the focused regression matrix also runs pinned `small`. CPU uses int8. CUDA is
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
bounded PCM window. Timestamp conversion adds the exact rational PCM sample offset
before rounding once to integer microseconds.

Language detection is not fixed for an entire 24-second core. A streaming first
pass examines four-second source-coordinate cells with Silero speech evidence,
using the supported CTranslate2 variable-length encoder and language detector.
This avoids padding each short language probe to thirty seconds. Adjacent strong
language evidence forms regions; uncertain cells use the nearest available
evidence without assuming English. Decoding retains original PCM and bounds
context to the detected language region. Owned cores may split a region, but
never concatenate away silence or move the source clock. The document's scalar
language remains the duration-weighted dominant language; it does not claim that
every word uses that language.

The log-Mel projection uses a fixed-order float32 reduction rather than an
implementation-dependent threaded BLAS matrix reduction. The evaluator uses the
same bounded BLAS/OpenMP environment as the production child. No recognized
words, confidence values or timestamps are rounded/discarded to make repeat
hashes agree. Real tests compare complete canonical outputs at one and two
native CPU threads, reused processes and fresh processes, including composition
of English/Arabic speech and repeated phrases. Test reports and remaining
platform limitations belong to the exact-head evidence, not an unconditional
cross-hardware numerical reproducibility claim.

The supported x86-64 CPU runtime explicitly selects oneDNN with the official
`CT2_USE_MKL=0` control and disables MKL weight packing (`CT2_PACKED_GEMM=0`).
CTranslate2 otherwise chooses its GEMM backend by CPU vendor. Its float32 CPU
convolution uses oneDNN even when GEMM uses MKL, and its own kernels have separate
ISA dispatch. Constraining MKL alone therefore leaves other encoder operations
independently dispatched. The preceding MKL-only profile passed local Intel
repeatability but failed Tiny Arabic inference on an AMD CI runner; it is not
accepted as a portable deterministic profile.

The `onednn-avx2-strict-v4` profile is established before native imports by service
startup, the isolated job entrypoint and evaluation CLI. `CT2_FORCE_CPU_ISA=AVX2`
and both `ONEDNN_MAX_CPU_ISA`/`DNNL_MAX_CPU_ISA=AVX2` constrain the separate
dispatchers. Both oneDNN default-fpmath aliases are set to `strict`, retaining
float32 rather than permitting hardware-dependent reduced precision. Dynamic
OpenMP teams are disabled. These controls use the installed runtime's supported
interfaces; no runtime library is patched or vendored. Relevant pinned upstream
sources: [CT2 environment controls](https://github.com/OpenNMT/CTranslate2/blob/v4.8.2/docs/environment_variables.md),
[GEMM backend selection](https://github.com/OpenNMT/CTranslate2/blob/v4.8.2/src/cpu/backend.cc),
[CPU convolution](https://github.com/OpenNMT/CTranslate2/blob/v4.8.2/src/ops/conv1d_cpu.cc).
This deployment requires Linux x86-64 with AVX2/FMA; startup verifies those flags
from bounded trusted CPU metadata and fails closed if support cannot be established.
Inherited conflicting ISA/debug overrides are removed; startup rejects an already-imported
native runtime even when environment values match, because they cannot attest earlier
initialization. The profile and bounded thread environment are recorded in inference
parameters and their configuration hash. Tests compare encoded tensors after
different input shapes as well as complete recognized words, native timings,
confidence and provenance across fresh/reused processes. Qualification remains
conditional on the measured runtime and thread configuration, not a claim of
universal cross-hardware equivalence.
The pinned CTranslate2 wheel links GNU OpenMP. `OMP_WAIT_POLICY=PASSIVE` and
`GOMP_SPINCOUNT=0` make idle native workers block instead of consuming a bounded
container's CPU quota between inference and PCM preprocessing. These are supported
scheduling controls, not changes to recognition, alignment, probabilities or
production deadlines. Both are established before native imports, checked at the
adapter boundary and recorded with the profile. Conflicting inherited active or
infinite-spin settings cannot change an admitted job's execution policy.
CI archives CPU/library identity separately. This is not a cross-hardware
bitwise-equivalence guarantee. Unsupported CPU architectures fail startup;
CUDA and other architectures require separate measured validation.
See the [official CTranslate2 environment-variable contract](https://opennmt.net/CTranslate2/environment_variables.html).
Intel documents [conditional numerical reproducibility](https://www.intel.com/content/www/us/en/docs/onemkl/developer-guide-linux/2024-1/get-started-with-conditional-num-reproducibility.html).
GNU documents the [OpenMP wait policy](https://gcc.gnu.org/onlinedocs/libgomp/OMP_005fWAIT_005fPOLICY.html)
and [busy-wait spin count](https://gcc.gnu.org/onlinedocs/libgomp/GOMP_005fSPINCOUNT.html).

Native zero-length or overlapping lexical intervals are not valid output.
Supported CTranslate2 forced alignment uses the original PCM and complete
recognized text; unresolved intervals fail closed rather than dropping words or
inventing epsilon durations. Alignment encodes the actual source feature length
through CT2's supported variable-length input, without artificial thirty-second
padding. Real CPU regression evidence showed padded local contexts collapsing a
lexical word to a zero-duration bin. The bounded fallback first aligns complete context,
then complete segments with one-second context, then two-to-eight neighboring
words with 400 ms, one-second or two-second original-PCM context. It retains complete lexical text and requires ordered
outside anchors. A zero/overlapping native interval near a window's right edge may indicate an
unfinished context hypothesis. Before alignment, the decoder may run once more
with up to one additional configured overlap of original PCM, within the same
language region and the thirty-second total context limit. The old source prefix
must be identical. This is bounded recognition using actual further speech,
not deletion of lexical tokens or assignment of guessed durations to an early
hypothesis. Alignment preserves the complete final recognized text. There is
no third primary recognition pass, synthetic padding or change to core ownership.
The exact algorithm and parameters contribute to the recorded
configuration hash. At most 32 alignment encodes per window are permitted;
cancellation/deadline checks run before each encode and alignment attempt.
Tiny allocates eight of those encodes to its primary timing repair and up to
24 to a timing-only fallback using the
already pinned small model on CPU/int8. It is invoked only if the primary
alignment cannot validate its complete recognized text; primary tiny alignment
is bounded to eight encodes. Small decoding retains its existing 32-encode bound.
The fallback never transcribes replacement words: it aligns the same indexed
lexical sequence against original PCM, and re-aligns the complete bounded context using positive ordered native
intervals. Decoder text and probabilities remain unchanged; timings may change
when that context requires realignment. Partial same-model repairs retain the
existing two-anchor rule. Conflicting or invalid full-context evidence fails closed.
Its model revision/SHA, device and compute type are recorded in the actual
inference parameters/configuration identity. Timing-only fallback is part of
`ct2-contextual-v16`; it is not a claim that tiny alone generated every timing.
Tiny deployments therefore bundle both pinned models during setup/build and
verify both before readiness. There is no inference-time acquisition. At most
one decoder and one lazily loaded fallback model reside in an adapter; their
native calls remain sequential and under the same job deadline and process
limits. Reused adapters expose `close()` to unload both models. Production
inference remains in an owned native process which is terminated/reaped on
cancellation or timeout. Tiny performance/RSS measurements include any fallback
work; the default small decoder does not load another model.
When attention-filter widths collapse different words, including in local windows,
the fallback may combine
unchanged positive intervals from those actual native alignments. It requires an
exact match of the complete indexed word sequence and overlapping temporal
anchors on both available sides; repaired intervals must fit between untouched
neighbors. It never estimates a duration or searches by lexical text alone.
Unresolved or conflicting evidence still fails closed within the same encode bound.
The offline regression suite includes the exact normalized first 600 seconds of
`commons-148215183`, losslessly packed in `tests/fixtures/asr/en-original-ten-minute.flac`.
The fixture manifest preserves the source license/identity, PCM digest and original
WAV header/digest. Tests reconstruct and verify those exact bytes before running
tiny and small separately with the ordinary default beam, thread and deadline
settings. Per-run words, provenance, wall time and process peak RSS are retained.
This checks long-recording integrity; there is no 600-second reference transcript
and no accuracy claim for that fixture.
The `ct2-contextual-v16` identity also participates in durable admission identity,
so prior algorithm results cannot satisfy a new-algorithm task accidentally.
The deferred PostgreSQL receipt fence checks the worker's actual algorithm
acknowledgment and freezes its inference metadata together with the result.
During rollout an old worker's missing/old acknowledgment is rejected, rather
than accepting its old implementation under a new task fingerprint.
Whole words are owned by their midpoint in disjoint
chunk cores. Independently aligned neighboring views may give a word positive
but conflicting timings. A greedy switch to the previous view can then overlap
the following word. Reconciliation chooses one coherent joined sequence using at
least two exact lexical and intersecting temporal anchors. Only unowned leading
right context and trailing left context may be excluded from anchor search;
owned text is never skipped or normalized. For example, an unowned left-context
`February.` must not block earlier exact anchors to the right-owned `February`.
For a collision the alignment input uses the existing word extents in original PCM,
without extra context padding that could absorb an outside word. Every native
interval remains positive, ordered and source-bounded, indexed decoder text is
preserved, and untouched outside boundaries remain strict. Unresolved or ambiguous
evidence fails closed. The captured CI regression is machine-generated diagnostic
evidence, explicitly not evaluation gold. Real one/two-thread tests forbid any
replacement decoding while aligning those captured hypotheses against the actual
licensed source PCM. When two matching, temporally overlapping lexical anchors establish
a boundary sequence, original-PCM realignment retains a recognized prefix that
would otherwise fall into an owning core which omitted it. Different languages
or conflicting/unresolved text never justify guessed words or durations.
Chunk reconciliation must preserve meaningful recognized text.
Zero-time punctuation may attach to an exactly touching timed word, retaining
every character and that word's existing interval and lexical probability.
Every persisted word has positive ordered boundaries and confidence in [0,1].
Confidence is the model's word probability, not calibrated human accuracy.

Before completion, coverage is checked against the final reconciled owned-word
union, rather than each overlapping context separately. Unexplained original-PCM
VAD speech gaps of at least one second receive a bounded independent lexical decode. VAD alone is not proof of
missing words: genuine silence and nonlexical noise do not require a transcript.
If the independent decode recognizes missing speech with adequate native
speech/log-probability evidence, the incomplete result fails closed. This safety
check matches independent words one-to-one, in order, against exact canonical
text with intersecting source-time intervals. A short-context alignment of an
already represented word extending into a gap is not omitted lexical content.
Repeated or different words without that temporal/lexical evidence still fail.
This is not a claim to identify every human omission or translation error.

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
Every run records its identifier, the pinned gold/source/input hashes, complete
recognized words and text, transcript hash and actual inference parameters.
Metrics use the unchanged normalization contract and immutable Owner-approved
gold; a new result never overwrites or relabels that gold.

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
pnpm asr:container --build-only --model small
pnpm schemas:check
pnpm asr:setup --root .local/asr-models --model small
pnpm asr:evaluate --root .local/evaluation
node tools/asr/long-input.mjs .local/evaluation --model tiny
node tools/asr/long-input.mjs .local/evaluation --model small
```

The service test uses real PostgreSQL, Redis/BullMQ, S3-compatible storage,
US-128 extraction, CPU ASR, VAD and FFmpeg acoustic analysis. It requires Docker
and sufficient scratch space. Model weights and downloaded evaluation masters
remain local; explicitly attributed bounded regression fixtures are committed.
Source fixture licensing and exact hashes are recorded in
`tests/fixtures/asr/manifest.json`. Existing Issues #50, #51, #54 and #58 remain
separate; this batch does not change rendering isolation or Tool SDK accounting.
Long-input commands produce separate per-model transcripts and evidence under
`.local/asr-batch`. The permanent ten-minute CI cases include both a repeated
attributed real excerpt and the exact original ten-minute Commons recording.
These are distinct inputs; their reports and performance evidence are separate.

Compose passes the same ASR settings to the media admission coordinator and AI
worker, and builds the selected model into the image. Changing model selection
requires rebuilding. GPU operators must set the shared device/compute settings
explicitly; selecting the GPU profile alone does not change persisted ASR intent.
Actual CUDA inference and nightly GPU accuracy remain unproven on CPU-only CI.

The required test graph runs real CPU ASR tests after the API suite. This avoids
native inference competing with the API's process-startup and authentication
deadline probes on shared CI CPUs; it changes no assertion or timeout. The
original ten-minute CPU recording is measured separately with `tiny` and `small`;
evaluation-window WER uses `small`. Reports retain actual model/runtime identity,
configuration, recognized words, run IDs and resource measurements. Neither
measurement implies GPU performance.
