# FFmpeg execution and audio analysis (US-220 / US-204)

`packages/media-core` owns production FFmpeg argv construction and execution. Application
code uses the framework-free `IAudioAnalyzer<TSection>` domain port. The adapter returns
the generated MediaAnalysis **1.1.0** `AudioCompleted` section, including schema-validated data and
section provenance. There is no analyzer scheduler, database persistence or API here.

## Execution boundary

`FfmpegBuilder.input(...).output(...).progress().build()` builds immutable argument arrays.
The typed filters currently exposed for audio are `silencedetect`, `ebur128`, and
`aresample`. Fixed video recipes additionally use scale/setsar/tpad/trim/setpts/fps,
atrim/asetpts/apad, pad/select/tile. Names, encoders, maps and formats are allowlisted;
there is no client-supplied graph, expression, executable or module. `escapeFilterValue`
handles filter-option and filtergraph parser layers; it is not shell escaping. No text
rendering feature is introduced.

Inputs must be controlled absolute local paths without controls or URLs. Their ownership,
realpath containment and authorization remain the staging adapter's responsibility;
this library is not an arbitrary-file access API. `-protocol_whitelist file` applies to
input decoding. Only an internally constructed output may use `pipe:1`, and progress uses
`pipe:3`; neither is a remote input capability. Network protocols, concat/crypto/data
inputs, raw graphs and caller-controlled output options are absent from the typed API.
The low-level executor accepts infrastructure-owned argv, never a job payload or shell text.

`FfmpegExecutor` defaults to one active process per instance and rejects admission when
busy. Concurrency is explicitly bounded to 1–4, codec threads to two and filter threads to
one. It bounds deadlines (maximum 30 minutes), captured diagnostics (maximum 16 MiB),
streamed output bytes and progress buffering. Callers must reuse the configured executor;
creating unlimited instances is not a scheduling strategy. Errors use bounded codes, not
raw diagnostics/paths. Child environments contain only PATH and the fixed locale (plus
the existing explicit sandbox limits); storage credentials are not inherited. Callers' existing structured job logs retain correlation identity.

Abort/deadline/consumer failure sends SIGTERM then SIGKILL after 150 ms. Standalone calls
own a process group; supervised worker calls retain the existing US-129 group so crash
reaping still works. Promises settle after process close; listeners/timers are removed.
The native US-127 broker remains mandatory for hostile-upload decode checks, retaining
its seccomp/filesystem/network protections, limits and parent-death handling. FFprobe
keeps its existing independent adapter.

## Migration inventory and lint

Production paths moved into media-core:

- US-128 derivative recipes and process execution; signatures, keys, encoder settings,
  dimensions, timestamps and output formats remain unchanged.
- US-127 decode recipe and execution through its existing native sandbox (the
  byte-identical C source now belongs to media-core; installed binary path is unchanged). FFprobe and
  sandbox capability checks remain owned by the validation adapter.
- US-202 optional noncanonical WAV normalization: the small Python media-core module is
  included in the AI-worker wheel. Canonical ASR WAV still needs no subprocess. Silero,
  model/configuration and VAD algorithms are unchanged.

`node tools/architecture/ffmpeg-boundary.mjs` runs in both root lint and architecture.
It forbids new subprocess owners outside media-core and direct FFmpeg calls even in
explicitly reviewed process-owner exceptions. Those exceptions are the FFprobe sandbox
broker, existing job supervision/sample lifecycle handlers and Python queue subprocess
transport. Tests, fixture generation, tools/evaluation, benchmarks and image-build/verification
scripts are excluded deliberately; they are not production processing paths. Shell-based
image checks operate on fixed infrastructure arguments and accept no job command text.

Proxy uses the frozen US-128 recipe. Preview is letterboxed 640×360 H.264/AAC; social
1080p is letterboxed 1920×1080 H.264/AAC, both with square pixels and MP4 faststart.
No existing derivative output policy is replaced by these new presets.

## Analysis configuration and units

`FFmpegAudioAnalyzer` accepts a verified staged WAV plus source/input SHA-256, artifact
identity and integer microsecond duration. It hashes input incrementally, enforces a
2 GiB staged-audio adapter bound and the existing 30-minute media limit, fixes `LC_ALL=C`,
and records the actual FFmpeg version. The configuration fingerprint covers every
output-affecting analyzer setting and the waveform policy.

Default configuration:

