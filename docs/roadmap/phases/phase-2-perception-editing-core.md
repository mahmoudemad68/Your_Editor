<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# PH2 - Perception Engine and Editing Core

| Sprints | Duration | Release / increment | Scope | Planned points | Milestones |
|---|---|---|---|---|---|
| Sprint 3, Sprint 4 | Weeks 5-8 | v0.2 "Understand and Cut" | mvp | 99 SP (24 stories, 1 stretch) | CP2 Perception Quality Gate, M2 v0.2 Understand and Cut |

[Roadmap overview](../README.md) | [Sprint plan](../sprints.md) | [Dependencies](../dependencies.md) | [Milestones](../milestones.md)

## 1. Objective

Give the system a structured, versioned and cached understanding of raw footage (speech, audio and visual perception unified into one MediaAnalysis document), and in parallel build the editing core it will act on - a serializable timeline domain with undo/redo commands, a render engine with FFmpeg and Remotion strategies behind one interface, and the Editing Tool SDK. The phase is proven by the first automated, non-AI edit - one-click silence removal executed through the Tool SDK and rendered to MP4. Covers original Phases 3, 4 (core) and 5 (core), and runs perception and editing-core work in parallel lanes instead of sequentially.

## 2. Epics

| Epic | Goal | Sprints | Points | Depends on | Can run in parallel with |
|---|---|---|---|---|---|
| [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding) Speech Understanding | Produce accurate, word-timed transcripts and speech segmentation that editing decisions can trust. | S3, S4 | 14 | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core) | [EP-07](phase-2-perception-editing-core.md#ep-07---audio-understanding), [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model) |
| [EP-07](phase-2-perception-editing-core.md#ep-07---audio-understanding) Audio Understanding | Measure the audio signal so the editor can cut, balance and evaluate sound objectively. | S3 | 5 | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core) | [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding), [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis), [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model) |
| [EP-08](phase-2-perception-editing-core.md#ep-08---visual-understanding) Visual Understanding | Understand shots and people on screen so that cuts and framing respect the picture. | S4 | 11 | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core), [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis) | - |
| [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis) Unified Media Analysis | Merge all perception outputs into one versioned, schema-validated MediaAnalysis document per asset. | S3, S4 | 18 | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core), [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding), [EP-08](phase-2-perception-editing-core.md#ep-08---visual-understanding) | [EP-07](phase-2-perception-editing-core.md#ep-07---audio-understanding), [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model) |
| [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model) Editing Project Model | Represent every edit as structured, serializable, undoable project state rather than only an output file. | S3 | 10 | [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline) | [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding), [EP-07](phase-2-perception-editing-core.md#ep-07---audio-understanding), [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis) |
| [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine) Rendering Engine | Render any timeline through interchangeable render strategies with progress and validation. | S3, S4 | 15 | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing), [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations) | - |
| [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations) Editing Tool SDK and Media Operations | Expose editing capabilities to automation and AI only through typed, validated, permissioned and extensible tools. | S3, S4 | 26 | [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core), [EP-07](phase-2-perception-editing-core.md#ep-07---audio-understanding), [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis), [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine) | - |

## 3-6. Features, User Stories, Technical Tasks and Acceptance Criteria

Task tags: `TEST`, `DOC`, `CI/CD`, `SECURITY`, `INTEGRATION` mark testing, documentation, CI/CD, security and integration work that is built into the story itself. Every story is also subject to the global [story Definition of Done](../README.md#definition-of-done-story-level).

### EP-06 - Speech Understanding

**Epic goal:** Produce accurate, word-timed transcripts and speech segmentation that editing decisions can trust.

#### FT-06.1 - Transcription and Speech Segmentation

##### US-201 - Word-level transcription with Faster-Whisper

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 8 | Sprint 3 | AI / Agent Engineer | [US-105](phase-1-foundation.md#us-105---asr-and-vad-feasibility-spike), [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation), [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI video editor, I want accurate word timestamps, language and confidence for all speech, so that I can cut on word boundaries and synchronize captions precisely.

**Technical tasks**

- [ ] `US-201-T1` Define the ITranscriber port and a FasterWhisperAdapter (configurable model, device, compute type; CPU int8 fallback)
- [ ] `US-201-T2` Enable word-level timestamps, per-word probability and automatic language detection with confidence
- [ ] `US-201-T3` Use Silero VAD filtering and chunked processing for long files with deterministic segment merging
- [ ] `US-201-T4` Map output to the Transcript, Segment and Word schema types and record model name, version and parameters as provenance
- [ ] `US-201-T5` Implement the transcription job handler in ai-worker with progress reporting
- [ ] `US-201-T6` `TEST` Fixture tests for timestamps monotonicity and WER against hand-aligned clips
- [ ] `US-201-T7` `INTEGRATION` Nightly GPU test with the production model; PR CI uses the tiny int8 model

**Acceptance criteria**

- [ ] AC1. Given a 10-minute English clip, when transcribed, then every word has start, end and confidence and the WER is at most 12 percent on evaluation clips
- [ ] AC2. Language is detected automatically and Arabic results are measured and recorded
- [ ] AC3. The same input and model version produce identical output (deterministic settings)

##### US-202 - Voice activity detection and speech segmentation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 3 | AI / Agent Engineer | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI video editor, I want precise speech and non-speech regions, so that silence removal never cuts into speech.

**Technical tasks**

- [ ] `US-202-T1` Implement IVoiceActivityDetector with a Silero VAD adapter and configurable thresholds and padding
- [ ] `US-202-T2` Output speech regions with confidence into the analysis schema
- [ ] `US-202-T3` `TEST` Compare against labelled ranges and report precision and recall

**Acceptance criteria**

- [ ] AC1. Speech-region F1 is at least 0.9 on the labelled evaluation clips
- [ ] AC2. Thresholds are configuration values, not constants in code

#### FT-06.2 - Disfluency Detection

##### US-203 - Filler-word and repetition detection

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 4 | AI / Agent Engineer | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI video editor, I want filler words, false starts and repeated phrases marked in the transcript, so that I can remove them cleanly.

**Technical tasks**

- [ ] `US-203-T1` Build per-language filler lexicons (English and Arabic) loaded from data files
- [ ] `US-203-T2` Detect repeated n-grams and restarts within a sliding window using word timestamps
- [ ] `US-203-T3` Emit tagged spans with type and confidence in the analysis document
- [ ] `US-203-T4` `TEST` Unit tests on synthetic transcripts and one labelled real clip

**Acceptance criteria**

- [ ] AC1. Filler spans are word-aligned and never split a non-filler word
- [ ] AC2. Precision is at least 0.85 on the labelled clip

### EP-07 - Audio Understanding

**Epic goal:** Measure the audio signal so the editor can cut, balance and evaluate sound objectively.

#### FT-07.1 - Audio Metrics

##### US-204 - Silence, loudness, peak and energy analysis

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 3 | Multimedia Engineer | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI video editor, I want silence ranges, loudness and energy over time, so that I can remove dead air and balance audio to platform targets.

**Technical tasks**

- [ ] `US-204-T1` Define IAudioAnalyzer and implement FFmpeg silencedetect and ebur128 analysis (integrated LUFS, short-term loudness, true peak, loudness range)
- [ ] `US-204-T2` Compute a downsampled RMS energy curve and peak list
- [ ] `US-204-T3` Generate waveform peak data for the UI
- [ ] `US-204-T4` Write results to the AudioAnalysis section with provenance
- [ ] `US-204-T5` `TEST` Fixture tests with known silence gaps and a calibrated loudness tone

**Acceptance criteria**

- [ ] AC1. Silence detection F1 is at least 0.9 against labelled ranges
- [ ] AC2. Integrated loudness of the calibration fixture is within 0.5 LU of the reference value

#### FT-07.2 - Audio Classification

##### US-205 - Speech, music and noise classification

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P2 - Could (advanced) | 3 | Stretch | Multimedia Engineer | [US-204](phase-2-perception-editing-core.md#us-204---silence-loudness-peak-and-energy-analysis) | Stretch backlog |

**User story:** As an AI video editor, I want to know where music, speech and background noise occur, so that I can avoid cutting music abruptly and detect noisy sections.

**Technical tasks**

- [ ] `US-205-T1` Integrate a pretrained audio event classifier (YAMNet or PANNs) behind IAudioClassifier
- [ ] `US-205-T2` Output labelled segments and a noise-floor estimate
- [ ] `US-205-T3` `TEST` Fixture test with speech-over-music and noise segments

**Acceptance criteria**

- [ ] AC1. Speech, music and noise segments are labelled with confidence on the fixture
- [ ] AC2. The classifier can be replaced by another adapter without changing consumers

### EP-08 - Visual Understanding

**Epic goal:** Understand shots and people on screen so that cuts and framing respect the picture.

#### FT-08.1 - Shot and Scene Detection

##### US-206 - Shot and scene boundary detection

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 4 | Multimedia Engineer | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation), [US-208](phase-2-perception-editing-core.md#us-208---versioned-mediaanalysis-json-schema-with-generated-bindings) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI video editor, I want shot boundaries, so that I avoid cutting in the middle of camera movements and can align transitions.

**Technical tasks**

- [ ] `US-206-T1` Implement ISceneDetector with a PySceneDetect adapter (content and adaptive detectors) on the proxy
- [ ] `US-206-T2` Output shots with start, end, confidence and a representative keyframe
- [ ] `US-206-T3` `TEST` Fixture test with known hard cuts and a fade

**Acceptance criteria**

- [ ] AC1. All hard cuts in the fixture are detected within 2 frames
- [ ] AC2. Detector thresholds are configurable per analysis request

#### FT-08.2 - Face Detection and Tracking

##### US-207 - Face detection and tracking

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 8 | Sprint 4 | AI / Agent Engineer | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation), [US-208](phase-2-perception-editing-core.md#us-208---versioned-mediaanalysis-json-schema-with-generated-bindings) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI video editor, I want face positions tracked over time, so that I can reframe to vertical formats and avoid covering faces with graphics.

**Technical tasks**

- [ ] `US-207-T1` Define IFaceDetector and IFaceTracker; implement a detector adapter (MediaPipe or SCRFD) on sampled proxy frames
- [ ] `US-207-T2` Implement IoU/ByteTrack tracking with stable track IDs and temporal smoothing
- [ ] `US-207-T3` Output per-track bounding boxes over time normalized to source resolution
- [ ] `US-207-T4` Support GPU and CPU execution with a configurable sampling rate
- [ ] `US-207-T5` `TEST` Fixture tests with one and two speakers measuring track continuity

**Acceptance criteria**

- [ ] AC1. Faces in the two-speaker fixture keep stable track IDs across the clip
- [ ] AC2. Boxes are normalized to source coordinates, including rotated sources
- [ ] AC3. A 10-minute video is processed in under 5 minutes on the reference GPU

### EP-09 - Unified Media Analysis

**Epic goal:** Merge all perception outputs into one versioned, schema-validated MediaAnalysis document per asset.

#### FT-09.1 - Cross-Language Contracts and Test Harness

##### US-208 - Versioned MediaAnalysis JSON Schema with generated bindings

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 3 | DevOps & QA (shared) | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) | Parallel - can start on day 1 of the sprint |

**User story:** As a developer on any worker, I want one versioned schema for analysis results, so that Python analyzers and TypeScript consumers cannot drift apart.

**Technical tasks**

- [ ] `US-208-T1` Author JSON Schemas in packages/schemas for transcript, scenes, faces, objects, audio, metadata and provenance
- [ ] `US-208-T2` Generate zod (TS) and pydantic (Python) types in the build and fail CI on uncommitted drift
- [ ] `US-208-T3` Define the schema versioning and migration policy (semver, additive changes only within a major version)
- [ ] `US-208-T4` `TEST` Contract tests validating sample documents in both languages
- [ ] `US-208-T5` `DOC` Document the schema and the versioning policy

**Acceptance criteria**

- [ ] AC1. Changing a schema without regenerating bindings fails CI
- [ ] AC2. A document produced by Python validates in TypeScript and vice versa

##### US-209 - Worker integration test harness and GPU test strategy

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 3 | DevOps & QA (shared) | [US-116](phase-1-foundation.md#us-116---test-frameworks-fixtures-and-integration-harness) | Parallel - can start on day 1 of the sprint |

**User story:** As a developer, I want integration tests that exercise workers through the real queue and storage, so that cross-service bugs are caught before merge.

**Technical tasks**

- [ ] `US-209-T1` Build a harness that enqueues a job, runs the worker in a container and asserts outputs in storage and database
- [ ] `US-209-T2` `CI/CD` Tag tests as cpu or gpu; run cpu in PR CI and gpu nightly on a self-hosted runner
- [ ] `US-209-T3` `CI/CD` Cache model weights between CI runs
- [ ] `US-209-T4` `DOC` Document how to write a worker integration test

**Acceptance criteria**

- [ ] AC1. Transcription and audio analysis integration tests run in PR CI on CPU in under 5 minutes
- [ ] AC2. The nightly GPU job reports results to the team channel

#### FT-09.2 - Analysis Orchestration

##### US-210 - Analysis orchestration and aggregation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 3 | Multimedia Engineer | [US-208](phase-2-perception-editing-core.md#us-208---versioned-mediaanalysis-json-schema-with-generated-bindings), [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) | Sequential after US-208 (same sprint; contract-first stubs allowed) |

**User story:** As the system, I want every uploaded asset analysed by all analyzers and merged into one MediaAnalysis, so that the agent has a single source of understanding.

**Technical tasks**

- [ ] `US-210-T1` Trigger analyzer jobs automatically after proxy and audio extraction complete
- [ ] `US-210-T2` Aggregate analyzer results into a versioned MediaAnalysis document stored per asset
- [ ] `US-210-T3` Handle partial failure (document marks missing sections with reasons) and allow re-running one analyzer
- [ ] `US-210-T4` Expose GET /media/{id}/analysis
- [ ] `US-210-T5` `TEST` Integration test covering success, one-analyzer failure and re-run

**Acceptance criteria**

- [ ] AC1. An upload produces a MediaAnalysis document that validates against the schema
- [ ] AC2. If one analyzer fails, the others still complete and the document records the failure

#### FT-09.3 - Analysis Experience in the Web App

##### US-211 - Frame-accurate video player component

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 3 | Frontend Engineer | [US-125](phase-1-foundation.md#us-125---media-library-with-thumbnails-and-proxy-playback) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want a precise player with frame stepping, so that I can review exactly what the AI understood and changed.

**Technical tasks**

- [ ] `US-211-T1` Build a reusable player on the proxy with frame stepping, keyboard shortcuts and timecode display
- [ ] `US-211-T2` Expose a seek and time-update API for synchronized panels
- [ ] `US-211-T3` `TEST` Component tests for seeking and time updates

**Acceptance criteria**

- [ ] AC1. Frame stepping moves exactly one frame at the proxy frame rate
- [ ] AC2. Other components can subscribe to the current time

##### US-212 - Synchronized transcript viewer

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 3 | Frontend Engineer | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper), [US-211](phase-2-perception-editing-core.md#us-211---frame-accurate-video-player-component) | Sequential after US-201, US-211 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to read the transcript in sync with the video, so that I can verify what was said and navigate by words.

**Technical tasks**

- [ ] `US-212-T1` Render transcript segments with active-word highlighting during playback
- [ ] `US-212-T2` Click a word to seek; show low-confidence words distinctly
- [ ] `US-212-T3` Virtualize the list for long transcripts
- [ ] `US-212-T4` `TEST` Component tests and an E2E check on the fixture

**Acceptance criteria**

- [ ] AC1. Clicking a word seeks within one frame of its start time
- [ ] AC2. A 60-minute transcript scrolls smoothly

##### US-213 - Analysis overview panels

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 4 | Frontend Engineer | [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation), [US-206](phase-2-perception-editing-core.md#us-206---shot-and-scene-boundary-detection), [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) | Sequential after US-206, US-207 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to see silences, shots, faces and filler words on a time ruler, so that I understand the footage before editing.

**Technical tasks**

- [ ] `US-213-T1` Render lanes for waveform, silence, shots and filler words aligned to the player
- [ ] `US-213-T2` Overlay face boxes on the player (toggle)
- [ ] `US-213-T3` `TEST` Component tests with a fixture MediaAnalysis document

**Acceptance criteria**

- [ ] AC1. All lanes align with the player timecode
- [ ] AC2. Missing analysis sections show their failure reason instead of empty lanes

### EP-10 - Editing Project Model

**Epic goal:** Represent every edit as structured, serializable, undoable project state rather than only an output file.

#### FT-10.1 - Timeline Domain and Commands

##### US-214 - Timeline domain model and invariants

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 3 | Backend Engineer | [US-104](phase-1-foundation.md#us-104---initial-domain-model-and-er-design) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI video editor, I want the edit represented as a typed timeline of tracks and clips, so that I can reason about and change it precisely.

**Technical tasks**

- [ ] `US-214-T1` Implement Project, Timeline, Track (video, overlay, graphics, caption, audio), Clip, Effect, Transition, Caption, AudioClip and ComponentInstance in packages/domain
- [ ] `US-214-T2` Represent time as integer microseconds with frame snapping at the composition frame rate (ADR-008)
- [ ] `US-214-T3` Enforce invariants (no illegal overlaps per track type, source ranges within asset duration, positive durations)
- [ ] `US-214-T4` Define the project.json schema in packages/schemas with a version field
- [ ] `US-214-T5` `TEST` Unit and property-based tests (fast-check) for invariants and serialization round-trips

**Acceptance criteria**

- [ ] AC1. The domain package has zero framework imports and at least 90 percent coverage
- [ ] AC2. Any timeline serializes to project.json and deserializes to an equal value

##### US-215 - Edit commands with undo, redo and replayable history

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 3 | Backend Engineer | [US-214](phase-2-perception-editing-core.md#us-214---timeline-domain-model-and-invariants) | Sequential after US-214 (same sprint; contract-first stubs allowed) |

**User story:** As a creator and as the agent, I want every edit to be a reversible command, so that changes can be undone, replayed and audited.

**Technical tasks**

- [ ] `US-215-T1` Implement the Command pattern (TrimClip, SplitClip, MoveClip, DeleteRange with ripple, InsertClip, SetProperty, AddCaption) with inverse commands
- [ ] `US-215-T2` Implement a CommandBus with history stack, undo and redo, and a persisted command log
- [ ] `US-215-T3` Rebuild a timeline by replaying the log from a snapshot
- [ ] `US-215-T4` `TEST` Property tests proving apply followed by undo restores the original state

**Acceptance criteria**

- [ ] AC1. For any generated command sequence, undoing all commands returns the initial timeline
- [ ] AC2. Replaying the persisted log reproduces the same timeline

### EP-11 - Rendering Engine

**Epic goal:** Render any timeline through interchangeable render strategies with progress and validation.

#### FT-11.1 - Render Worker

##### US-216 - Remotion render worker

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 3 | Generative Video / Remotion Engineer | [US-106](phase-1-foundation.md#us-106---rendering-feasibility-spike-ffmpeg-vs-remotion), [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) | Parallel - can start on day 1 of the sprint |

**User story:** As the system, I want a render worker that turns composition props into a video file, so that programmatic graphics can be rendered headlessly.

**Technical tasks**

- [ ] `US-216-T1` Scaffold the Remotion project inside render-worker with a root composition taking typed props
- [ ] `US-216-T2` Consume render jobs, bundle once per version, call renderMedia with concurrency and timeout, upload outputs
- [ ] `US-216-T3` Report per-frame progress through job events and support cancellation
- [ ] `US-216-T4` Run headless Chromium in a container without root
- [ ] `US-216-T5` `TEST` Integration test rendering a 5-second composition and validating it with FFprobe

**Acceptance criteria**

- [ ] AC1. A render job with valid props produces an MP4 whose duration, resolution and fps match the props
- [ ] AC2. Cancelling a render stops Chromium and frees resources

#### FT-11.2 - Render Strategies

##### US-217 - Timeline to Remotion composition mapping

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 4 | Generative Video / Remotion Engineer | [US-214](phase-2-perception-editing-core.md#us-214---timeline-domain-model-and-invariants), [US-216](phase-2-perception-editing-core.md#us-216---remotion-render-worker) | Parallel - can start on day 1 of the sprint |

**User story:** As the render system, I want any timeline mapped to a Remotion composition, so that clips, captions and graphics render from the single source of truth.

**Technical tasks**

- [ ] `US-217-T1` Implement a RemotionRenderStrategy that maps tracks and clips to Sequence and OffthreadVideo elements with frame-accurate offsets
- [ ] `US-217-T2` Map caption and graphics tracks to registered component types through a component factory
- [ ] `US-217-T3` Resolve asset URLs through short-lived signed URLs
- [ ] `US-217-T4` `TEST` Golden tests rendering fixture timelines and comparing frame hashes at key timestamps

**Acceptance criteria**

- [ ] AC1. Clip boundaries in the output are frame-accurate relative to project.json
- [ ] AC2. Unknown component types fail validation before rendering starts

##### US-218 - FFmpeg render strategy behind IRenderStrategy

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 4 | Generative Video / Remotion Engineer | [US-214](phase-2-perception-editing-core.md#us-214---timeline-domain-model-and-invariants), [US-220](phase-2-perception-editing-core.md#us-220---safe-ffmpeg-command-builder) | Parallel - can start on day 1 of the sprint |

**User story:** As the render system, I want a fast FFmpeg path for cut-only edits, so that simple edits render in a fraction of the Remotion time.

**Technical tasks**

- [ ] `US-218-T1` Define IRenderStrategy and a strategy selector (Strategy pattern) based on timeline features
- [ ] `US-218-T2` Implement FFmpegRenderStrategy using the command builder (trim, concat, audio crossfades at cuts)
- [ ] `US-218-T3` Validate outputs (duration, streams, codecs) with FFprobe after every render
- [ ] `US-218-T4` `TEST` Parity tests proving FFmpeg and Remotion strategies output the same cut points for a cut-only timeline

**Acceptance criteria**

- [ ] AC1. A cut-only timeline is rendered by FFmpeg and a timeline with graphics by Remotion, automatically
- [ ] AC2. Both strategies satisfy the same contract test suite (Liskov substitution)

### EP-12 - Editing Tool SDK and Media Operations

**Epic goal:** Expose editing capabilities to automation and AI only through typed, validated, permissioned and extensible tools.

#### FT-12.1 - Tool SDK Core

##### US-219 - Tool manifest, registry and schema validation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 4 | Backend Engineer | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs), [US-208](phase-2-perception-editing-core.md#us-208---versioned-mediaanalysis-json-schema-with-generated-bindings) | Parallel - can start on day 1 of the sprint |

**User story:** As an agent developer, I want every tool described by a manifest with schemas, permissions, cost and timeout, so that tools can be discovered, validated and added without changing the agent.

**Technical tasks**

- [ ] `US-219-T1` Define ToolManifest (name, version, description, input and output JSON Schema, permissions, estimated cost, timeout, validation rules, capability tags) in packages/tool-sdk
- [ ] `US-219-T2` Define segregated interfaces (ITool plus capability interfaces such as IRenderTool, IAudioTool, IVisionTool, ITranscriptionTool)
- [ ] `US-219-T3` Implement the ToolRegistry with dynamic registration, versioning, lookup by capability and export of manifests to LLM function-calling format
- [ ] `US-219-T4` Validate every input and output against its schema with actionable error messages
- [ ] `US-219-T5` `TEST` Unit tests for registration, lookup, validation errors and manifest export
- [ ] `US-219-T6` `DOC` Write docs/tool-sdk/adding-a-tool.md

**Acceptance criteria**

- [ ] AC1. A new tool is added by registering a manifest and implementation, with no change to registry or agent code
- [ ] AC2. Invalid input is rejected with a message naming the field and rule

##### US-221 - Tool executor with permissions, timeouts and remote dispatch

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 4 | Backend Engineer | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) | Sequential after US-219 (same sprint; contract-first stubs allowed) |

**User story:** As the platform, I want a single executor that enforces permissions, timeouts and cost limits for every tool call, so that automation cannot exceed its authority or hang.

**Technical tasks**

- [ ] `US-221-T1` Implement ToolExecutor with permission checks against the caller context, per-call timeout and cancellation
- [ ] `US-221-T2` Support in-process tools and queue-dispatched remote tools (media-worker, ai-worker, render-worker) through one interface
- [ ] `US-221-T3` Emit structured execution records (tool, input hash, duration, result status, cost) as events
- [ ] `US-221-T4` Convert tool results into timeline commands for mutating tools
- [ ] `US-221-T5` `TEST` Tests for permission denial, timeout, remote failure and command generation
- [ ] `US-221-T6` `SECURITY` Deny any tool that requests shell, arbitrary filesystem or network permissions not declared in its manifest

**Acceptance criteria**

- [ ] AC1. A tool exceeding its timeout is cancelled and reported as failed
- [ ] AC2. A caller without the required permission receives a denial and no side effects occur
- [ ] AC3. Every execution produces a record that can be queried later

#### FT-12.2 - FFmpeg Media Operations

##### US-220 - Safe FFmpeg command builder

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 3 | Multimedia Engineer | [US-126](phase-1-foundation.md#us-126---media-metadata-extraction-with-ffprobe) | Parallel - can start on day 1 of the sprint |

**User story:** As a multimedia engineer, I want a typed FFmpeg command builder, so that commands are never duplicated or built from unsafe strings.

**Technical tasks**

- [ ] `US-220-T1` Implement a fluent builder in packages/media-core for inputs, filter graphs, maps and encoders with escaping of filter arguments
- [ ] `US-220-T2` Run FFmpeg via argument arrays with progress parsing, timeout and resource limits
- [ ] `US-220-T3` Provide reusable presets (proxy, preview, social 1080p H.264/AAC)
- [ ] `US-220-T4` `SECURITY` Reject filter names and protocols not on the allow-list
- [ ] `US-220-T5` `TEST` Snapshot tests of generated argument arrays and an escaping fuzz test

**Acceptance criteria**

- [ ] AC1. No code outside media-core invokes FFmpeg directly (enforced by a lint rule)
- [ ] AC2. Malicious strings in text or path fields cannot inject extra arguments or filters

##### US-222 - Core FFmpeg editing tools

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 4 | Multimedia Engineer | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation), [US-220](phase-2-perception-editing-core.md#us-220---safe-ffmpeg-command-builder) | Sequential after US-219 (same sprint; contract-first stubs allowed) |

**User story:** As the agent, I want trim, split, concat, crop, resize, speed and audio-normalization tools, so that basic editing operations are available through the SDK.

**Technical tasks**

- [ ] `US-222-T1` Implement trim_video, split_video, concat_clips, crop_video, resize_video, change_speed and normalize_audio as SDK tools with manifests
- [ ] `US-222-T2` Mutating tools return timeline commands; media-producing tools return DerivedAssets
- [ ] `US-222-T3` `TEST` Unit tests for manifests and integration tests on fixtures for each tool

**Acceptance criteria**

- [ ] AC1. Every tool validates its input schema and has at least one integration test
- [ ] AC2. Tools never overwrite source assets

#### FT-12.3 - First Automated Edit

A deterministic, non-AI workflow that proves analysis, commands, tools and rendering work together.

##### US-223 - One-click silence removal workflow

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 4 | Multimedia Engineer | [US-204](phase-2-perception-editing-core.md#us-204---silence-loudness-peak-and-energy-analysis), [US-215](phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history), [US-218](phase-2-perception-editing-core.md#us-218---ffmpeg-render-strategy-behind-irenderstrategy), [US-221](phase-2-perception-editing-core.md#us-221---tool-executor-with-permissions-timeouts-and-remote-dispatch), [US-222](phase-2-perception-editing-core.md#us-222---core-ffmpeg-editing-tools) | Sequential after US-218, US-221, US-222 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to remove all silences with one click, so that I get a tighter video immediately and the team proves the full edit pipeline.

**Technical tasks**

- [ ] `US-223-T1` Implement the RemoveSilences application use case - read MediaAnalysis, compute keep ranges with padding, snap to word boundaries
- [ ] `US-223-T2` Execute DeleteRange commands through the ToolExecutor and create a project version
- [ ] `US-223-T3` Trigger a render and link the output to the project
- [ ] `US-223-T4` `TEST` Integration test verifying no word from the transcript is cut

**Acceptance criteria**

- [ ] AC1. The rendered output is shorter by the detected silence minus padding, within one frame
- [ ] AC2. No transcript word is truncated in the output

##### US-224 - Silence removal action and result download in the web app

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 4 | Frontend Engineer | [US-223](phase-2-perception-editing-core.md#us-223---one-click-silence-removal-workflow) | Sequential after US-223 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want a button to run silence removal and a way to preview and download the result, so that I can use the first automated edit.

**Technical tasks**

- [ ] `US-224-T1` Add the Remove silences action with padding options to the project page
- [ ] `US-224-T2` Show render progress and play and download the result
- [ ] `US-224-T3` `TEST` Component tests against the API contract mock

**Acceptance criteria**

- [ ] AC1. A user can trigger the workflow, watch progress and download the MP4 without leaving the page
- [ ] AC2. Errors from the workflow are shown with a retry option

##### US-225 - End-to-end test of the silence removal workflow

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 4 | DevOps & QA (shared) | [US-117](phase-1-foundation.md#us-117---walking-skeleton-end-to-end-test-in-ci), [US-223](phase-2-perception-editing-core.md#us-223---one-click-silence-removal-workflow), [US-224](phase-2-perception-editing-core.md#us-224---silence-removal-action-and-result-download-in-the-web-app) | Sequential after US-223, US-224 (same sprint; contract-first stubs allowed) |

**User story:** As the team, I want the first automated edit covered by an E2E test, so that later changes cannot silently break the pipeline.

**Technical tasks**

- [ ] `US-225-T1` Create the silence-gap fixture with known expected output duration and word list
- [ ] `US-225-T2` `TEST` Playwright test - upload silence fixture, run removal, wait for render, assert output duration via API
- [ ] `US-225-T3` `CI/CD` Add the test to the E2E suite with CPU models

**Acceptance criteria**

- [ ] AC1. The E2E test passes in CI and fails if any stage of analysis, tools or rendering breaks
- [ ] AC2. Test runtime stays under 6 minutes

## 7. Dependencies

### Phase-level

- Depends on [PH1](phase-1-foundation.md) Foundation and Walking Skeleton.
- US-201 needs the 16 kHz audio produced by US-128 and the queue from US-129.
- The Tool SDK (US-219, US-221) is the contract the agent will use in PH3; it is frozen at the end of Sprint 4 with contract tests.
- The MediaAnalysis schema (US-208) is the contract between Python analyzers and TypeScript consumers; analyzers in Sprints 3-4 code against it from day 1.
- External - GPU runner for nightly model tests (CPU int8 models are used in PR CI).
- Unblocks [PH3](phase-3-agent-mvp-alpha.md) Autonomous Editor Agent - MVP Alpha.

### Cross-phase story dependencies (inputs from earlier phases)

| Story | Needs | From phase | Ready by |
|---|---|---|---|
| [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) Word-level transcription with Faster-Whisper | [US-105](phase-1-foundation.md#us-105---asr-and-vad-feasibility-spike) ASR and VAD feasibility spike | PH1 | Sprint 1 |
| [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) Word-level transcription with Faster-Whisper | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) Proxy, audio extraction and thumbnail generation | PH1 | Sprint 2 |
| [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) Word-level transcription with Faster-Whisper | [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) Job queue abstraction with job state machine | PH1 | Sprint 2 |
| [US-202](phase-2-perception-editing-core.md#us-202---voice-activity-detection-and-speech-segmentation) Voice activity detection and speech segmentation | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) Proxy, audio extraction and thumbnail generation | PH1 | Sprint 2 |
| [US-204](phase-2-perception-editing-core.md#us-204---silence-loudness-peak-and-energy-analysis) Silence, loudness, peak and energy analysis | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) Proxy, audio extraction and thumbnail generation | PH1 | Sprint 2 |
| [US-206](phase-2-perception-editing-core.md#us-206---shot-and-scene-boundary-detection) Shot and scene boundary detection | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) Proxy, audio extraction and thumbnail generation | PH1 | Sprint 2 |
| [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) Face detection and tracking | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) Proxy, audio extraction and thumbnail generation | PH1 | Sprint 2 |
| [US-208](phase-2-perception-editing-core.md#us-208---versioned-mediaanalysis-json-schema-with-generated-bindings) Versioned MediaAnalysis JSON Schema with generated bindings | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) Architecture baseline, module boundaries and ADRs | PH1 | Sprint 1 |
| [US-209](phase-2-perception-editing-core.md#us-209---worker-integration-test-harness-and-gpu-test-strategy) Worker integration test harness and GPU test strategy | [US-116](phase-1-foundation.md#us-116---test-frameworks-fixtures-and-integration-harness) Test frameworks, fixtures and integration harness | PH1 | Sprint 2 |
| [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation) Analysis orchestration and aggregation | [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) Job queue abstraction with job state machine | PH1 | Sprint 2 |
| [US-211](phase-2-perception-editing-core.md#us-211---frame-accurate-video-player-component) Frame-accurate video player component | [US-125](phase-1-foundation.md#us-125---media-library-with-thumbnails-and-proxy-playback) Media library with thumbnails and proxy playback | PH1 | Sprint 2 |
| [US-214](phase-2-perception-editing-core.md#us-214---timeline-domain-model-and-invariants) Timeline domain model and invariants | [US-104](phase-1-foundation.md#us-104---initial-domain-model-and-er-design) Initial domain model and ER design | PH1 | Sprint 1 |
| [US-216](phase-2-perception-editing-core.md#us-216---remotion-render-worker) Remotion render worker | [US-106](phase-1-foundation.md#us-106---rendering-feasibility-spike-ffmpeg-vs-remotion) Rendering feasibility spike (FFmpeg vs Remotion) | PH1 | Sprint 1 |
| [US-216](phase-2-perception-editing-core.md#us-216---remotion-render-worker) Remotion render worker | [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) Job queue abstraction with job state machine | PH1 | Sprint 2 |
| [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) Tool manifest, registry and schema validation | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) Architecture baseline, module boundaries and ADRs | PH1 | Sprint 1 |
| [US-220](phase-2-perception-editing-core.md#us-220---safe-ffmpeg-command-builder) Safe FFmpeg command builder | [US-126](phase-1-foundation.md#us-126---media-metadata-extraction-with-ffprobe) Media metadata extraction with FFprobe | PH1 | Sprint 1 |
| [US-225](phase-2-perception-editing-core.md#us-225---end-to-end-test-of-the-silence-removal-workflow) End-to-end test of the silence removal workflow | [US-117](phase-1-foundation.md#us-117---walking-skeleton-end-to-end-test-in-ci) Walking-skeleton end-to-end test in CI | PH1 | Sprint 2 |

### Same-sprint sequencing (everything else in a sprint runs in parallel)

- Sprint 3: US-208 -> US-210 Analysis orchestration and aggregation
- Sprint 3: US-201, US-211 -> US-212 Synchronized transcript viewer
- Sprint 4: US-206, US-207 -> US-213 Analysis overview panels
- Sprint 3: US-214 -> US-215 Edit commands with undo, redo and replayable history
- Sprint 4: US-219 -> US-221 Tool executor with permissions, timeouts and remote dispatch
- Sprint 4: US-219 -> US-222 Core FFmpeg editing tools
- Sprint 4: US-218, US-221, US-222 -> US-223 One-click silence removal workflow
- Sprint 4: US-223 -> US-224 Silence removal action and result download in the web app
- Sprint 4: US-223, US-224 -> US-225 End-to-end test of the silence removal workflow

## 8. Sprint allocation

| Sprint | Sprint goal | Stories | SP | AI | MM | GEN | BE | FE | OPS | ALL |
|---|---|---|---|---|---|---|---|---|---|---|
| [Sprint 3](../sprints.md#sprint-3) | Transcribe speech with word-level timestamps and analyse silence and loudness, while the timeline domain model and the Remotion render worker are built in parallel. | US-201, US-202, US-204, US-208, US-209, US-210, US-211, US-212, US-214, US-215, US-216, US-220 | 49 | 11 | 11 | 5 | 10 | 6 | 6 | 0 |
| [Sprint 4](../sprints.md#sprint-4) | Complete visual perception and the unified MediaAnalysis, ship the Tool SDK with FFmpeg tools, and deliver the first automated (non-AI) edit - one-click silence removal rendered to MP4. | US-203, US-206, US-207, US-213, US-217, US-218, US-219, US-221, US-222, US-223, US-224, US-225 | 50 | 11 | 11 | 10 | 10 | 6 | 2 | 0 |

Stretch backlog (pulled in only if capacity allows): US-205

## 9. Deliverables

- Word-level transcription with language detection, confidence scores and VAD
- Filler-word and repetition detection
- Silence, loudness (EBU R128), peak and energy analysis
- Shot detection and face detection/tracking
- Versioned MediaAnalysis JSON Schema with generated TS (zod) and Python (pydantic) bindings, plus the aggregated document per asset
- Transcript viewer, analysis overview and frame-accurate player in the web app
- Timeline domain model and Command-based edit history with undo/redo
- Render worker with FFmpeg and Remotion strategies behind IRenderStrategy
- Tool SDK core (manifest, registry, validation, executor) and FFmpeg editing tools
- One-click silence removal workflow with automated E2E test

## 10. Definition of Done

The phase is done when all of the following hold (in addition to the story-level DoD for every story):

- [ ] Checkpoint CP2 perception quality gate passed and results stored in the evaluation report
- [ ] Every analyzer writes schema-valid output with provenance (analyzer, model, version, parameters) and is covered by fixture-based tests
- [ ] The timeline domain package has at least 90 percent line coverage and property-based tests for command/undo symmetry
- [ ] Tool SDK contract tests are green and the SDK interfaces are tagged v1 (frozen for PH3)
- [ ] No FFmpeg command is built by string concatenation; all go through the command builder with argument arrays
- [ ] Silence-removal E2E test passes in CI; v0.2 is tagged and deployed to staging
- [ ] Developer documentation exists for adding a new analyzer and a new tool

### Milestone exit criteria

**CP2 - Perception Quality Gate** (end of Sprint 3)

- [ ] English WER at most 12 percent on the evaluation clips; Arabic WER measured and recorded
- [ ] Median word-timestamp error at most 100 ms against hand-aligned references
- [ ] Silence detection F1 at least 0.9 against labelled ranges

**M2 - v0.2 Understand and Cut** (end of Sprint 4)

- [ ] Every uploaded talking-head video produces a versioned MediaAnalysis (transcript, VAD, silence, loudness, shots, faces)
- [ ] One-click silence removal renders a correct MP4 through the Tool SDK
- [ ] Tool SDK contract tests are frozen and green
