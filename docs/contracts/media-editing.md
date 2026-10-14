# FFmpeg strategy and editing tools (US-218 / US-222)

## Render selection

The existing `render.remotion` job and `IRenderStrategy` contract remain unchanged.
`SelectingRenderStrategy` chooses FFmpeg for one active video track with at most eight
clips, video sources, cut joins, unit opacity/gain, no effects, and source/placement
boundaries on the composition's rational frame grid. Empty tracks are harmless.
Logical timeline ends must also lie on that grid. For example, at 30 fps a source
333333–666667 us placed at 100000 us ends at 433334 us, one microsecond past frame
13; it retains Remotion's canonical sampling rather than silently shortening the clip.
Fixtures, captions, graphics, audio/overlay layers, dissolves, off-grid ranges and larger
timelines retain Remotion. These are strategy eligibility limits, not new Timeline limits.
There is no caller-selected fast-path flag.
After checksum staging, a bounded FFprobe capability check further limits the fast path
to progressive, square-pixel, constant-cadence, 8-bit SDR H.264 sources at the composition's exact rational rate. Variable/unknown
cadence, rotation, HDR/alpha, non-square pixels and other codecs use Remotion. This
transient check does not change published media metadata or persisted schemas.
Different source cadences also use Remotion; this batch does not claim untested cadence-conversion parity.

Both adapters share project-scoped asset resolution, checksum staging, application
version identity, full MP4 decoding/FFprobe validation, conditional storage, durable job
state and cancellation. FFmpeg runs in the existing credential-free, networkless executor,
not the credentialed coordinator. Its child is supervised with PID/start-time ownership
and escalation. The Chromium Owner exception, seccomp/capability restrictions, filesystem,
PID, memory and CPU limits are unchanged. Issue #50 remains a documented inherited risk.

Cut recipes normalize cadence before integer frame-index trimming, reset timestamps,
contain/center each video, represent gaps explicitly and set exact rational encoder
timebases. Audio uses a 48 kHz stereo clock; global boundary sample differences avoid
accumulated rounding drift. Missing clip audio becomes digital silence when the timeline
otherwise has audio. Five-millisecond **non-overlapping** ramps soften joins without
shortening the timeline; Remotion retains its existing hard audio cuts. Audio waveforms
therefore need not be byte-identical across strategies. Neither path changes stored
source timing. Output is H.264/yuv420p MP4 with AAC when audio exists.

Each media segment has its own demuxer/decoder, including backward and repeated
references. Audio sample boundaries come directly from the rational frame clock
at 48 kHz. Join ramps use bounded sample-count fades followed by non-overlapping
audio concat; chained `acrossfade` is not used for short cuts. The MP4 movie clock
is also 48 kHz so its edit list does not round sample duration to milliseconds.

Output and cached-artifact validation obtains expected audio presence from
authorized source metadata, independently checked on staged bytes by the
executor. It checks stream start clocks, exact video timing and decoded frame
count, expected AAC stereo/48 kHz presence, logical audio duration and a full
streaming PCM decode. Audio shortfall greater than one rounded sample is rejected.
AAC packet/decoded padding is bounded separately to 1023 samples; it is not a
general A/V-duration tolerance. Canonical artifact duration remains the rational
video-frame duration, not packet padding. Spatial transforms require an
independently decoded CFR frame census, regardless of source length or render
strategy eligibility. Other transforms retain their existing timing policy;
genuinely audio-led duration is not discarded.

The CFR capability probe selects video before its bounded 128-packet window,
uses complete decoder frame evidence (excluding flush tails), orders presentation
timestamps and verifies cadence against the rational stream clock. Rotation,
HDR, unsupported codecs/formats and genuine VFR remain outside the fast path.

## Seven registered tools

The SDK naming convention remains `namespace.hyphenated-name`, version `1.0.0`:

