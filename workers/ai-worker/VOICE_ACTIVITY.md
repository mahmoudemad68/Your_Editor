# US-202 speech perception

`IVoiceActivityDetector` in `domain/analysis/voice_activity.py` accepts a bounded stream of
mono PCM16LE and immutable audio/source identity, configuration and optional cancellation.
It returns `SpeechAnalysis`: source-coordinate speech regions and reproducible provenance.
Application orchestration depends only on this port. Only `infrastructure/silero_vad.py`
imports NumPy/ONNX Runtime. No PyTorch, Faster-Whisper runtime, transcription, new queue,
analysis database, API, timeline editing or render-worker change is included.

## Input and deployment

Use the persisted US-128 `asr.wav` derivative (16 kHz, mono, signed PCM16LE). The trusted caller
stages that private object using the existing object-storage architecture and supplies its
SHA, logical artifact/source IDs, original source SHA and source duration. Do not accept a
browser-supplied object key/project identity. This story does not add an ingestion/analysis
orchestration job; US-210 will connect perception to persisted job subjects and analysis storage.
The worker scaffold verifies VAD configuration/model at startup; the local production adapter
entry point is executable independently. Output is the speech section for future US-208
MediaAnalysis, not a competing full analysis aggregate.

Each WAV passed to the local adapter covers exactly its declared source scope. A full-source
`asr.wav` uses `[0,sourceDurationUs)`. Evaluation WAVs cover `[30000000,90000000)` but their
local samples begin at zero; the detector adds that source offset exactly once. No filesystem
paths or signed storage URLs are serialized. WAV bytes must match the supplied identity.

Canonical WAV needs no FFmpeg: stdlib wave streams bounded reads directly. Optional noncanonical
local PCM WAV (8/16/22.05/24/44.1/48 kHz, 1–8 channels, 16/24/32-bit integer PCM) requires an
explicit absolute FFmpeg executable. It resamples to 16 kHz and uses FFmpeg's deterministic
standard mono downmix across channels. This helper is intended for trusted staged files/testing;
the default AI image intentionally consumes canonical US-128 WAV without adding a second FFmpeg
build/runtime. It rejects other formats, compressed WAV, inconsistent duration, symlinks and
inputs over 512 MiB. FFmpeg gets argument arrays, file-only protocol/WAV-only demuxer, one
thread, no stdin, bounded output/deadline and an isolated temporary directory removed on all
paths. PCM sample count is ceil(scope duration × 16000 / 1000000); at most one source sample
of duration quantization is tolerated, not arbitrary missing audio. No originals are modified.

## Model, acquisition and license

The Silero v6 graph distributed in Faster-Whisper **1.2.1** is acquired from the exact release:
<https://raw.githubusercontent.com/SYSTRAN/faster-whisper/v1.2.1/faster_whisper/assets/silero_vad_v6.onnx>.
It is an optimized ONNX graph with `input`, recurrent `h` and `c`, not the PyTorch interface.
Model identity: `v6-faster-whisper-1.2.1`, size **1245151**, SHA-256
`4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2`.
The SHA is authoritative even if a release tag were moved. Upstream Silero MIT and the
Faster-Whisper MIT license notices are retained in `licenses/` and the image.
Sources: <https://github.com/snakers4/silero-vad/blob/master/LICENSE> and
<https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/LICENSE>, verified 2026-10-09.

Runtime: pinned **onnxruntime 1.31.0**, **numpy 2.4.6**, CPUExecutionProvider, sequential
execution, one inter/intra-op thread. All dependencies and distribution hashes are in uv.lock.
No transcription dependencies, remote-code loaders, torch.hub or GPU runtime are installed.
`pnpm build`/image build runs explicit acquisition once; existing bytes are hash-verified/reused.
Setup refuses corrupt existing files and never replaces unknown bytes. Inference never downloads.
The final non-root image includes the verified model under its venv `share/editagent/`.

```sh
pnpm install --frozen-lockfile
pnpm --filter @editagent/ai-worker build
# Or after uv sync:
pnpm vad:setup
pnpm --filter @editagent/ai-worker test
```

## Configuration and segmentation

