# US-204 / CP2 silence qualification — Issue #43

Base main: `ebf9305c44f55972a77e40770630c6cff10044af` (merged PR #60).
Authority: [Issue #43, Technical Lead scope](https://github.com/mahmoudemad68/Your_Editor/issues/43#issuecomment-6370538641).
This is Coding Agent evidence. It is not an Independent QA verdict.
**CP2 remains NOT_MET; automatic silence removal is unqualified.**

## Classes and unchanged contracts

`acoustic_silence` means the existing FFmpeg `silencedetect` amplitude condition:
all input channels below the configured noise tolerance for the configured minimum
duration. Production defaults remain **−60 dBFS / 200,000 µs**. This describes a
signal condition, not the absence of meaningful content. Sufficiently quiet speech,
music or ambient audio can satisfy it. The mono waveform summary is not a silence
classifier; silence is measured before output downmix. The antiphase stereo probe
checks this distinction.

`non_speech` means the complement of the pinned Silero speech regions. It may
include audible music, noise, breaths, quiet/unrecognized speech, and acoustic
silence. No content class is inferred from amplitude alone. No NON_SPEECH interval
is converted to an acoustic label or an edit instruction.

MediaAnalysis 1.0.0/1.1.0 JSON Schemas and TS/Python readers are unchanged. The audio
`silence` field remains acoustic detector output in half-open **source** coordinates;
`speech` retains the existing US-202 schema and provenance. Completed analysis is
not permission to remove its ranges. No confidence or label-class property is
invented inside a frozen schema. This document clarifies the existing producers;
it does not replace the roadmap F1 ≥ 0.90 criterion or the canonical metric.

## Reproduced baseline and final measurements

Measurements on 2026-10-23 use the actual production `FFmpegAudioAnalyzer`, fixed
defaults, verified original source/scoped WAV bytes, and the unchanged generated
gold. No inference thresholds were selected from the diagnostic sweep.

| Benchmark                                     |     TP µs |   FP µs |      FN µs |    Precision |       Recall |           F1 before / after |
| --------------------------------------------- | --------: | ------: | ---------: | -----------: | -----------: | --------------------------: |
| Seven existing known acoustic-gap fixtures    | 5,750,000 |       0 |          0 |            1 |            1 |                       1 / 1 |
| Original Silero NON_SPEECH complement, pooled |   934,876 | 178,687 | 15,117,124 | 0.8395357964 | 0.0582404685 | 0.1089245951 / 0.1089245951 |

| Original clip         |   TP µs |  FP µs |     FN µs |
| --------------------- | ------: | -----: | --------: |
| commons-28956463 (EN) |       0 |      0 | 5,916,000 |
| commons-82236797 (AR) | 370,000 | 82,750 | 8,438,000 |
| commons-98650286 (EN) | 564,876 | 95,937 |   763,124 |

The diagnostic now includes exact TP/FP/FN source intervals, per-clip identities,
configuration and producer provenance. Independent Python endpoint integration
recomputes counts and ratios without importing the JS scorer; it rereads and hashes
the original sources, PCM and gold. Both implementations agree exactly.

One attributable scoring defect was corrected: summing pairwise intersections
double-counted overlapping/duplicate ranges. The canonical metric requires merged
unions. The scorer now validates and unions intervals before intersection and
difference. Exhaustive independent occupancy checks cover all 256 pairs of four-cell
sets, duplicates, touching ranges, empty conventions and times above JS safe integers.
This correction does **not** improve or otherwise change the valid original benchmark.

### Bounded sensitivity experiment (diagnostic only)

| Noise dBFS | Minimum ms |      TP µs |      FP µs |      FN µs |       F1 |
| ---------: | ---------: | ---------: | ---------: | ---------: | -------: |
|        −70 |        100 |    316,438 |     21,063 | 15,735,562 | 0.038615 |
|        −70 |        200 |    193,688 |     21,063 | 15,858,312 | 0.023814 |
|        −60 |        100 |  3,009,249 |  1,042,063 | 13,042,751 | 0.299378 |
|        −60 |        200 |    934,876 |    178,687 | 15,117,124 | 0.108925 |
|        −50 |        100 | 10,224,438 |  8,417,501 |  5,827,562 | 0.589408 |
|        −50 |        200 |  8,875,751 |  3,781,500 |  7,176,249 | 0.618320 |
|        −40 |        100 | 14,557,503 | 37,247,875 |  1,494,497 | 0.429062 |
|        −40 |        200 | 13,560,689 | 18,980,875 |  2,491,311 | 0.558127 |

All 38 NON_SPEECH intervals contain original PCM samples at or above −60 dBFS;
eight intervals are shorter than 200 ms. This establishes mismatched signal
conditions, not human labels for their actual content. The same generated word
gold overlaps NON_SPEECH by 9,568,000 µs. Predicted acoustic silence overlaps that
word gold by 774,625 µs (824,625 µs with 50 ms padding). These are temporal
diagnostics against generated word boundaries, not independent evidence that
each overlapping sample contains speech. They are sufficient reasons to protect
words instead of treating detector ranges as safe cuts.

## Original identities

Scopes remain `[30000000,90000000)` µs. Artifact byte hashes are verified against
the unchanged manifest and accepted Owner-generated provenance. Generated project
gold is **not independent human annotation**.

| Clip             | Original source SHA-256                                            | Scoped PCM SHA-256                                                 | Original silence gold SHA-256                                      |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| commons-28956463 | `843d6c653030056f26018be17b933fd6c739ef59ce0e128152f385bf2b38d1f6` | `397ea603aede161467fb085f8b178c670752ce5e5f3c72c6ad2cdf744c3e58a1` | `7f990d09069e66a9cb444cee5d082fa0d17a749f87abd7321d099ae45dd9e3c0` |
| commons-82236797 | `5f3eff8e19d9ea508f875082f177bd7dfdad70f56c03e0a33b6c8e5a7a2c0426` | `f00e74d3b739b32e8cc20d1cceee06968aa40c1f5a7f001c244ff0ad47a1c5f4` | `11f5bd5144ff391e9cd408058b5dda41c5f36dbbe7c727bcdbdb740baac38733` |
| commons-98650286 | `86cf8af3ceb93561358aebe34c7a5ad39fc522660f695c8b8c667d453d6f7117` | `e9d7e1f6bc82c09896540f068c08581e07dcddf6af893e486c7413247ce74d5c` | `5ef12f76d5897f724d7d616c9d3b5488c6ee5fa786093b274c3147930583f36d` |

Use the emitted verification report for exact scoped PCM identities: each is
checked independently. The manifest, word gold, model identities, normalization,
evaluation approval and protected artifacts are not modified by this batch.

## Safety boundary and coverage

`assertSafeAutomaticSilenceRemoval` in `@editagent/analysis-core` is a preparatory
**rejection boundary**, not a planner or edit operation. It permits an empty no-op.
Every nonempty request is rejected while CP2 is NOT_MET. There is no caller-supplied
qualification override. Before that rejection, it validates the source document,
acoustic producer, range containment, source bounds, ordered nonoverlap and exact
rational frame boundaries; no outward snapping is performed. Transcript words and
any existing VAD speech regions retain at least 50 ms padding. Missing transcript,
NON_SPEECH-only evidence, source mismatch and unsupported frame grids fail closed.
Metadata identity is not authorization; authenticated orchestration remains unchanged.
The older `assertOutsideProtectedWords` helper remains a narrow overlap check and
must not be treated as silence-removal qualification.

Real FFmpeg probes cover normal-level polyphonic tone, deterministic ambient noise,
antiphase stereo music-like content, subthreshold music, and attenuated licensed
EN/AR speech. Normal-level controls yield no silence. Subthreshold controls yield
whole-clip acoustic silence, but the consumer boundary rejects removal with either
missing or completed-empty transcript evidence. These are constructed risk probes,
not a human-labelled natural-music or quiet-speech accuracy benchmark. Licensed
speech parent hashes and adaptations are retained; original fixture bytes are unchanged.
Word/VAD padding, source rebasing, fractional-rate frame endpoints, malformed ranges,
missing sections and source mismatch also have portable regression coverage.

No US-223/224 routes, UI, timeline mutations, cut generation or rendering behavior
are implemented here. Existing browser-to-export and production service workflows
remain regression gates. A future automated consumer must use the rejection
boundary; adding one requires its own approved story and qualification.

## Reproduction and runtime limits

With pinned workspace dependencies, FFmpeg installed, Git LFS fixtures present and
the three original source/scoped PCM pairs available in a local directory:

```sh
pnpm --filter @editagent/analysis-core... build
pnpm --filter @editagent/media-core... build
pnpm audio:acceptance
pnpm audio:qualify --root /authorized/evaluation-inputs > qualification.json
python3 tools/audio/verify_metrics.py --report qualification.json --pcm-root /authorized/evaluation-inputs > independent-metrics.json
python3 -m unittest discover -s tools/audio -p 'test_*.py'
node --test tests/integration/audio-interval-metrics.test.mjs tests/integration/acoustic-silence-safety.test.mjs
```

Local measurements used Windows portable tests plus the existing Ubuntu WSL1
diagnostic environment (2 logical CPUs, ~7.75 GiB visible memory), Node 22.23.3 and
FFmpeg 7.1.5 compiled from the existing source archive
`de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`.
A separate diagnostic build enabled the required filters/PCM muxer; the pinned
evaluation decoder was preserved. This is not Docker/cgroup production-performance
qualification. Exact-head GitHub Linux workflows independently run the existing
acoustic acceptance and new real FFmpeg safety probes, plus all retained ASR,
real-service recovery and browser/export gates. Their final status must be checked
on the PR's immutable SHA; local success alone is insufficient.

## Remaining acceptance gap

The known acoustic fixtures pass, but original NON_SPEECH F1 remains below 0.90.
No representative independently established natural acoustic-silence label set
exists in the approved assets. Lowering this criterion, replacing original gold,
or calling louder NON_SPEECH music/noise “silence” would manufacture acceptance.
The safe next step is Technical Lead resolution of the acoustic-label qualification
plan and independent verification, with CP2 kept NOT_MET and automated removal
blocked. The Owner is not asked to annotate data or run tests.

The two published PR #60 Independent QA artifact ZIPs were archived locally and
verified against their published digests before 2026-11-06 expiry. Existing graduation
deliverables and held/unrelated workspace files remain excluded from this PR.
