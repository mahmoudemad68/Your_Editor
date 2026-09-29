<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# Milestones and Checkpoints

Milestones are release-level outcomes reviewed with the supervisor at Sprint Review. Checkpoints are technical gates the team verifies internally; failing a checkpoint triggers the listed fallback instead of silently slipping the schedule.

[Roadmap overview](README.md) | [Sprint plan](sprints.md) | [Dependencies](dependencies.md)

| ID | Name | Type | End of | Phase |
|---|---|---|---|---|
| [M0](#m0) | Architecture Baseline and Walking Skeleton | milestone | Sprint 1 (Weeks 1-2) | PH1 |
| [CP1](#cp1) | Technology Feasibility | checkpoint | Sprint 1 (Weeks 1-2) | PH1 |
| [M1](#m1) | v0.1 Ingest | milestone | Sprint 2 (Weeks 3-4) | PH1 |
| [CP2](#cp2) | Perception Quality Gate | checkpoint | Sprint 3 (Weeks 5-6) | PH2 |
| [M2](#m2) | v0.2 Understand and Cut | milestone | Sprint 4 (Weeks 7-8) | PH2 |
| [CP3](#cp3) | Agent Tool-Calling Reliability | checkpoint | Sprint 5 (Weeks 9-10) | PH3 |
| [M3](#m3) | MVP Alpha - First Autonomous Video | milestone | Sprint 6 (Weeks 11-12) | PH3 |
| [CP4](#cp4) | Render Budget | checkpoint | Sprint 7 (Weeks 13-14) | PH4 |
| [M4](#m4) | MVP Complete - v0.9-mvp | milestone | Sprint 8 (Weeks 15-16) | PH4 |
| [CP5](#cp5) | Sandbox Security Gate | checkpoint | Sprint 9 (Weeks 17-18) | PH5 |
| [M5](#m5) | Feature Freeze - v0.95-beta | milestone | Sprint 10 (Weeks 19-20) | PH5 |
| [CP6](#cp6) | Security and Performance Gate | checkpoint | Sprint 11 (Weeks 21-22) | PH6 |
| [M6](#m6) | Release Candidate - v1.0-rc1 | milestone | Sprint 11 (Weeks 21-22) | PH6 |
| [M7](#m7) | v1.0-graduation Release and Demo | milestone | Sprint 12 (Weeks 23-24) | PH6 |

<a id="m0"></a>

## M0 - Architecture Baseline and Walking Skeleton

**Type:** milestone | **Due:** end of Sprint 1 (Weeks 1-2)

**Exit criteria**

- [ ] SRS v1.0 and MVP boundary signed off by the supervisor
- [ ] ADRs accepted for architecture style, languages, contracts, queue, storage, LLM abstraction and branching
- [ ] Walking skeleton upload-to-metadata flow works from a fresh clone and CI is required on main

**Requires:** [US-101](phases/phase-1-foundation.md#us-101---software-requirements-specification-with-measurable-nfrs), [US-103](phases/phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs), [US-114](phases/phase-1-foundation.md#us-114---docker-compose-environment-with-typed-configuration), [US-126](phases/phase-1-foundation.md#us-126---media-metadata-extraction-with-ffprobe)

**If missed:** Carry unresolved requirement questions into Sprint 2 as spikes; do not delay the skeleton.

<a id="cp1"></a>

## CP1 - Technology Feasibility

**Type:** checkpoint | **Due:** end of Sprint 1 (Weeks 1-2)

**Exit criteria**

- [ ] Faster-Whisper transcribes 10 minutes of speech in at most 3 minutes on the reference GPU, or a CPU-viable model is selected
- [ ] Remotion renders 60 seconds of 1080p with captions in at most 5 minutes on the reference machine
- [ ] The chosen LLM returns schema-valid tool calls for at least 9 of 10 scripted editing requests

**Requires:** [US-105](phases/phase-1-foundation.md#us-105---asr-and-vad-feasibility-spike), [US-106](phases/phase-1-foundation.md#us-106---rendering-feasibility-spike-ffmpeg-vs-remotion), [US-107](phases/phase-1-foundation.md#us-107---llm-tool-calling-feasibility-spike)

**If missed:** Select smaller ASR model, render previews at 720p, or switch the default LLM provider through the adapter layer.

<a id="m1"></a>

## M1 - v0.1 Ingest

**Type:** milestone | **Due:** end of Sprint 2 (Weeks 3-4)

**Exit criteria**

- [ ] Authenticated resumable upload, validation, proxy and thumbnail jobs work on staging
- [ ] Every job exposes Queued, Running, Completed, Failed, Retrying and Cancelled states
- [ ] CD deploys main to staging automatically

**Requires:** [US-127](phases/phase-1-foundation.md#us-127---media-validation-and-hostile-file-defense), [US-128](phases/phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation), [US-129](phases/phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine)

<a id="cp2"></a>

## CP2 - Perception Quality Gate

**Type:** checkpoint | **Due:** end of Sprint 3 (Weeks 5-6)

**Exit criteria**

- [ ] English WER at most 12 percent on the evaluation clips; Arabic WER measured and recorded
- [ ] Median word-timestamp error at most 100 ms against hand-aligned references
- [ ] Silence detection F1 at least 0.9 against labelled ranges

**Requires:** [US-201](phases/phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper), [US-202](phases/phase-2-perception-editing-core.md#us-202---voice-activity-detection-and-speech-segmentation), [US-204](phases/phase-2-perception-editing-core.md#us-204---silence-loudness-peak-and-energy-analysis)

**If missed:** Tune VAD and model size in Sprint 4; captions use segment timing until word timing meets the gate.

<a id="m2"></a>

## M2 - v0.2 Understand and Cut

**Type:** milestone | **Due:** end of Sprint 4 (Weeks 7-8)

**Exit criteria**

- [ ] Every uploaded talking-head video produces a versioned MediaAnalysis (transcript, VAD, silence, loudness, shots, faces)
- [ ] One-click silence removal renders a correct MP4 through the Tool SDK
- [ ] Tool SDK contract tests are frozen and green

**Requires:** [US-210](phases/phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation), [US-221](phases/phase-2-perception-editing-core.md#us-221---tool-executor-with-permissions-timeouts-and-remote-dispatch), [US-223](phases/phase-2-perception-editing-core.md#us-223---one-click-silence-removal-workflow), [US-225](phases/phase-2-perception-editing-core.md#us-225---end-to-end-test-of-the-silence-removal-workflow)

<a id="cp3"></a>

## CP3 - Agent Tool-Calling Reliability

**Type:** checkpoint | **Due:** end of Sprint 5 (Weeks 9-10)

**Exit criteria**

- [ ] At least 90 percent of agent tool calls are schema-valid on first attempt and 100 percent after validation feedback
- [ ] The agent has no path to shell, filesystem or network except through registered tools
- [ ] Iteration, token and cost budgets stop runaway runs in tests

**Requires:** [US-305](phases/phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling), [US-319](phases/phase-3-agent-mvp-alpha.md#us-319---tool-permission-model-and-injection-test-suite)

**If missed:** Constrain the tool set per step and use provider-native structured output; switch provider via adapter.

<a id="m3"></a>

## M3 - MVP Alpha - First Autonomous Video

**Type:** milestone | **Due:** end of Sprint 6 (Weeks 11-12)

**Exit criteria**

- [ ] Raw footage plus prompt produces a finished short-form video from the web UI without manual steps
- [ ] Output meets the platform preset (resolution, aspect ratio, duration within 10 percent of target)
- [ ] Evaluation harness v0 runs nightly on 6 videos with render success rate at least 90 percent

**Requires:** [US-307](phases/phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting), [US-308](phases/phase-3-agent-mvp-alpha.md#us-308---short-form-generation-for-platform-presets), [US-317](phases/phase-3-agent-mvp-alpha.md#us-317---live-agent-run-view-with-result-player-and-download), [US-320](phases/phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0), [US-321](phases/phase-3-agent-mvp-alpha.md#us-321---mvp-end-to-end-test-in-ci)

**If missed:** Go/No-Go at Sprint 6 review. If missed, Sprint 7 starts with a stabilization story and Phase 5 P2 stories move to stretch.

<a id="cp4"></a>

## CP4 - Render Budget

**Type:** checkpoint | **Due:** end of Sprint 7 (Weeks 13-14)

**Exit criteria**

- [ ] 60-second 1080p render with captions and motion graphics completes in at most 3 minutes on the reference machine
- [ ] Visual regression suite for built-in components is green in CI

**Requires:** [US-402](phases/phase-4-mvp-complete.md#us-402---motion-graphics-pack-v1), [US-425](phases/phase-4-mvp-complete.md#us-425---visual-regression-testing-for-components-and-renders)

**If missed:** Pull incremental rendering (US-607) forward into Sprint 8 and reduce preview resolution.

<a id="m4"></a>

## M4 - MVP Complete - v0.9-mvp

**Type:** milestone | **Due:** end of Sprint 8 (Weeks 15-16)

**Exit criteria**

- [ ] Every capability in the MVP boundary works end-to-end on talking-head, podcast and educational footage
- [ ] Basic self-review detects and fixes at least caption overflow, loudness and black-frame issues
- [ ] Conversational edits modify the existing project and create a new version
- [ ] Mid-project academic review held with the MVP evaluation report

**Requires:** [US-413](phases/phase-4-mvp-complete.md#us-413---basic-b-roll-insertion), [US-414](phases/phase-4-mvp-complete.md#us-414---music-selection-from-the-registry), [US-415](phases/phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits), [US-421](phases/phase-4-mvp-complete.md#us-421---automatic-single-refinement-pass), [US-426](phases/phase-4-mvp-complete.md#us-426---mvp-evaluation-report-and-human-acceptance-pilot)

**If missed:** MVP scope is locked; any gap is fixed in Sprint 9 before advanced stories start.

<a id="cp5"></a>

## CP5 - Sandbox Security Gate

**Type:** checkpoint | **Due:** end of Sprint 9 (Weeks 17-18)

**Exit criteria**

- [ ] Sandbox escape, network egress and resource-exhaustion suites pass
- [ ] Generated or downloaded code cannot run outside the sandbox (verified by tests, not convention)

**Requires:** [US-501](phases/phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code)

**If missed:** Generated components and external packages stay disabled outside development until the gate passes.

<a id="m5"></a>

## M5 - Feature Freeze - v0.95-beta

**Type:** milestone | **Due:** end of Sprint 10 (Weeks 19-20)

**Exit criteria**

- [ ] All scheduled P0-P2 stories merged; remaining work moved to the stretch backlog
- [ ] Scenarios A-G each succeed at least once on staging
- [ ] Critic refinement loop improves the quality score on at least 60 percent of evaluation videos

**Requires:** [US-511](phases/phase-5-advanced-autonomy.md#us-511---multimodal-visual-critique), [US-513](phases/phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller), [US-520](phases/phase-5-advanced-autonomy.md#us-520---full-autonomous-creativity-level-with-approval-gates)

<a id="cp6"></a>

## CP6 - Security and Performance Gate

**Type:** checkpoint | **Due:** end of Sprint 11 (Weeks 21-22)

**Exit criteria**

- [ ] No open critical or high vulnerabilities in code, dependencies or images
- [ ] Prompt-injection and sandbox red-team findings fixed or formally accepted
- [ ] A 10-minute source becomes a 45-second reel in at most 15 minutes (p95) on the reference GPU

**Requires:** [US-601](phases/phase-6-hardening-release.md#us-601---security-test-suite-and-asvs-review), [US-602](phases/phase-6-hardening-release.md#us-602---prompt-injection-and-agent-safety-red-team), [US-603](phases/phase-6-hardening-release.md#us-603---sandbox-and-resource-exhaustion-red-team), [US-606](phases/phase-6-hardening-release.md#us-606---performance-benchmark-suite-and-budgets)

<a id="m6"></a>

## M6 - Release Candidate - v1.0-rc1

**Type:** milestone | **Due:** end of Sprint 11 (Weeks 21-22)

**Exit criteria**

- [ ] No open P0/P1 defects; E2E, integration and evaluation suites green
- [ ] Dashboards and agent run inspector available on staging

**Requires:** [US-608](phases/phase-6-hardening-release.md#us-608---metrics-distributed-tracing-dashboards-and-error-tracking), [US-609](phases/phase-6-hardening-release.md#us-609---agent-run-inspector), [US-611](phases/phase-6-hardening-release.md#us-611---bug-bash-and-stabilization)

<a id="m7"></a>

## M7 - v1.0-graduation Release and Demo

**Type:** milestone | **Due:** end of Sprint 12 (Weeks 23-24)

**Exit criteria**

- [ ] Fresh deployment from a clean machine succeeds using only documented steps
- [ ] Evaluation report, documentation set and diagrams complete
- [ ] v1.0-graduation tagged; demo rehearsed twice with recorded backups

**Requires:** [US-613](phases/phase-6-hardening-release.md#us-613---full-evaluation-run-with-ablations), [US-615](phases/phase-6-hardening-release.md#us-615---scripted-evaluation-scenarios-a-g), [US-616](phases/phase-6-hardening-release.md#us-616---architecture-and-developer-documentation-with-required-diagrams), [US-619](phases/phase-6-hardening-release.md#us-619---fresh-deployment-verification-and-bootstrap-script), [US-620](phases/phase-6-hardening-release.md#us-620---release-freeze-v10-graduation), [US-621](phases/phase-6-hardening-release.md#us-621---graduation-demo-preparation-and-rehearsal)