Settings are parsed/validated at startup and by the CLI. Environment variables:

| Variable                         |                                 Default | Meaning                                                     |
| -------------------------------- | --------------------------------------: | ----------------------------------------------------------- |
| EDITAGENT_VAD_SPEECH_THRESHOLD   |                                     0.5 | Start speech at probability >= threshold                    |
| EDITAGENT_VAD_NEGATIVE_THRESHOLD |                                    0.35 | Active speech ends after sustained probability < this value |
| EDITAGENT_VAD_MIN_SPEECH_US      |                                  100000 | Minimum unpadded speech duration                            |
| EDITAGENT_VAD_MIN_SILENCE_US     |                                  200000 | Consecutive low probability needed to close a region        |
| EDITAGENT_VAD_PADDING_US         |                                  100000 | Padding on each boundary                                    |
| EDITAGENT_VAD_TIMEOUT_MS         |                                  120000 | Deadline including waiting for the adapter lock             |
| EDITAGENT_VAD_MODEL_PATH         | venv/share/editagent/silero_vad_v6.onnx | Local verified graph                                        |

Require `0 < negative < speech < 1`, finite values, positive integer minimum durations,
padding 0–1000000 µs, timeout 1–600000 ms. The existing 30-minute source cap applies.
0.5/0.35 are the documented Silero baseline hysteresis values. Minimum speech 100 ms,
200 ms pauses and 100 ms padding favor preserving short speech/boundaries rather than
aggressive silence cuts; they are configurable initial policy, not a measured optimal choice.
The values were selected before evaluation and were not tuned on the three baseline clips.

Inference uses 512 new samples (32 ms) plus 64 samples of context and per-request recurrent
state. A final partial window is zero-padded only for inference, with boundaries limited to
actual samples. The adapter retains bounded frame probabilities (<=56250 windows/30 minutes),
not decoded long-audio tensors; PCM reads are <=1024 bytes. It admits one inference per
adapter; lock wait and each inference window check cancellation/deadline. No subprocess belongs
to canonical detection. Optional FFmpeg is terminated by its own process group on interruption;
there is no broad process kill. A cancelled/timed-out call returns no successful analysis.

Inactive mid-band noise never starts speech. Once active, probabilities >= negative threshold
retain speech/reset the silence timer. Very short below-minimum candidates are discarded.
Padding is clamped to scope and colliding/touching regions are merged; output is sorted/disjoint.
Window boundaries convert with integer floor division, then clamp to the declared source scope.
No floating-point accumulated time is used. Confidence is the sample-weighted arithmetic mean
of model window speech probabilities over the final **padded/merged** region, including its
padding. It is a model score, not a calibrated statistical probability of region correctness.

`packages/schemas/src/speech-analysis.schema.json` is the strict version-1 speech-section
contract. The authoritative Python parser checks its structural schema AND temporal ordering,
source bounds, probability/configuration invariants. Cross-record/time comparisons belong in
that parser, not an inaccurate JSON Schema approximation. Serialization uses canonical decimal
microsecond strings and sorted JSON keys. Provenance includes source and audio SHA, normalized
PCM SHA, model SHA/version, adapter/runtime/NumPy versions, CPU/thread/window/context settings,
thresholds, padding, durations and the confidence aggregation convention. Same audio/model/config
on the same pinned CPU runtime repeats byte-identical serialized results in the real adapter test;
cross-hardware numerical identity is not asserted.

Errors distinguish `InvalidAudio` (permanent input), `VadModelError` (model/configuration),
`VadCancelled`, `VadTimeout` and infrastructure exceptions. A future job handler must map these
to the existing queue lifecycle and must not publish results after cancellation. No raw decoder
stderr, local path, arbitrary code or URL enters analysis output.

## Evaluation and acceptance

```sh
# Project gold: validates the pinned Owner decision before using generated labels.
pnpm vad:evaluate --root .local/evaluation
# Separate strict human-gold mode; currently exits 2 with EVALUATION_GOLD_UNAVAILABLE.
pnpm vad:evaluate --root .local/evaluation --require-human-gold
```

