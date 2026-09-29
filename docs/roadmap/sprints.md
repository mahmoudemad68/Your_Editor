<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# Sprint Plan

12 sprints x 2 weeks. Planning velocity 48 SP per sprint (hard cap 52 SP). Each sprint ends with a working, demonstrable, tested increment merged to `main` and deployed to the shared staging environment.

[Roadmap overview](README.md) | [Dependencies](dependencies.md) | [Milestones](milestones.md)

## Summary

| Sprint | Weeks | Phase | Sprint goal | SP | Milestone |
|---|---|---|---|---|---|
| [1](#sprint-1) | 1-2 | [PH1](phases/phase-1-foundation.md) | Baseline requirements and architecture, and prove every layer end-to-end with a walking skeleton that stores an uploaded video and shows its FFprobe metadata. | 50 | M0, CP1 |
| [2](#sprint-2) | 3-4 | [PH1](phases/phase-1-foundation.md) | Make ingestion production-grade - authenticated users upload large files resumably, and asynchronous jobs validate, proxy and thumbnail the media with live progress. | 48 | M1 |
| [3](#sprint-3) | 5-6 | [PH2](phases/phase-2-perception-editing-core.md) | Transcribe speech with word-level timestamps and analyse silence and loudness, while the timeline domain model and the Remotion render worker are built in parallel. | 49 | CP2 |
| [4](#sprint-4) | 7-8 | [PH2](phases/phase-2-perception-editing-core.md) | Complete visual perception and the unified MediaAnalysis, ship the Tool SDK with FFmpeg tools, and deliver the first automated (non-AI) edit - one-click silence removal rendered to MP4. | 50 | M2 |
| [5](#sprint-5) | 9-10 | [PH3](phases/phase-3-agent-mvp-alpha.md) | Introduce the provider-agnostic LLM layer and the observe-plan-act agent loop that edits the timeline exclusively through Tool SDK tools, with captions and auto-reframing available as tools. | 49 | CP3 |
| [6](#sprint-6) | 11-12 | [PH3](phases/phase-3-agent-mvp-alpha.md) | Deliver the first complete autonomous edit - highlight selection to a target duration, captions, zooms, music with ducking, preview and final renders, and a live agent-run view in the web app. | 48 | M3 |
| [7](#sprint-7) | 13-14 | [PH4](phases/phase-4-mvp-complete.md) | Make the agent's output professional and consistent - plugin-based Remotion component library, font registry with Arabic support, creative memory, creativity levels and in-browser preview. | 50 | CP4 |
| [8](#sprint-8) | 15-16 | [PH4](phases/phase-4-mvp-complete.md) | Close the MVP boundary - basic B-roll and music from the asset registry, basic self-review with one automatic refinement pass, conversational edits of an existing project, and hardened workers. | 51 | M4 |
| [9](#sprint-9) | 17-18 | [PH5](phases/phase-5-advanced-autonomy.md) | Enable Level-3 capabilities safely - sandboxed execution, AI-generated Remotion components, internet asset providers, narrative restructuring and beat-aware cutting - and add the timeline view. | 52 | CP5 |
| [10](#sprint-10) | 19-20 | [PH5](phases/phase-5-advanced-autonomy.md) | Add the multimodal critic with iterative refinement, component acquisition from package registries with full validation, self-repairing code generation, brand kits and Full Autonomous mode. | 52 | M5 |
| [11](#sprint-11) | 21-22 | [PH6](phases/phase-6-hardening-release.md) | Harden security, performance and observability, prove extensibility with a plugin-only addition, and stabilize the release candidate. | 48 | CP6, M6 |
| [12](#sprint-12) | 23-24 | [PH6](phases/phase-6-hardening-release.md) | Evaluate the system scientifically, finish documentation, freeze v1.0-graduation, verify a fresh deployment and rehearse the graduation demo. | 32 | M7 |

## Parallel workstreams at a glance

Each row is a lane (primary owner). Stories in the same column but different rows run in parallel; the few same-sprint sequences are listed per sprint below.

| Lane | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 | S11 | S12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AI | US-105<br>US-107 | US-110 | US-201<br>US-202 | US-203<br>US-207 | US-304<br>US-305 | US-307 | US-407<br>US-409<br>US-410 | US-415<br>US-421 | US-514 | US-511<br>US-513<br>US-520 | US-602<br>US-604 | US-613 |
| MM | US-126 | US-127<br>US-128 | US-204<br>US-210<br>US-220 | US-206<br>US-222<br>US-223 | US-309<br>US-310 | US-314 | US-423<br>US-424 | US-414<br>US-419<br>US-420 | US-512<br>US-516 | US-515<br>US-518 | US-606 | US-615 |
| GEN | US-106 | US-130 | US-216 | US-217<br>US-218 | US-312 | US-311<br>US-313<br>US-315 | US-401<br>US-402 | US-403<br>US-405<br>US-413 | US-503 | US-504<br>US-510 | US-607<br>US-610<br>US-612 | - |
| BE | US-103<br>US-104<br>US-120<br>US-122 | US-118<br>US-129 | US-214<br>US-215 | US-219<br>US-221 | US-301<br>US-302<br>US-303 | US-306<br>US-308 | US-406<br>US-411 | US-412<br>US-417 | US-502<br>US-507 | US-505<br>US-508<br>US-521 | US-605<br>US-608 | US-616 |
| FE | US-121<br>US-124 | US-119<br>US-123<br>US-125<br>US-131 | US-211<br>US-212 | US-213<br>US-224 | US-316 | US-317<br>US-318 | US-408<br>US-418 | US-416 | US-523<br>US-524 | US-522<br>US-525<br>US-526 | US-609 | US-614<br>US-617 |
| OPS | US-108<br>US-111<br>US-112<br>US-114 | US-113<br>US-115<br>US-116<br>US-117 | US-208<br>US-209 | US-225 | US-319 | US-320<br>US-321 | US-425 | US-422<br>US-426 | US-501 | US-509 | US-601<br>US-603 | US-618<br>US-619 |
| ALL | US-101<br>US-102<br>US-109 | - | - | - | - | - | - | - | - | - | US-611 | US-620<br>US-621 |

<a id="sprint-1"></a>

## Sprint 1 - Inception and Walking Skeleton

**Weeks 1-2** | Phase [PH1](phases/phase-1-foundation.md) Foundation and Walking Skeleton | Committed 50 SP / velocity 48 SP

**Sprint goal:** Baseline requirements and architecture, and prove every layer end-to-end with a walking skeleton that stores an uploaded video and shows its FFprobe metadata.

**Working increment (Sprint Review demo):** From a fresh clone, `docker compose up` starts web, API, workers, Postgres, Redis and MinIO; a user creates a project, uploads a clip and sees codec, resolution, frame rate and duration. CI is green and required on every pull request.

**Expected deliverables**

- Software Requirements Specification v1.0 with measurable NFRs and the MVP boundary
- Use case diagram, user journeys for evaluation scenarios A-G and domain glossary
- C4 context/container diagrams and ADR-001..ADR-008
- Initial domain model and ER diagram
- Technology evaluation report (ASR, rendering, LLM tool-calling spikes)
- Risk register and threat model v0
- Product backlog imported into the tracker (this roadmap's CSV export)
- Monorepo, CI pipeline, Docker Compose environment and walking skeleton

**Milestones and checkpoints closed in this sprint**

- [M0 - Architecture Baseline and Walking Skeleton](milestones.md#m0) (milestone)
- [CP1 - Technology Feasibility](milestones.md#cp1) (checkpoint)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-105](phases/phase-1-foundation.md#us-105---asr-and-vad-feasibility-spike) ASR and VAD feasibility spike | EP-01 | AI | 3 | P0 | - | Day 1 (parallel) |
| [US-107](phases/phase-1-foundation.md#us-107---llm-tool-calling-feasibility-spike) LLM tool-calling feasibility spike | EP-01 | AI | 2 | P0 | - | Day 1 (parallel) |
| [US-126](phases/phase-1-foundation.md#us-126---media-metadata-extraction-with-ffprobe) Media metadata extraction with FFprobe | EP-04 | MM | 3 | P0 | US-111 | After US-111 |
| [US-106](phases/phase-1-foundation.md#us-106---rendering-feasibility-spike-ffmpeg-vs-remotion) Rendering feasibility spike (FFmpeg vs Remotion) | EP-01 | GEN | 2 | P0 | - | Day 1 (parallel) |
| [US-103](phases/phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) Architecture baseline, module boundaries and ADRs | EP-01 | BE | 5 | P0 | - | Day 1 (parallel) |
| [US-104](phases/phase-1-foundation.md#us-104---initial-domain-model-and-er-design) Initial domain model and ER design | EP-01 | BE | 2 | P0 | US-102 | After US-102 |
| [US-120](phases/phase-1-foundation.md#us-120---project-crud-api) Project CRUD API | EP-03 | BE | 2 | P0 | US-104 | After US-104 |
| [US-122](phases/phase-1-foundation.md#us-122---object-storage-port-and-direct-upload) Object storage port and direct upload | EP-04 | BE | 3 | P0 | US-120 | After US-120 |
| [US-121](phases/phase-1-foundation.md#us-121---web-application-shell-and-project-dashboard) Web application shell and project dashboard | EP-03 | FE | 3 | P0 | US-111 | After US-111 |
| [US-124](phases/phase-1-foundation.md#us-124---upload-and-media-details-page) Upload and media details page | EP-04 | FE | 2 | P0 | US-121 | After US-121 |
| [US-108](phases/phase-1-foundation.md#us-108---risk-register-and-threat-model-v0) Risk register and threat model v0 | EP-01 | OPS | 2 | P0 | US-103 | After US-103 |
| [US-111](phases/phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) Monorepo scaffold with enforced architecture rules | EP-02 | OPS | 5 | P0 | US-103 | After US-103 |
| [US-112](phases/phase-1-foundation.md#us-112---ci-pipeline-baseline-with-required-checks) CI pipeline baseline with required checks | EP-02 | OPS | 3 | P0 | US-111 | After US-111 |
| [US-114](phases/phase-1-foundation.md#us-114---docker-compose-environment-with-typed-configuration) Docker Compose environment with typed configuration | EP-02 | OPS | 5 | P0 | US-111 | After US-111 |
| [US-101](phases/phase-1-foundation.md#us-101---software-requirements-specification-with-measurable-nfrs) Software Requirements Specification with measurable NFRs | EP-01 | ALL | 5 | P0 | - | Day 1 (parallel) |
| [US-102](phases/phase-1-foundation.md#us-102---use-cases-user-journeys-and-domain-glossary) Use cases, user journeys and domain glossary | EP-01 | ALL | 2 | P0 | - | Day 1 (parallel) |
| [US-109](phases/phase-1-foundation.md#us-109---product-backlog-board-and-team-working-agreements) Product backlog, board and team working agreements | EP-01 | ALL | 1 | P0 | - | Day 1 (parallel) |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 5 SP): US-105, US-107
- **MM** (Multimedia Engineer, 3 SP): US-126
- **GEN** (Generative Video / Remotion Engineer, 2 SP): US-106
- **BE** (Backend Engineer, 12 SP): US-103, US-104, US-120, US-122
- **FE** (Frontend Engineer, 5 SP): US-121, US-124
- **OPS** (DevOps & QA (shared), 15 SP): US-108, US-111, US-112, US-114
- **ALL** (Whole team, 8 SP): US-101, US-102, US-109

**Same-sprint sequencing**

- US-102 -> US-104
- US-103 -> US-108
- US-103 -> US-111
- US-111 -> US-112
- US-111 -> US-114
- US-104 -> US-120
- US-111 -> US-121
- US-120 -> US-122
- US-121 -> US-124
- US-111 -> US-126
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x7, DOC x9, CI/CD x3, SECURITY x3, INTEGRATION x0

**Sprint risks and mitigations**

- Requirement churn eats the sprint. Mitigation - discovery is time-boxed to days 1-4; open questions become backlog items instead of blocking.
- Spikes expand into implementation. Mitigation - each spike has a fixed time box and a written go/no-go question.

<a id="sprint-2"></a>

## Sprint 2 - Reliable Media Ingestion

**Weeks 3-4** | Phase [PH1](phases/phase-1-foundation.md) Foundation and Walking Skeleton | Committed 48 SP / velocity 48 SP

**Sprint goal:** Make ingestion production-grade - authenticated users upload large files resumably, and asynchronous jobs validate, proxy and thumbnail the media with live progress.

**Working increment (Sprint Review demo):** A user signs up, uploads a 1.5 GB MOV that resumes after a dropped connection, watches validation and proxy jobs progress live, and plays the 540p proxy in the media library. Malformed or disguised files are rejected with a clear reason.

**Expected deliverables**

- Release v0.1 "Ingest" deployed to staging by the CD pipeline
- Authentication and per-project authorization
- Job queue with explicit job state machine, retries and cancellation
- Media validation, proxy, audio extraction and thumbnail pipeline
- Supply-chain scanning, SBOM and image publishing in CI
- Evaluation dataset (at least 12 licensed videos across 6 categories)

**Milestones and checkpoints closed in this sprint**

- [M1 - v0.1 Ingest](milestones.md#m1) (milestone)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-110](phases/phase-1-foundation.md#us-110---evaluation-dataset-collection-and-metric-definitions) Evaluation dataset collection and metric definitions | EP-01 | AI | 3 | P0 | US-101 | Day 1 (parallel) |
| [US-127](phases/phase-1-foundation.md#us-127---media-validation-and-hostile-file-defense) Media validation and hostile-file defense | EP-04 | MM | 5 | P0 | US-126, US-129 | After US-129 |
| [US-128](phases/phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation) Proxy, audio extraction and thumbnail generation | EP-04 | MM | 5 | P0 | US-126, US-129 | After US-129 |
| [US-130](phases/phase-1-foundation.md#us-130---real-time-job-progress-events) Real-time job progress events | EP-05 | GEN | 3 | P0 | US-129 | After US-129 |
| [US-118](phases/phase-1-foundation.md#us-118---secure-authentication-and-project-level-authorization) Secure authentication and project-level authorization | EP-03 | BE | 5 | P0 | US-120 | Day 1 (parallel) |
| [US-129](phases/phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) Job queue abstraction with job state machine | EP-05 | BE | 5 | P0 | US-114 | Day 1 (parallel) |
| [US-119](phases/phase-1-foundation.md#us-119---sign-up-sign-in-and-session-handling-in-the-web-app) Sign-up, sign-in and session handling in the web app | EP-03 | FE | 3 | P0 | US-118, US-121 | After US-118 |
| [US-123](phases/phase-1-foundation.md#us-123---resumable-large-file-upload) Resumable large-file upload | EP-04 | FE | 3 | P1 | US-122 | Day 1 (parallel) |
| [US-125](phases/phase-1-foundation.md#us-125---media-library-with-thumbnails-and-proxy-playback) Media library with thumbnails and proxy playback | EP-04 | FE | 3 | P0 | US-128, US-124 | After US-128 |
| [US-131](phases/phase-1-foundation.md#us-131---job-progress-and-status-ui) Job progress and status UI | EP-05 | FE | 2 | P0 | US-130 | After US-130 |
| [US-113](phases/phase-1-foundation.md#us-113---supply-chain-security-image-publishing-and-cd-to-staging) Supply-chain security, image publishing and CD to staging | EP-02 | OPS | 3 | P0 | US-112, US-114 | Day 1 (parallel) |
| [US-115](phases/phase-1-foundation.md#us-115---structured-logging-health-checks-and-error-handling-baseline) Structured logging, health checks and error handling baseline | EP-02 | OPS | 3 | P0 | US-114 | Day 1 (parallel) |
| [US-116](phases/phase-1-foundation.md#us-116---test-frameworks-fixtures-and-integration-harness) Test frameworks, fixtures and integration harness | EP-02 | OPS | 3 | P0 | US-111 | Day 1 (parallel) |
| [US-117](phases/phase-1-foundation.md#us-117---walking-skeleton-end-to-end-test-in-ci) Walking-skeleton end-to-end test in CI | EP-02 | OPS | 2 | P0 | US-116, US-126, US-124 | After US-116 |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 3 SP): US-110
- **MM** (Multimedia Engineer, 10 SP): US-127, US-128
- **GEN** (Generative Video / Remotion Engineer, 3 SP): US-130
- **BE** (Backend Engineer, 10 SP): US-118, US-129
- **FE** (Frontend Engineer, 11 SP): US-119, US-123, US-125, US-131
- **OPS** (DevOps & QA (shared), 11 SP): US-113, US-115, US-116, US-117

**Same-sprint sequencing**

- US-116 -> US-117
- US-118 -> US-119
- US-128 -> US-125
- US-129 -> US-127
- US-129 -> US-128
- US-129 -> US-130
- US-130 -> US-131
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x11, DOC x3, CI/CD x5, SECURITY x4, INTEGRATION x0

**Sprint risks and mitigations**

- Python worker and Node queue interoperability. Mitigation - queue contract tested in both languages in US-129 before other workers depend on it.

<a id="sprint-3"></a>

## Sprint 3 - Hearing the Footage

**Weeks 5-6** | Phase [PH2](phases/phase-2-perception-editing-core.md) Perception Engine and Editing Core | Committed 49 SP / velocity 48 SP

**Sprint goal:** Transcribe speech with word-level timestamps and analyse silence and loudness, while the timeline domain model and the Remotion render worker are built in parallel.

**Working increment (Sprint Review demo):** An uploaded video shows a word-synchronized transcript, a speech/silence map and loudness figures in the UI; a hand-written timeline JSON renders to MP4 through the render worker; the timeline domain passes its property-based tests.

**Expected deliverables**

- Faster-Whisper transcription with word timestamps, language detection and VAD
- Silence, loudness (EBU R128) and energy analysis
- Versioned MediaAnalysis JSON Schema with TypeScript and Python bindings
- Timeline domain model with undo/redo commands
- Remotion render worker rendering timeline JSON to MP4

**Milestones and checkpoints closed in this sprint**

- [CP2 - Perception Quality Gate](milestones.md#cp2) (checkpoint)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-201](phases/phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) Word-level transcription with Faster-Whisper | EP-06 | AI | 8 | P0 | US-105, US-128, US-129 | Day 1 (parallel) |
| [US-202](phases/phase-2-perception-editing-core.md#us-202---voice-activity-detection-and-speech-segmentation) Voice activity detection and speech segmentation | EP-06 | AI | 3 | P0 | US-128 | Day 1 (parallel) |
| [US-204](phases/phase-2-perception-editing-core.md#us-204---silence-loudness-peak-and-energy-analysis) Silence, loudness, peak and energy analysis | EP-07 | MM | 5 | P0 | US-128 | Day 1 (parallel) |
| [US-210](phases/phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation) Analysis orchestration and aggregation | EP-09 | MM | 3 | P0 | US-208, US-129 | After US-208 |
| [US-220](phases/phase-2-perception-editing-core.md#us-220---safe-ffmpeg-command-builder) Safe FFmpeg command builder | EP-12 | MM | 3 | P0 | US-126 | Day 1 (parallel) |
| [US-216](phases/phase-2-perception-editing-core.md#us-216---remotion-render-worker) Remotion render worker | EP-11 | GEN | 5 | P0 | US-106, US-129 | Day 1 (parallel) |
| [US-214](phases/phase-2-perception-editing-core.md#us-214---timeline-domain-model-and-invariants) Timeline domain model and invariants | EP-10 | BE | 5 | P0 | US-104 | Day 1 (parallel) |
| [US-215](phases/phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history) Edit commands with undo, redo and replayable history | EP-10 | BE | 5 | P0 | US-214 | After US-214 |
| [US-211](phases/phase-2-perception-editing-core.md#us-211---frame-accurate-video-player-component) Frame-accurate video player component | EP-09 | FE | 3 | P0 | US-125 | Day 1 (parallel) |
| [US-212](phases/phase-2-perception-editing-core.md#us-212---synchronized-transcript-viewer) Synchronized transcript viewer | EP-09 | FE | 3 | P0 | US-201, US-211 | After US-201, US-211 |
| [US-208](phases/phase-2-perception-editing-core.md#us-208---versioned-mediaanalysis-json-schema-with-generated-bindings) Versioned MediaAnalysis JSON Schema with generated bindings | EP-09 | OPS | 3 | P0 | US-103 | Day 1 (parallel) |
| [US-209](phases/phase-2-perception-editing-core.md#us-209---worker-integration-test-harness-and-gpu-test-strategy) Worker integration test harness and GPU test strategy | EP-09 | OPS | 3 | P0 | US-116 | Day 1 (parallel) |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 11 SP): US-201, US-202
- **MM** (Multimedia Engineer, 11 SP): US-204, US-210, US-220
- **GEN** (Generative Video / Remotion Engineer, 5 SP): US-216
- **BE** (Backend Engineer, 10 SP): US-214, US-215
- **FE** (Frontend Engineer, 6 SP): US-211, US-212
- **OPS** (DevOps & QA (shared), 6 SP): US-208, US-209

**Same-sprint sequencing**

- US-208 -> US-210
- US-201, US-211 -> US-212
- US-214 -> US-215
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x11, DOC x2, CI/CD x2, SECURITY x1, INTEGRATION x1

**Sprint risks and mitigations**

- GPU availability for CI and developers. Mitigation - CPU int8 fallback model in CI, GPU tests run nightly on a self-hosted runner.

<a id="sprint-4"></a>

## Sprint 4 - First Automated Edit

**Weeks 7-8** | Phase [PH2](phases/phase-2-perception-editing-core.md) Perception Engine and Editing Core | Committed 50 SP / velocity 48 SP

**Sprint goal:** Complete visual perception and the unified MediaAnalysis, ship the Tool SDK with FFmpeg tools, and deliver the first automated (non-AI) edit - one-click silence removal rendered to MP4.

**Working increment (Sprint Review demo):** A user clicks "Remove silences"; the system turns analysis into timeline commands, executes them through the Tool SDK and renders a downloadable MP4. The analysis view shows shots, face tracks and filler words.

**Expected deliverables**

- Release v0.2 "Understand and Cut"
- Shot detection, face detection and tracking, filler-word detection
- Tool SDK core (manifest, registry, validation, executor) with the first FFmpeg tools
- FFmpeg and Remotion render strategies behind one render interface
- Automated E2E test of the silence-removal workflow in CI

**Milestones and checkpoints closed in this sprint**

- [M2 - v0.2 Understand and Cut](milestones.md#m2) (milestone)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-203](phases/phase-2-perception-editing-core.md#us-203---filler-word-and-repetition-detection) Filler-word and repetition detection | EP-06 | AI | 3 | P0 | US-201 | Day 1 (parallel) |
| [US-207](phases/phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) Face detection and tracking | EP-08 | AI | 8 | P0 | US-128, US-208 | Day 1 (parallel) |
| [US-206](phases/phase-2-perception-editing-core.md#us-206---shot-and-scene-boundary-detection) Shot and scene boundary detection | EP-08 | MM | 3 | P0 | US-128, US-208 | Day 1 (parallel) |
| [US-222](phases/phase-2-perception-editing-core.md#us-222---core-ffmpeg-editing-tools) Core FFmpeg editing tools | EP-12 | MM | 5 | P0 | US-219, US-220 | After US-219 |
| [US-223](phases/phase-2-perception-editing-core.md#us-223---one-click-silence-removal-workflow) One-click silence removal workflow | EP-12 | MM | 3 | P0 | US-204, US-215, US-218, US-221, US-222 | After US-218, US-221, US-222 |
| [US-217](phases/phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | EP-11 | GEN | 5 | P0 | US-214, US-216 | Day 1 (parallel) |
| [US-218](phases/phase-2-perception-editing-core.md#us-218---ffmpeg-render-strategy-behind-irenderstrategy) FFmpeg render strategy behind IRenderStrategy | EP-11 | GEN | 5 | P0 | US-214, US-220 | Day 1 (parallel) |
| [US-219](phases/phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) Tool manifest, registry and schema validation | EP-12 | BE | 5 | P0 | US-103, US-208 | Day 1 (parallel) |
| [US-221](phases/phase-2-perception-editing-core.md#us-221---tool-executor-with-permissions-timeouts-and-remote-dispatch) Tool executor with permissions, timeouts and remote dispatch | EP-12 | BE | 5 | P0 | US-219 | After US-219 |
| [US-213](phases/phase-2-perception-editing-core.md#us-213---analysis-overview-panels) Analysis overview panels | EP-09 | FE | 3 | P1 | US-210, US-206, US-207 | After US-206, US-207 |
| [US-224](phases/phase-2-perception-editing-core.md#us-224---silence-removal-action-and-result-download-in-the-web-app) Silence removal action and result download in the web app | EP-12 | FE | 3 | P0 | US-223 | After US-223 |
| [US-225](phases/phase-2-perception-editing-core.md#us-225---end-to-end-test-of-the-silence-removal-workflow) End-to-end test of the silence removal workflow | EP-12 | OPS | 2 | P0 | US-117, US-223, US-224 | After US-223, US-224 |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 11 SP): US-203, US-207
- **MM** (Multimedia Engineer, 11 SP): US-206, US-222, US-223
- **GEN** (Generative Video / Remotion Engineer, 10 SP): US-217, US-218
- **BE** (Backend Engineer, 10 SP): US-219, US-221
- **FE** (Frontend Engineer, 6 SP): US-213, US-224
- **OPS** (DevOps & QA (shared), 2 SP): US-225

**Same-sprint sequencing**

- US-206, US-207 -> US-213
- US-219 -> US-221
- US-219 -> US-222
- US-218, US-221, US-222 -> US-223
- US-223 -> US-224
- US-223, US-224 -> US-225
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x12, DOC x1, CI/CD x1, SECURITY x1, INTEGRATION x0

**Sprint risks and mitigations**

- Tool SDK design churn blocks the agent in Sprint 5. Mitigation - SDK interfaces reviewed by AI and GEN owners at mid-sprint; frozen at sprint end with a contract test suite.

<a id="sprint-5"></a>

## Sprint 5 - Agent Core

**Weeks 9-10** | Phase [PH3](phases/phase-3-agent-mvp-alpha.md) Autonomous Editor Agent - MVP Alpha | Committed 49 SP / velocity 48 SP

**Sprint goal:** Introduce the provider-agnostic LLM layer and the observe-plan-act agent loop that edits the timeline exclusively through Tool SDK tools, with captions and auto-reframing available as tools.

**Working increment (Sprint Review demo):** In the new-project wizard a user asks "remove silences and filler words, add captions, make it 9:16"; the agent plans, calls tools and produces a reframed, captioned MP4. Every agent decision and tool call is recorded and retrievable through the API.

**Expected deliverables**

- LLM provider port with two adapters and a record/replay fake provider
- Versioned prompt registry
- AgentRun state machine running in the agent worker with budgets and checkpoints
- Captions, reframing and range-removal tools
- Tool permission model and injection test suite

**Milestones and checkpoints closed in this sprint**

- [CP3 - Agent Tool-Calling Reliability](milestones.md#cp3) (checkpoint)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-304](phases/phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) Agent context builder with token budgeting | EP-14 | AI | 5 | P0 | US-210, US-219, US-302 | After US-302 |
| [US-305](phases/phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling) Observe-plan-act loop with validated tool calling | EP-14 | AI | 8 | P0 | US-221, US-301, US-303, US-304 | After US-301, US-303, US-304 |
| [US-309](phases/phase-3-agent-mvp-alpha.md#us-309---range-removal-tool-for-silences-fillers-and-repetitions) Range removal tool for silences, fillers and repetitions | EP-15 | MM | 3 | P0 | US-203, US-223 | Day 1 (parallel) |
| [US-310](phases/phase-3-agent-mvp-alpha.md#us-310---auto-reframing-to-target-aspect-ratio) Auto-reframing to target aspect ratio | EP-15 | MM | 8 | P0 | US-207, US-217 | Day 1 (parallel) |
| [US-312](phases/phase-3-agent-mvp-alpha.md#us-312---word-synchronized-caption-component) Word-synchronized caption component | EP-15 | GEN | 5 | P0 | US-201, US-217 | Day 1 (parallel) |
| [US-301](phases/phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters) LLM provider port with capability descriptors and adapters | EP-13 | BE | 5 | P0 | US-103, US-107 | Day 1 (parallel) |
| [US-302](phases/phase-3-agent-mvp-alpha.md#us-302---versioned-prompt-registry) Versioned prompt registry | EP-13 | BE | 2 | P0 | US-111 | Day 1 (parallel) |
| [US-303](phases/phase-3-agent-mvp-alpha.md#us-303---agentrun-lifecycle-agent-worker-and-run-api) AgentRun lifecycle, agent worker and run API | EP-14 | BE | 5 | P0 | US-129, US-215 | Day 1 (parallel) |
| [US-316](phases/phase-3-agent-mvp-alpha.md#us-316---new-project-wizard-with-prompt-platform-and-duration) New project wizard with prompt, platform and duration | EP-16 | FE | 5 | P0 | US-125 | Day 1 (parallel) |
| [US-319](phases/phase-3-agent-mvp-alpha.md#us-319---tool-permission-model-and-injection-test-suite) Tool permission model and injection test suite | EP-17 | OPS | 3 | P0 | US-108, US-221 | Day 1 (parallel) |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 13 SP): US-304, US-305
- **MM** (Multimedia Engineer, 11 SP): US-309, US-310
- **GEN** (Generative Video / Remotion Engineer, 5 SP): US-312
- **BE** (Backend Engineer, 12 SP): US-301, US-302, US-303
- **FE** (Frontend Engineer, 5 SP): US-316
- **OPS** (DevOps & QA (shared), 3 SP): US-319

**Same-sprint sequencing**

- US-302 -> US-304
- US-301, US-303, US-304 -> US-305
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x10, DOC x1, CI/CD x1, SECURITY x4, INTEGRATION x1

**Sprint risks and mitigations**

- LLM output is unreliable. Mitigation - schema-validated structured output, validation feedback loop and deterministic tests using recorded cassettes.

<a id="sprint-6"></a>

## Sprint 6 - MVP Alpha: Raw Footage + Prompt -> Reel

**Weeks 11-12** | Phase [PH3](phases/phase-3-agent-mvp-alpha.md) Autonomous Editor Agent - MVP Alpha | Committed 48 SP / velocity 48 SP

**Sprint goal:** Deliver the first complete autonomous edit - highlight selection to a target duration, captions, zooms, music with ducking, preview and final renders, and a live agent-run view in the web app.

**Working increment (Sprint Review demo):** The "45-second professional Reel" prompt runs end-to-end from the web UI on podcast and educational footage and produces a downloadable 9:16 video; evaluation harness v0 reports metrics for 6 dataset videos every night.

**Expected deliverables**

- Release v0.3 "MVP Alpha" and the first recorded end-to-end demo
- Highlight selection and short-form generation for TikTok, Reels and Shorts presets
- Zoom, audio normalization, music and ducking tools
- Preview and final render profiles with output validation
- Evaluation harness v0 and MVP end-to-end test in CI

**Milestones and checkpoints closed in this sprint**

- [M3 - MVP Alpha - First Autonomous Video](milestones.md#m3) (milestone)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-307](phases/phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting) Highlight selection and semantic cutting | EP-14 | AI | 8 | P0 | US-201, US-305 | Day 1 (parallel) |
| [US-314](phases/phase-3-agent-mvp-alpha.md#us-314---audio-normalization-music-and-ducking-tools) Audio normalization, music and ducking tools | EP-15 | MM | 5 | P0 | US-202, US-204, US-222 | Day 1 (parallel) |
| [US-311](phases/phase-3-agent-mvp-alpha.md#us-311---zoom-and-punch-in-effects) Zoom and punch-in effects | EP-15 | GEN | 3 | P0 | US-207, US-217 | Day 1 (parallel) |
| [US-313](phases/phase-3-agent-mvp-alpha.md#us-313---caption-tool-with-segmentation-readability-rules-and-safe-zones) Caption tool with segmentation, readability rules and safe zones | EP-15 | GEN | 3 | P0 | US-219, US-312 | Day 1 (parallel) |
| [US-315](phases/phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) Preview and final render profiles with output validation | EP-15 | GEN | 5 | P0 | US-217, US-218 | Day 1 (parallel) |
| [US-306](phases/phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api) Agent event stream and audit trail API | EP-14 | BE | 3 | P0 | US-130, US-303 | Day 1 (parallel) |
| [US-308](phases/phase-3-agent-mvp-alpha.md#us-308---short-form-generation-for-platform-presets) Short-form generation for platform presets | EP-14 | BE | 5 | P0 | US-307, US-310 | After US-307 |
| [US-317](phases/phase-3-agent-mvp-alpha.md#us-317---live-agent-run-view-with-result-player-and-download) Live agent run view with result player and download | EP-16 | FE | 5 | P0 | US-306, US-315 | After US-306, US-315 |
| [US-318](phases/phase-3-agent-mvp-alpha.md#us-318---project-runs-and-renders-overview) Project runs and renders overview | EP-16 | FE | 3 | P1 | US-306 | After US-306 |
| [US-320](phases/phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0) Evaluation harness v0 | EP-17 | OPS | 5 | P0 | US-110, US-305 | Day 1 (parallel) |
| [US-321](phases/phase-3-agent-mvp-alpha.md#us-321---mvp-end-to-end-test-in-ci) MVP end-to-end test in CI | EP-17 | OPS | 3 | P0 | US-308, US-317 | After US-308, US-317 |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 8 SP): US-307
- **MM** (Multimedia Engineer, 5 SP): US-314
- **GEN** (Generative Video / Remotion Engineer, 11 SP): US-311, US-313, US-315
- **BE** (Backend Engineer, 8 SP): US-306, US-308
- **FE** (Frontend Engineer, 8 SP): US-317, US-318
- **OPS** (DevOps & QA (shared), 8 SP): US-320, US-321

**Same-sprint sequencing**

- US-307 -> US-308
- US-306, US-315 -> US-317
- US-306 -> US-318
- US-308, US-317 -> US-321
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x10, DOC x1, CI/CD x2, SECURITY x0, INTEGRATION x0

**Sprint risks and mitigations**

- Milestone M3 at risk. Mitigation - Go/No-Go at mid-sprint review; the runs overview (US-318) and zoom tool (US-311) are the first scope to move into Sprint 7, never the end-to-end path.

<a id="sprint-7"></a>

## Sprint 7 - Motion Graphics and Design System

**Weeks 13-14** | Phase [PH4](phases/phase-4-mvp-complete.md) MVP Completion - Generative Editing, Design System and Interactive Workspace | Committed 50 SP / velocity 48 SP

**Sprint goal:** Make the agent's output professional and consistent - plugin-based Remotion component library, font registry with Arabic support, creative memory, creativity levels and in-browser preview.

**Working increment (Sprint Review demo):** The agent adds animated keyword text, lower thirds and a title animation using project-selected fonts (Arabic captions in Cairo, English keywords in Montserrat); the user previews the edit in the browser before rendering and can switch between Conservative, Balanced and Creative modes.

**Expected deliverables**

- Component manifest and plugin registry with the first built-in motion graphics pack
- Font registry, project font selection and glyph-coverage checks
- Unified local asset registry with starter packs
- Creative memory and creativity-level policy
- Browser preview with the Remotion Player and visual regression tests in CI

**Milestones and checkpoints closed in this sprint**

- [CP4 - Render Budget](milestones.md#cp4) (checkpoint)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-407](phases/phase-4-mvp-complete.md#us-407---agent-font-selection-with-glyph-coverage-checks) Agent font selection with glyph coverage checks | EP-19 | AI | 3 | P0 | US-304, US-406 | After US-406 |
| [US-409](phases/phase-4-mvp-complete.md#us-409---project-creative-memory) Project creative memory | EP-19 | AI | 5 | P0 | US-304 | Day 1 (parallel) |
| [US-410](phases/phase-4-mvp-complete.md#us-410---creativity-level-policy-enforcement) Creativity level policy enforcement | EP-19 | AI | 3 | P0 | US-219, US-304 | Day 1 (parallel) |
| [US-423](phases/phase-4-mvp-complete.md#us-423---analysis-caching-by-media-fingerprint) Analysis caching by media fingerprint | EP-23 | MM | 3 | P1 | US-210 | Day 1 (parallel) |
| [US-424](phases/phase-4-mvp-complete.md#us-424---active-speaker-detection) Active speaker detection | EP-23 | MM | 5 | P1 | US-202, US-207 | Day 1 (parallel) |
| [US-401](phases/phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) Component manifest and plugin registry | EP-18 | GEN | 5 | P0 | US-217, US-219 | Day 1 (parallel) |
| [US-402](phases/phase-4-mvp-complete.md#us-402---motion-graphics-pack-v1) Motion graphics pack v1 | EP-18 | GEN | 5 | P0 | US-401 | After US-401 |
| [US-406](phases/phase-4-mvp-complete.md#us-406---font-registry-with-metadata-and-validation) Font registry with metadata and validation | EP-19 | BE | 5 | P0 | US-122 | Day 1 (parallel) |
| [US-411](phases/phase-4-mvp-complete.md#us-411---unified-local-asset-registry-with-starter-packs) Unified local asset registry with starter packs | EP-20 | BE | 5 | P0 | US-122 | Day 1 (parallel) |
| [US-408](phases/phase-4-mvp-complete.md#us-408---font-library-and-project-font-picker-ui) Font library and project font picker UI | EP-19 | FE | 3 | P0 | US-406 | After US-406 |
| [US-418](phases/phase-4-mvp-complete.md#us-418---in-browser-preview-with-the-remotion-player) In-browser preview with the Remotion Player | EP-21 | FE | 5 | P0 | US-211, US-217 | Day 1 (parallel) |
| [US-425](phases/phase-4-mvp-complete.md#us-425---visual-regression-testing-for-components-and-renders) Visual regression testing for components and renders | EP-23 | OPS | 3 | P0 | US-216 | Day 1 (parallel) |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 11 SP): US-407, US-409, US-410
- **MM** (Multimedia Engineer, 8 SP): US-423, US-424
- **GEN** (Generative Video / Remotion Engineer, 10 SP): US-401, US-402
- **BE** (Backend Engineer, 10 SP): US-406, US-411
- **FE** (Frontend Engineer, 8 SP): US-408, US-418
- **OPS** (DevOps & QA (shared), 3 SP): US-425

**Same-sprint sequencing**

- US-401 -> US-402
- US-406 -> US-407
- US-406 -> US-408
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x11, DOC x2, CI/CD x2, SECURITY x0, INTEGRATION x0

**Sprint risks and mitigations**

- Render time grows with graphics. Mitigation - checkpoint CP4 render budget; preview renders use proxies.

<a id="sprint-8"></a>

## Sprint 8 - MVP Complete

**Weeks 15-16** | Phase [PH4](phases/phase-4-mvp-complete.md) MVP Completion - Generative Editing, Design System and Interactive Workspace | Committed 51 SP / velocity 48 SP

**Sprint goal:** Close the MVP boundary - basic B-roll and music from the asset registry, basic self-review with one automatic refinement pass, conversational edits of an existing project, and hardened workers.

**Working increment (Sprint Review demo):** The agent inserts relevant B-roll and background music, detects a caption overflow and a loudness problem in its own render and fixes them automatically; the user then types "make the captions larger" and receives a new project version without a full re-edit.

**Expected deliverables**

- Release v0.9-mvp covering every capability in the MVP boundary
- Semantic asset search and basic B-roll insertion
- Critic v0 deterministic quality checks and single refinement pass
- Conversational revision mode, chat panel and version history
- Hardened, resource-limited worker containers
- MVP evaluation report for the mid-project review

**Milestones and checkpoints closed in this sprint**

- [M4 - MVP Complete - v0.9-mvp](milestones.md#m4) (milestone)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-415](phases/phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits) Revision mode for incremental natural-language edits | EP-21 | AI | 5 | P0 | US-215, US-305 | Day 1 (parallel) |
| [US-421](phases/phase-4-mvp-complete.md#us-421---automatic-single-refinement-pass) Automatic single refinement pass | EP-22 | AI | 3 | P0 | US-305, US-419 | After US-419 |
| [US-414](phases/phase-4-mvp-complete.md#us-414---music-selection-from-the-registry) Music selection from the registry | EP-20 | MM | 3 | P0 | US-314, US-411 | Day 1 (parallel) |
| [US-419](phases/phase-4-mvp-complete.md#us-419---deterministic-render-quality-checks) Deterministic render quality checks | EP-22 | MM | 5 | P0 | US-315, US-405 | After US-405 |
| [US-420](phases/phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets) Frame sampling and contact sheets | EP-22 | MM | 3 | P1 | US-315 | Day 1 (parallel) |
| [US-403](phases/phase-4-mvp-complete.md#us-403---transitions-pack) Transitions pack | EP-18 | GEN | 3 | P1 | US-401 | Day 1 (parallel) |
| [US-405](phases/phase-4-mvp-complete.md#us-405---layout-metadata-emission-for-quality-checks) Layout metadata emission for quality checks | EP-18 | GEN | 3 | P0 | US-312, US-402 | Day 1 (parallel) |
| [US-413](phases/phase-4-mvp-complete.md#us-413---basic-b-roll-insertion) Basic B-roll insertion | EP-20 | GEN | 5 | P0 | US-217, US-412 | After US-412 |
| [US-412](phases/phase-4-mvp-complete.md#us-412---semantic-asset-search) Semantic asset search | EP-20 | BE | 5 | P0 | US-411 | Day 1 (parallel) |
| [US-417](phases/phase-4-mvp-complete.md#us-417---version-history-with-undo-redo-and-restore) Version history with undo, redo and restore | EP-21 | BE | 3 | P0 | US-215 | Day 1 (parallel) |
| [US-416](phases/phase-4-mvp-complete.md#us-416---ai-chat-panel-in-the-editing-workspace) AI chat panel in the editing workspace | EP-21 | FE | 5 | P0 | US-306, US-415 | After US-415 |
| [US-422](phases/phase-4-mvp-complete.md#us-422---hardened-resource-limited-worker-containers) Hardened, resource-limited worker containers | EP-23 | OPS | 5 | P0 | US-114, US-127 | Day 1 (parallel) |
| [US-426](phases/phase-4-mvp-complete.md#us-426---mvp-evaluation-report-and-human-acceptance-pilot) MVP evaluation report and human acceptance pilot | EP-23 | OPS | 3 | P0 | US-320, US-413, US-421 | After US-413, US-421 |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 8 SP): US-415, US-421
- **MM** (Multimedia Engineer, 11 SP): US-414, US-419, US-420
- **GEN** (Generative Video / Remotion Engineer, 11 SP): US-403, US-405, US-413
- **BE** (Backend Engineer, 8 SP): US-412, US-417
- **FE** (Frontend Engineer, 5 SP): US-416
- **OPS** (DevOps & QA (shared), 8 SP): US-422, US-426

**Same-sprint sequencing**

- US-412 -> US-413
- US-415 -> US-416
- US-405 -> US-419
- US-419 -> US-421
- US-413, US-421 -> US-426
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x13, DOC x1, CI/CD x0, SECURITY x3, INTEGRATION x0

**Sprint risks and mitigations**

- Conversational revision quality. Mitigation - start from the five canonical utterances in the plan and extend the test set every sprint.

<a id="sprint-9"></a>

## Sprint 9 - Safe Self-Expansion

**Weeks 17-18** | Phase [PH5](phases/phase-5-advanced-autonomy.md) Advanced Autonomy - Self-Expanding and Creative Editor | Committed 52 SP / velocity 48 SP

**Sprint goal:** Enable Level-3 capabilities safely - sandboxed execution, AI-generated Remotion components, internet asset providers, narrative restructuring and beat-aware cutting - and add the timeline view.

**Working increment (Sprint Review demo):** The user asks for "a holographic glitch title"; the agent generates, compiles and test-renders a new component inside the sandbox and uses it in the edit. The agent restructures a podcast into Hook, Context, Value and Payoff and, when the local library has no match, fetches stock B-roll from a provider API into quarantine (promotion to the library follows in Sprint 10 with license validation).

**Expected deliverables**

- Sandbox runtime passing the escape and resource-limit test suite (CP5)
- Component generation pipeline and generated component registry
- Internet asset providers with quarantine download
- Hook detection, narrative restructuring and beat-synchronized cutting
- Timeline view and asset library UI

**Milestones and checkpoints closed in this sprint**

- [CP5 - Sandbox Security Gate](milestones.md#cp5) (checkpoint)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-514](phases/phase-5-advanced-autonomy.md#us-514---hook-detection-and-narrative-restructuring) Hook detection and narrative restructuring | EP-28 | AI | 8 | P1 | US-307 | Day 1 (parallel) |
| [US-512](phases/phase-5-advanced-autonomy.md#us-512---caption-audio-and-editing-quality-checks-v1) Caption, audio and editing quality checks v1 | EP-27 | MM | 5 | P1 | US-419 | Day 1 (parallel) |
| [US-516](phases/phase-5-advanced-autonomy.md#us-516---beat-detection-and-beat-synchronized-cutting) Beat detection and beat-synchronized cutting | EP-28 | MM | 5 | P1 | US-414 | Day 1 (parallel) |
| [US-503](phases/phase-5-advanced-autonomy.md#us-503---component-generation-pipeline-generate-check-compile-test-render) Component generation pipeline (generate, check, compile, test render) | EP-25 | GEN | 8 | P1 | US-401, US-501 | After US-501 |
| [US-502](phases/phase-5-advanced-autonomy.md#us-502---controlled-dependency-installation-through-a-registry-mirror) Controlled dependency installation through a registry mirror | EP-24 | BE | 5 | P0 | US-501 | After US-501 |
| [US-507](phases/phase-5-advanced-autonomy.md#us-507---internet-asset-providers-with-quarantine-download) Internet asset providers with quarantine download | EP-26 | BE | 5 | P1 | US-411 | Day 1 (parallel) |
| [US-523](phases/phase-5-advanced-autonomy.md#us-523---multi-track-timeline-view) Multi-track timeline view | EP-29 | FE | 5 | P1 | US-417, US-418 | Day 1 (parallel) |
| [US-524](phases/phase-5-advanced-autonomy.md#us-524---asset-library-ui) Asset library UI | EP-29 | FE | 3 | P1 | US-412 | Day 1 (parallel) |
| [US-501](phases/phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code) Sandbox runtime for untrusted code | EP-24 | OPS | 8 | P0 | US-422 | Day 1 (parallel) |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 8 SP): US-514
- **MM** (Multimedia Engineer, 10 SP): US-512, US-516
- **GEN** (Generative Video / Remotion Engineer, 8 SP): US-503
- **BE** (Backend Engineer, 10 SP): US-502, US-507
- **FE** (Frontend Engineer, 8 SP): US-523, US-524
- **OPS** (DevOps & QA (shared), 8 SP): US-501

**Same-sprint sequencing**

- US-501 -> US-502
- US-501 -> US-503
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x8, DOC x1, CI/CD x1, SECURITY x5, INTEGRATION x0

**Sprint risks and mitigations**

- Sandbox complexity. Mitigation - start with rootless Docker plus gVisor defaults; Firecracker is out of scope.

<a id="sprint-10"></a>

## Sprint 10 - Editor-Grade Intelligence

**Weeks 19-20** | Phase [PH5](phases/phase-5-advanced-autonomy.md) Advanced Autonomy - Self-Expanding and Creative Editor | Committed 52 SP / velocity 48 SP

**Sprint goal:** Add the multimodal critic with iterative refinement, component acquisition from package registries with full validation, self-repairing code generation, brand kits and Full Autonomous mode.

**Working increment (Sprint Review demo):** In Full Autonomous mode the agent edits, renders, critiques its own contact sheet (for example, a caption covering a face), fixes it and re-renders until the score stops improving; it installs a missing component from npm only after license, reputation and vulnerability checks pass in the sandbox.

**Expected deliverables**

- Release v0.95-beta - feature freeze
- Multimodal critic, refinement loop controller and quality report UI data
- External component acquisition pipeline with license and security validation
- Brand kits and Full Autonomous creativity level
- Generated components gallery with approval flow

**Milestones and checkpoints closed in this sprint**

- [M5 - Feature Freeze - v0.95-beta](milestones.md#m5) (milestone)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-511](phases/phase-5-advanced-autonomy.md#us-511---multimodal-visual-critique) Multimodal visual critique | EP-27 | AI | 5 | P1 | US-301, US-419, US-420 | Day 1 (parallel) |
| [US-513](phases/phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) Iterative refinement loop controller | EP-27 | AI | 3 | P1 | US-421, US-511 | After US-511 |
| [US-520](phases/phase-5-advanced-autonomy.md#us-520---full-autonomous-creativity-level-with-approval-gates) Full Autonomous creativity level with approval gates | EP-28 | AI | 3 | P1 | US-410, US-503, US-507 | Day 1 (parallel) |
| [US-515](phases/phase-5-advanced-autonomy.md#us-515---keyword-emphasis) Keyword emphasis | EP-28 | MM | 3 | P1 | US-402, US-409 | Day 1 (parallel) |
| [US-518](phases/phase-5-advanced-autonomy.md#us-518---pacing-control) Pacing control | EP-28 | MM | 3 | P1 | US-307, US-516 | Day 1 (parallel) |
| [US-504](phases/phase-5-advanced-autonomy.md#us-504---self-repair-loop-with-visual-verification) Self-repair loop with visual verification | EP-25 | GEN | 5 | P1 | US-420, US-503 | Day 1 (parallel) |
| [US-510](phases/phase-5-advanced-autonomy.md#us-510---component-acquisition-from-package-registries) Component acquisition from package registries | EP-26 | GEN | 5 | P1 | US-502, US-505, US-509 | After US-505, US-509 |
| [US-505](phases/phase-5-advanced-autonomy.md#us-505---generated-component-registry-with-provenance) Generated component registry with provenance | EP-25 | BE | 3 | P1 | US-401, US-503 | Day 1 (parallel) |
| [US-508](phases/phase-5-advanced-autonomy.md#us-508---license-and-provenance-validation) License and provenance validation | EP-26 | BE | 3 | P1 | US-507 | Day 1 (parallel) |
| [US-521](phases/phase-5-advanced-autonomy.md#us-521---brand-kit-model-and-application) Brand kit model and application | EP-29 | BE | 5 | P1 | US-406, US-409 | Day 1 (parallel) |
| [US-522](phases/phase-5-advanced-autonomy.md#us-522---brand-kit-management-ui) Brand kit management UI | EP-29 | FE | 3 | P1 | US-521 | After US-521 |
| [US-525](phases/phase-5-advanced-autonomy.md#us-525---generated-components-gallery-with-approval) Generated components gallery with approval | EP-29 | FE | 3 | P1 | US-505 | After US-505 |
| [US-526](phases/phase-5-advanced-autonomy.md#us-526---dashboard-overview) Dashboard overview | EP-29 | FE | 3 | P1 | US-318 | Day 1 (parallel) |
| [US-509](phases/phase-5-advanced-autonomy.md#us-509---media-and-package-security-validation) Media and package security validation | EP-26 | OPS | 5 | P0 | US-502, US-507 | Day 1 (parallel) |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 11 SP): US-511, US-513, US-520
- **MM** (Multimedia Engineer, 6 SP): US-515, US-518
- **GEN** (Generative Video / Remotion Engineer, 10 SP): US-504, US-510
- **BE** (Backend Engineer, 11 SP): US-505, US-508, US-521
- **FE** (Frontend Engineer, 9 SP): US-522, US-525, US-526
- **OPS** (DevOps & QA (shared), 5 SP): US-509

**Same-sprint sequencing**

- US-505, US-509 -> US-510
- US-511 -> US-513
- US-521 -> US-522
- US-505 -> US-525
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x14, DOC x2, CI/CD x0, SECURITY x4, INTEGRATION x0

**Sprint risks and mitigations**

- Feature creep before freeze. Mitigation - anything not merged by the Sprint 10 review moves to the stretch backlog.

<a id="sprint-11"></a>

## Sprint 11 - Hardening

**Weeks 21-22** | Phase [PH6](phases/phase-6-hardening-release.md) Hardening, Evaluation and Graduation Release | Committed 48 SP / velocity 48 SP

**Sprint goal:** Harden security, performance and observability, prove extensibility with a plugin-only addition, and stabilize the release candidate.

**Working increment (Sprint Review demo):** Release candidate v1.0-rc1 on staging with dashboards for jobs, GPU, tokens and cost; the agent run inspector explains every decision; the red-team, sandbox-escape and load suites are green; a new tool and a new LLM provider are added without touching core modules.

**Expected deliverables**

- Security test suite, red-team report and fixed findings
- GPU model pooling, parallel analysis DAG and incremental rendering
- Metrics, tracing, error tracking dashboards and agent run inspector
- Extensibility proof and Tool SDK / component authoring guide
- Release candidate v1.0-rc1

**Milestones and checkpoints closed in this sprint**

- [CP6 - Security and Performance Gate](milestones.md#cp6) (checkpoint)
- [M6 - Release Candidate - v1.0-rc1](milestones.md#m6) (milestone)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-602](phases/phase-6-hardening-release.md#us-602---prompt-injection-and-agent-safety-red-team) Prompt-injection and agent safety red-team | EP-30 | AI | 3 | P0 | US-319, US-520 | Day 1 (parallel) |
| [US-604](phases/phase-6-hardening-release.md#us-604---gpu-inference-and-model-pooling) GPU inference and model pooling | EP-31 | AI | 3 | P1 | US-201, US-207 | Day 1 (parallel) |
| [US-606](phases/phase-6-hardening-release.md#us-606---performance-benchmark-suite-and-budgets) Performance benchmark suite and budgets | EP-31 | MM | 3 | P0 | US-320 | Day 1 (parallel) |
| [US-607](phases/phase-6-hardening-release.md#us-607---incremental-rendering-and-render-caching) Incremental rendering and render caching | EP-31 | GEN | 5 | P1 | US-315 | Day 1 (parallel) |
| [US-610](phases/phase-6-hardening-release.md#us-610---plugin-only-extension-proof) Plugin-only extension proof | EP-33 | GEN | 3 | P0 | US-219, US-301, US-401 | Day 1 (parallel) |
| [US-612](phases/phase-6-hardening-release.md#us-612---tool-sdk-component-and-provider-authoring-guide) Tool SDK, component and provider authoring guide | EP-33 | GEN | 3 | P0 | US-610 | After US-610 |
| [US-605](phases/phase-6-hardening-release.md#us-605---parallel-analysis-dag) Parallel analysis DAG | EP-31 | BE | 5 | P1 | US-210, US-423 | Day 1 (parallel) |
| [US-608](phases/phase-6-hardening-release.md#us-608---metrics-distributed-tracing-dashboards-and-error-tracking) Metrics, distributed tracing, dashboards and error tracking | EP-32 | BE | 5 | P0 | US-115, US-306 | Day 1 (parallel) |
| [US-609](phases/phase-6-hardening-release.md#us-609---agent-run-inspector) Agent run inspector | EP-32 | FE | 5 | P0 | US-306, US-513 | Day 1 (parallel) |
| [US-601](phases/phase-6-hardening-release.md#us-601---security-test-suite-and-asvs-review) Security test suite and ASVS review | EP-30 | OPS | 5 | P0 | US-118, US-422 | Day 1 (parallel) |
| [US-603](phases/phase-6-hardening-release.md#us-603---sandbox-and-resource-exhaustion-red-team) Sandbox and resource-exhaustion red-team | EP-30 | OPS | 3 | P0 | US-501, US-509 | Day 1 (parallel) |
| [US-611](phases/phase-6-hardening-release.md#us-611---bug-bash-and-stabilization) Bug bash and stabilization | EP-33 | ALL | 5 | P0 | - | Day 1 (parallel) |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 6 SP): US-602, US-604
- **MM** (Multimedia Engineer, 3 SP): US-606
- **GEN** (Generative Video / Remotion Engineer, 11 SP): US-607, US-610, US-612
- **BE** (Backend Engineer, 10 SP): US-605, US-608
- **FE** (Frontend Engineer, 5 SP): US-609
- **OPS** (DevOps & QA (shared), 8 SP): US-601, US-603
- **ALL** (Whole team, 5 SP): US-611

**Same-sprint sequencing**

- US-610 -> US-612
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x11, DOC x4, CI/CD x4, SECURITY x7, INTEGRATION x0

**Sprint risks and mitigations**

- Too many late defects. Mitigation - bug bash in week 1 of the sprint; fixes prioritized by severity with a daily triage.

<a id="sprint-12"></a>

## Sprint 12 - Evaluation and Graduation Release

**Weeks 23-24** | Phase [PH6](phases/phase-6-hardening-release.md) Hardening, Evaluation and Graduation Release | Committed 32 SP / velocity 48 SP

**Sprint goal:** Evaluate the system scientifically, finish documentation, freeze v1.0-graduation, verify a fresh deployment and rehearse the graduation demo.

**Working increment (Sprint Review demo):** On a clean machine the team clones the repository, runs the bootstrap script and executes scenarios A-G live; the evaluation report compares AI edits with human edits; v1.0-graduation is tagged with release notes and SBOM.

**Expected deliverables**

- Evaluation report with metrics, ablations and human acceptance study
- Complete documentation set and required diagrams
- Scripted scenarios A-G with recorded runs
- v1.0-graduation tag, release notes, SBOM and pinned images
- Rehearsed graduation demo with before/after comparisons

**Milestones and checkpoints closed in this sprint**

- [M7 - v1.0-graduation Release and Demo](milestones.md#m7) (milestone)

**Sprint backlog**

| Story | Epic | Lane | SP | Priority | Depends on | Start |
|---|---|---|---|---|---|---|
| [US-613](phases/phase-6-hardening-release.md#us-613---full-evaluation-run-with-ablations) Full evaluation run with ablations | EP-34 | AI | 5 | P0 | US-320, US-513 | Day 1 (parallel) |
| [US-615](phases/phase-6-hardening-release.md#us-615---scripted-evaluation-scenarios-a-g) Scripted evaluation scenarios A-G | EP-34 | MM | 5 | P0 | US-415, US-503, US-510, US-513 | Day 1 (parallel) |
| [US-616](phases/phase-6-hardening-release.md#us-616---architecture-and-developer-documentation-with-required-diagrams) Architecture and developer documentation with required diagrams | EP-35 | BE | 5 | P0 | US-103, US-612 | Day 1 (parallel) |
| [US-614](phases/phase-6-hardening-release.md#us-614---human-acceptance-study) Human acceptance study | EP-34 | FE | 3 | P0 | US-613 | After US-613 |
| [US-617](phases/phase-6-hardening-release.md#us-617---user-manual-and-api-documentation) User manual and API documentation | EP-35 | FE | 3 | P0 | US-526 | Day 1 (parallel) |
| [US-618](phases/phase-6-hardening-release.md#us-618---security-testing-and-deployment-documentation) Security, testing and deployment documentation | EP-35 | OPS | 3 | P0 | US-601, US-606 | Day 1 (parallel) |
| [US-619](phases/phase-6-hardening-release.md#us-619---fresh-deployment-verification-and-bootstrap-script) Fresh deployment verification and bootstrap script | EP-36 | OPS | 3 | P0 | US-618 | After US-618 |
| [US-620](phases/phase-6-hardening-release.md#us-620---release-freeze-v10-graduation) Release freeze v1.0-graduation | EP-36 | ALL | 2 | P0 | US-611, US-619 | After US-619 |
| [US-621](phases/phase-6-hardening-release.md#us-621---graduation-demo-preparation-and-rehearsal) Graduation demo preparation and rehearsal | EP-36 | ALL | 3 | P0 | US-615, US-620 | After US-615, US-620 |

**Parallel workstreams**

- **AI** (AI / Agent Engineer, 5 SP): US-613
- **MM** (Multimedia Engineer, 5 SP): US-615
- **BE** (Backend Engineer, 5 SP): US-616
- **FE** (Frontend Engineer, 6 SP): US-614, US-617
- **OPS** (DevOps & QA (shared), 6 SP): US-618, US-619
- **ALL** (Whole team, 5 SP): US-620, US-621

**Same-sprint sequencing**

- US-613 -> US-614
- US-618 -> US-619
- US-619 -> US-620
- US-615, US-620 -> US-621
- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.

**Built-in quality work this sprint** (tagged technical tasks): TEST x5, DOC x10, CI/CD x1, SECURITY x0, INTEGRATION x0

**Sprint risks and mitigations**

- Demo-day infrastructure failure. Mitigation - recorded backup runs and an offline-capable local deployment.

## Stretch backlog

Not committed to any sprint. Pulled in only when a sprint finishes early or the team has 6 members.

| Story | Epic | Lane | SP | Priority | Depends on |
|---|---|---|---|---|---|
| [US-205](phases/phase-2-perception-editing-core.md#us-205---speech-music-and-noise-classification) Speech, music and noise classification | EP-07 | MM | 3 | P2 | US-204 |
| [US-404](phases/phase-4-mvp-complete.md#us-404---overlay-background-and-b-roll-frame-components) Overlay, background and B-roll frame components | EP-18 | GEN | 3 | P2 | US-401 |
| [US-506](phases/phase-5-advanced-autonomy.md#us-506---generated-ffmpeg-filter-chains) Generated FFmpeg filter chains | EP-25 | MM | 5 | P3 | US-220, US-501 |
| [US-517](phases/phase-5-advanced-autonomy.md#us-517---mood-detection-and-music-matching) Mood detection and music matching | EP-28 | MM | 3 | P2 | US-414 |
| [US-519](phases/phase-5-advanced-autonomy.md#us-519---semantic-visual-understanding-for-clip-and-b-roll-selection) Semantic visual understanding for clip and B-roll selection | EP-28 | AI | 5 | P2 | US-413, US-420 |
| [US-527](phases/phase-5-advanced-autonomy.md#us-527---advanced-reference-resolution-in-conversational-edits) Advanced reference resolution in conversational edits | EP-29 | AI | 3 | P2 | US-415 |
| [US-528](phases/phase-5-advanced-autonomy.md#us-528---direct-timeline-manipulation) Direct timeline manipulation | EP-29 | FE | 5 | P3 | US-523 |