| Setting          | Default                                           |
| ---------------- | ------------------------------------------------- |
| silenceNoiseDb   | -60 dB (FFmpeg's documented conservative default) |
| minimumSilenceUs | 200000                                            |
| bucketUs         | 100000                                            |
| sampleRate       | 48000                                             |
| timeoutMs        | 120000                                            |

All settings are constructor configuration, validated before processing. The initial
-35 dB diagnostic was too aggressive on quiet project audio; the final -60 dB default
was selected for preservation, with a separate quiet-tone regression. This change followed
inspection of the small evaluation set; neither score is an unbiased held-out estimate.
No search for a passing threshold or alteration of gold was performed.

Silencedetect measures amplitude silence, not semantic non-speech. Its all-channel
semantics and EBU loudness operate on the original WAV channels before output downmix.
A successful duration-verified decode closes a valid trailing silence at input end;
malformed starts/ends, overlap, nonfinite values or inconsistent duration fail. Times
parse as decimal digits with nearest-microsecond rounding (ties away from zero), without
floating-point seconds. Scoped input is rebased exactly once via `scopeStartUs` into
source coordinates and checked against `sourceDurationUs`.

EBU R128 integrated LUFS, LRA and true peak come from its final summary. Short-term
3-second EBU loudness is sampled at the first FFmpeg measurement in each 1-second
bucket. `shortTermLoudness` is an optional additive AudioAnalysis field introduced in
**MediaAnalysis 1.1.0**. The published 1.0.0 graph and readers are preserved byte-for-byte
and reject this field. Exact-version readers, dispatch and pure 1.0.0 → 1.1.0 migration
are documented in [the contract](../contracts/media-analysis.md). The analyzer exports
`AUDIO_ANALYSIS_SCHEMA_VERSION = "1.1.0"` for producers assembling its section into a root
document. Unknown versions and fields fail closed. Digital-silence true peak (-infinity mathematically) uses the documented -200 dBTP
floor. Other nonfinite/missing measurements fail.

PCM is streamed as mono float32 at the configured rate (FFmpeg's deterministic downmix
and resampling). No complete decoded audio is loaded. RMS and waveform buckets use a
fixed integer sample count: `bucketUs * sampleRate / 1000000` must be integral. `atUs`
is bucket start in source coordinates; the final partial bucket uses actual sample count.
RMS is `10 log10(mean(sample²))` dBFS, floored at -200 and capped at 0. Peaks are bucket
minimum/maximum, clipped to [-1,1] only for the normalized waveform contract. There are at
most 18,000 buckets for a 30-minute input with the minimum 100 ms window.

## Tests and evaluation

```sh
pnpm build
pnpm --filter @editagent/media-core test
pnpm schemas:test
pnpm audio:acceptance
pnpm audio:evaluate --root .local/evaluation
node tools/test/with-services.mjs pnpm --filter @editagent/media-worker test
```

The real calibrated fixture is a 10-second mono 48 kHz, 1 kHz sine at 0.1 peak amplitude.
Its reference is computed before inference from the ITU BS.1770 K-weighting coefficients:
`-0.691 + 10 log10(A²/2 × |H_shelf(1kHz)|² × |H_highpass(1kHz)|²)`.
Reference: -23.00359556055 LUFS; measured: -23.0 LUFS; absolute error: 0.00359556055 LU.
The test enforces the roadmap's 0.5 LU tolerance, not a reference fitted to FFmpeg output.

`pnpm audio:acceptance` exercises the production analyzer with seven deterministic mono
48 kHz PCM16 WAV fixtures. Fixed sample blocks define the gold before inference: square-wave
non-silence, exact digital-zero gaps and a quiet nonzero signal above -60 dB. Cases cover
no silence, an internal gap, multiple gaps, trailing silence, touching boundaries, a
100 ms subminimum gap excluded from detectable-gold expectations, and quiet non-silence.
No labels come from detector output; no randomness or threshold tuning is used. Exact
sample counts define integer-us half-open boundaries, with no tolerance collar. Pooled
TP = 5,750,000 us, FP = 0, FN = 0; precision = recall = F1 = **1.0**. Every individual
case also passes, including the empty-prediction negative controls. **US-204 AC1 passes
on these known acoustic-silence fixtures** (threshold 0.90); this is implementation
acceptance evidence, not independent natural-speech accuracy. The root integration suite
runs the real FFmpeg fixture test. The machine-readable command reports gold, predictions,
fixture hashes and the same canonical duration-overlap metric used below.

`pnpm audio:evaluate --root .local/evaluation` is separately a
**PROJECT_GOLD_DIAGNOSTIC**, not the acoustic fixture acceptance score. It validates the
full US-110 provenance policy first, then verifies
licensed source and scoped PCM identities. It runs the production analyzer and compares
only approved scopes using the existing metric registry: half-open integer-us overlap,
no collar, and pooled TP/FP/FN before precision/recall/F1. Missing/invalid assets fail,
rather than skipping. No labels are generated or changed.

For the unchanged three Owner-approved v1 clips, final defaults measured:

| TP us  | FP us  | FN us    | Precision | Recall   | F1       |
| ------ | ------ | -------- | --------- | -------- | -------- |
| 934876 | 178687 | 15117124 | 0.839536  | 0.058240 | 0.108925 |

**PROJECT_GOLD_DIAGNOSTIC_F1 = 0.10892459513270844**. The approved generated labels
are the complement of Silero VAD speech and represent **non-speech**, whereas
silencedetect measures **acoustic amplitude silence**. Their disagreement must remain
visible; these labels are not independently verified acoustic-silence truth. The v1
labels remain `machine_generated` under the unchanged Owner decision. No gold or
threshold was changed to improve this score. **CP2 remains NOT_MET**, and **independent
human accuracy remains NOT_PROVEN**. US-202's accepted result is unchanged. The diagnostic
command reports these statuses separately and never uses this score as fixture AC1.

There is no production rendering, VAD replacement, silence-removal editing or analysis
orchestration in this batch. US-216 remains BLOCKED_ON_CHROMIUM_SANDBOX.