| Operation       | Registered name         | Resource | Result                    |
| --------------- | ----------------------- | -------- | ------------------------- |
| trim_video      | editing.trim-video      | timeline | TrimClip proposal         |
| split_video     | editing.split-video     | timeline | SplitClip proposal        |
| concat_clips    | editing.concat-clips    | project  | edited-video DerivedAsset |
| crop_video      | editing.crop-video      | asset    | edited-video DerivedAsset |
| resize_video    | editing.resize-video    | asset    | edited-video DerivedAsset |
| change_speed    | editing.change-speed    | asset    | edited-video DerivedAsset |
| normalize_audio | editing.normalize-audio | asset    | edited-video DerivedAsset |

`packages/tool-sdk/src/editing-tools.ts` owns versioned manifests and strict input/output
schemas. Registry discovery and LLM function export use those same schemas. The small
schema subset additionally admits positive integer `multipleOf` divisors for even pixel
geometry; unsupported/invalid divisors fail schema compilation. Source-dependent rules
still require the authoritative adapter/domain, rather than pretending a JSON schema can
know asset duration or pixels.

Trim/split use the authoritative canonical Timeline, explicit nearest-frame snapping,
existing reversible commands and deterministic execution-derived fragment IDs. The result
includes a basis SHA-256. They propose edits; they do not automatically persist or render
an edited timeline. `EditingTimelines` is a validated snapshot/CAS persistence boundary
for authenticated application callers, with no new API or orchestration service.
Trim `startUs`/`endUs` and split `atUs` are absolute timeline coordinates. Concat
`startUs`/`endUs` are source coordinates. All are canonical decimal-string microseconds;
no seconds or playback-rate changes are introduced into persisted Timeline commands.

Media tools require current Owner/Editor `render.create` and asset ownership for every
input. They use the existing `tool.execute.v1` / `tools-render-v1` BullMQ infrastructure,
durable admissions/outbox/audits and cleanup acknowledgments. There are no arbitrary paths,
URLs, object keys, filters, modules or executable code in their inputs. Concatenation takes
up to eight ranges in explicit order, including repeated references to the same source.
Crop is an even pixel rectangle within the source; resize preserves aspect ratio with
black padding. Speed is a bounded rational 1/4–4 transformation into **new media**, with
audio tempo adjustment; the Timeline playback model stays 1:1. Normalization uses two-pass
measured loudnorm with explicit target LUFS/true-peak/range. Missing or non-finite loudness
measurements fail instead of fabricating a normalization result.
This version's normalization tool accepts a video source with an audio stream and
preserves its video. Audio-only sources and silent/unmeasurable normalization inputs
fail as permanent invalid inputs. Repeated concat references must have disjoint ranges.

## Immutable output and accounting

Migration 0018 adds the explicit `edited-video` DerivedAsset kind. Existing proxy/audio/
thumbnail keys and formats remain unchanged. New keys are
`projects/<project>/derived/<root-media-id>/edited-video/<parameter-signature>/<content-sha>.mp4`.
The signature binds logical execution, operation/configuration, render application version
and resolved source identities. Chained edits retain the original root for the foreign key,
while provenance names actual immediate source IDs and hashes. Rendering can resolve an
owned edited-video UUID as a source; it is not reclassified as an uploaded MediaAsset.

An immutable PostgreSQL publication intent records the exact descriptor before upload.
A per-execution advisory lock prevents concurrent producers. Retrying an uploaded but
unacknowledged result verifies its SHA/size and fully decodes it before recovering the
single DerivedAsset. Missing output is regenerated at that same identity; different bytes
fail closed. Immediately before database publication, a transaction fences the running job,
audit, deadline, project and current membership. Cancellation cleans owned work and never
changes source bytes. A cancellation after a valid committed publication can leave that
authorized immutable artifact; it cannot turn the durable Cancelled job into Completed.

The default successful logical media call settles 1000 cost micros once, including retries;
timeline proposals cost zero. Both the fixed price and per-project ledger cap are typed
configuration (`EDITAGENT_EDITING_COST_MICROS`, default 1000;
`EDITAGENT_EDITING_PROJECT_BUDGET_MICROS`, default 1000000). These are project accounting
units, not invented measured CPU/API expenditure. Existing uncertain-failure reservation
semantics and Issue #51 remain unchanged. The worker alternates render and tool queues with
one active isolated executor, so internal FFmpeg/Remotion concurrency cannot multiply an
unbounded number of concurrent jobs.