The harness validates the exact US-110 dataset/provenance policy, approval/fingerprints and
source/PCM hashes, then runs the production adapter. Missing gold/media fails explicitly;
no clips are silently skipped. Approved annotations and producer files are never modified.
The three 60-second scopes are two English sources (commons-28956463/commons-98650286) and
Arabic commons-82236797. All are `machine_generated`, Owner-approved under
`us110-owner-generated-annotation-gold-v1`; there are **zero human-created silence labels**.

US-110 half-open interval unions/intersections within the approved scope, integer microseconds,
no tolerance collar. Speech gold is scope minus gold silence; silence predictions are scope minus
predicted speech. Both are reported, with pooled TP/FP/FN before precision/recall/F1. Empty/empty
scores 1, empty predictions only precision=1/recall=0/F1=0, empty gold only
precision=0/recall=1/F1=0, touching endpoints contribute zero overlap. Speech F1 does not replace
US-110/CP2's canonical silence F1. Boundary diagnostics match the largest positive temporal
overlap per gold speech region and report median absolute onset/offset error plus coverage;
they are diagnostics, not one-to-one detection quality or an acceptance metric.

Implementation diagnostic run (unchanged defaults): speech TP=163948000, FP=6572000, FN=0 µs;
precision **0.961459**, recall **1**, F1 **0.980351**. Silence F1 **0.742598**. This is agreement
with Silero-generated references, **not independent human-ground-truth performance or CP2 PASS**.
Padding favors speech preservation and correspondingly retains some gold-labelled non-speech.
No threshold tuning/train split claim is made; three related clips are insufficient for a robust
unbiased tuning/evaluation split. Independent human onset/offset agreement remains unproven.

A 60-second English clip took 581.098 ms including model initialization/normalization/inference
(RTF 0.009685), peak RSS 79462400 bytes; Arabic took 795.823 ms (RTF 0.013264), peak RSS
79527936 bytes. Producer: this environment's CPU, ORT 1.31.0, NumPy 2.4.6, one inference thread.
These are observations, not reference-machine guarantees or an SRS performance gate.

**PROJECT_GOLD_GATE: PASS. US202_AC1: PASS_UNDER_OWNER_APPROVED_PROJECT_GOLD. AC2: PASS.**
The existing [Owner decision](../../docs/evaluation/OWNER_DECISION.md) authorizes this exact
validated generated v1 baseline for project acceptance. Speech F1 **0.9803508856** exceeds
US-202's **0.9** threshold, subject to Independent QA reproducing the calculation and verifying
provenance. Missing/invalid Owner authority fails closed; the old `--allow-generated-baseline`
flag is only an alias for the same default project policy and cannot bypass validation or the
strict human-gold flag. A below-threshold speech result exits nonzero in either mode.

**HUMAN_GOLD_GATE: NOT_AVAILABLE. HUMAN_CREATED_GOLD: false. HUMAN_GOLD_COMPLETE: false.
INDEPENDENT_HUMAN_ACCURACY: NOT_PROVEN.** No manual annotation occurred. Generated agreement is
circular and does not prove independent boundary accuracy. That limitation does not add a new
human-gold prerequisite to the Owner-approved US-202 project acceptance policy.

**CP2_SILENCE_THRESHOLD: 0.9. CP2_SILENCE_ACTUAL: 0.742598. CP2_STATUS: NOT_MET.**
US-202 speech AC1 and CP2 silence F1 are different measurements. Even a generated-baseline
silence score above threshold would not establish the full CP2 quality gate.
Durable team storage remains the existing US-110 finding; no release completion is claimed.
**READY_FOR_INDEPENDENT_QA=YES** for this project acceptance result, pending exact-head QA.

Real-model tests synthesize a local English flite utterance through FFmpeg (supplemental,
never gold), exercise silence/mixed/low-volume/multi-window input, byte-repeatability,
8 kHz asymmetric stereo downmix, cancellation and timeout. CI runs them in normal `pnpm test`
after `pnpm build` and its existing FFmpeg install; inference itself is offline. Real licensed
English/Arabic data is exercised by the explicit evaluation command outside git.
US-216 remains BLOCKED_ON_CHROMIUM_SANDBOX and is untouched.