## FFmpeg boundary and tests

Issue #44's filter-name-only validation is replaced with per-filter allowed options and
bounded values, including exact admitted legacy US-128 expressions. Protocol-shaped local
path components fail early, in addition to file-only protocol and network-disabled binary
controls. New filter capabilities are compiled explicitly into the hardened media binary;
network protocols/demuxers remain disabled. No shell is introduced.

Run `pnpm render:test` for the actual production containers, PostgreSQL, Redis/BullMQ, S3,
Chromium, FFmpeg and independent host FFprobe/decoded-frame checks. It includes all seven
tools, current-role and cross-project denial, known per-frame native fixtures at 25, 30 and
30000/1001 fps, strategy comparison, measured normalization, storage/publication failure
retries and active cancellation. Existing MP4, emoji, golden timeline and security proofs
remain in that command. Artifacts and machine-readable evidence are local under
`.local/render-batch` and uploaded by required CI. Run package tests for deterministic
recipe, protocol/filter rejection, frame-snapped proposals and replay regressions.

No US-110 annotations, US-202 settings, CP2 status, or Issues #43/#50/#51 are repaired here.
This batch adds no API, autonomous agent, transcription, scene/face detection or deployment.

### Spatial-edit stream clocks (QA53R-2)

Crop and resize preserve the inspected CFR video frame count and the independent
source audio end. An audio-led MP4 is valid: the final video frame ends normally
while genuine audio continues. A shorter audio stream stays shorter; these edits
never append silence to cover the video. No `-shortest` or video-derived audio
trim is used. Audio is normalized to stereo 48 kHz and bounded by the inspected
stream start plus duration, converted with integer rational rounding. Positive
source audio start offsets retain their timestamp through bounded normalization.
Missing or inconsistent source timing fails closed.

New derivative metadata records `videoFrames`, `videoDurationUs` and
`audioSamples` (the logical 48-kHz count before AAC packet padding).
`durationUs` is the longer logical stream duration, excluding AAC padding. Old
metadata remains structurally readable, but spatial cache reuse requires both
explicit clocks and `sourceVideoFrames` with `spatialFrameCountBasis=decoded_cfr_v1`.
The output count must equal the verified source count; an older stretched or
truncated descriptor cannot establish spatial integrity.
The immutable render build identity separates new producers from earlier output
intents. Fresh and cached files must independently pass exact video-frame checks,
logical audio-duration checks and complete decoded sample coverage. AAC's bounded
1024-sample packet padding does not excuse a missing source tail.

`tests/integration/spatial-audio-integrity.test.mjs` and the production
`pnpm render:test` path exercise audio-shorter/equal/longer fixtures at 25, 30,
30000/1001, 24000/1001 and 60000/1001 fps. Gold sample counts and audio events are
sample-authored before encoding. The 179-frame regression includes 310656 logical
audio samples and genuine markers at 6.005 and 6.335 seconds. Decoded PCM markers
also reject same-length silence replacement in this regression suite; runtime
sample-count validation does not claim universal semantic audio equivalence.
Speed and normalization retain their prior duration and padding policy.

### Short spatial sources (QA53R-3)

One-, two- and three-frame CFR sources are supported independently of the fast
render selector's minimum cadence evidence. FFprobe decodes the complete video
stream under one-thread, 108000-frame, 30-minute, 16-MiB-output and job-cancellation
bounds. The frame census must agree with stream timebase, rational FPS, declared
duration, every actual presentation timestamp and frame duration. A missing
header frame count can be established by the decoded census; contradictory
metadata, missing timing or VFR fails permanently with sanitized `invalid_input`.
Crop/resize never estimate frames from the asset clock and never pad video.

The real regression matrix includes each short length at all five rates with
no audio, shorter audio, equal audio and 0.4-second audio. Both tools verify
decoded frame identity/count, independent audio samples and authored events,
source hashes, terminal jobs/audits, immutable publication and cache rejection.
