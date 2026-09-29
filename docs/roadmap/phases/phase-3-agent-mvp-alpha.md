<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# PH3 - Autonomous Editor Agent - MVP Alpha

| Sprints | Duration | Release / increment | Scope | Planned points | Milestones |
|---|---|---|---|---|---|
| Sprint 5, Sprint 6 | Weeks 9-12 | v0.3 "MVP Alpha" | mvp | 97 SP (21 stories) | CP3 Agent Tool-Calling Reliability, M3 MVP Alpha - First Autonomous Video |

[Roadmap overview](../README.md) | [Sprint plan](../sprints.md) | [Dependencies](../dependencies.md) | [Milestones](../milestones.md)

## 1. Objective

Introduce the autonomous AI editor. A provider-agnostic LLM layer and an observe-plan-act agent loop operate on the project exclusively through Tool SDK tools, using MediaAnalysis as perception. By the end of the phase the system turns raw footage plus a natural-language prompt into a finished short-form video (highlight selection, silence and filler removal, captions, auto-reframing, zooms, music with ducking) from the web UI - the first end-to-end demonstration (milestone M3). Covers original Phase 6 plus the MVP parts of Phases 4, 7 and 13.

## 2. Epics

| Epic | Goal | Sprints | Points | Depends on | Can run in parallel with |
|---|---|---|---|---|---|
| [EP-13](phase-3-agent-mvp-alpha.md#ep-13---llm-provider-layer) LLM Provider Layer | Make every LLM interaction provider-agnostic, testable, versioned and budgeted. | S5 | 7 | [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline) | [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools) |
| [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop) Agent Orchestrator and Decision Loop | Run an autonomous, observable and bounded observe-plan-act editing loop over the project state. | S5, S6 | 34 | [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations), [EP-13](phase-3-agent-mvp-alpha.md#ep-13---llm-provider-layer), [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing), [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding), [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis), [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model), [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools) | - |
| [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools) Core Editing Tools | Provide the MVP editing capabilities as SDK tools usable by both the agent and deterministic workflows. | S5, S6 | 32 | [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine), [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations), [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding), [EP-07](phase-2-perception-editing-core.md#ep-07---audio-understanding), [EP-08](phase-2-perception-editing-core.md#ep-08---visual-understanding) | [EP-13](phase-3-agent-mvp-alpha.md#ep-13---llm-provider-layer) |
| [EP-16](phase-3-agent-mvp-alpha.md#ep-16---mvp-web-experience) MVP Web Experience | Let a creator run the whole autonomous edit from the browser. | S5, S6 | 13 | [EP-03](phase-1-foundation.md#ep-03---identity-and-project-management), [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core), [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools) | - |
| [EP-17](phase-3-agent-mvp-alpha.md#ep-17---agent-safety-and-evaluation) Agent Safety and Evaluation | Keep the agent inside its permissions and measure its quality from the first autonomous run. | S5, S6 | 11 | [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations), [EP-16](phase-3-agent-mvp-alpha.md#ep-16---mvp-web-experience) | - |

## 3-6. Features, User Stories, Technical Tasks and Acceptance Criteria

Task tags: `TEST`, `DOC`, `CI/CD`, `SECURITY`, `INTEGRATION` mark testing, documentation, CI/CD, security and integration work that is built into the story itself. Every story is also subject to the global [story Definition of Done](../README.md#definition-of-done-story-level).

### EP-13 - LLM Provider Layer

**Epic goal:** Make every LLM interaction provider-agnostic, testable, versioned and budgeted.

#### FT-13.1 - Provider Ports and Adapters

##### US-301 - LLM provider port with capability descriptors and adapters

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 5 | Backend Engineer | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs), [US-107](phase-1-foundation.md#us-107---llm-tool-calling-feasibility-spike) | Parallel - can start on day 1 of the sprint |

**User story:** As an agent developer, I want one interface for chat, tool calling, structured output and vision across providers, so that models can be swapped or added without touching agent logic.

**Technical tasks**

- [ ] `US-301-T1` Define segregated ports (IChatModel, IToolCallingModel, IStructuredOutputModel, IVisionModel) and a ProviderCapabilities descriptor (context window, vision, JSON mode, cost per token)
- [ ] `US-301-T2` Implement an OpenAI-compatible adapter (covers hosted OpenAI-style APIs, vLLM and Ollama) and a second native adapter (Anthropic or Gemini)
- [ ] `US-301-T3` Add retries with jitter, timeouts, rate limiting, token and cost accounting per call
- [ ] `US-301-T4` Implement a record/replay fake provider for deterministic tests
- [ ] `US-301-T5` `SECURITY` Load API keys from the secret store, never log prompts containing secrets, enforce per-run budget caps
- [ ] `US-301-T6` `TEST` Provider conformance test suite that every adapter must pass

**Acceptance criteria**

- [ ] AC1. Switching the default provider is a configuration change with no code change
- [ ] AC2. Both adapters pass the same conformance suite
- [ ] AC3. Every call records tokens, cost, latency and model identifier

#### FT-13.2 - Prompt Management

##### US-302 - Versioned prompt registry

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 5 | Backend Engineer | [US-111](phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) | Parallel - can start on day 1 of the sprint |

**User story:** As an AI engineer, I want prompts stored as versioned templates, so that prompt changes are reviewed, reproducible and traceable to results.

**Technical tasks**

- [ ] `US-302-T1` Store prompts as templates with front-matter metadata (id, version, purpose, variables) under prompts/
- [ ] `US-302-T2` Implement a PromptRegistry with typed variable rendering and version pinning
- [ ] `US-302-T3` `CI/CD` Add a lint rule rejecting inline prompt strings longer than a threshold in application code
- [ ] `US-302-T4` `TEST` Unit tests for rendering and missing-variable errors

**Acceptance criteria**

- [ ] AC1. Every agent run records the id and version of each prompt it used
- [ ] AC2. A missing template variable fails at render time with a clear error

### EP-14 - Agent Orchestrator and Decision Loop

**Epic goal:** Run an autonomous, observable and bounded observe-plan-act editing loop over the project state.

#### FT-14.1 - Agent Runtime

##### US-303 - AgentRun lifecycle, agent worker and run API

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 5 | Backend Engineer | [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine), [US-215](phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to start, follow and cancel an AI editing run, so that long autonomous edits are controllable.

**Technical tasks**

- [ ] `US-303-T1` Model AgentRun with states Pending, Observing, Planning, Executing, Rendering, Evaluating, Completed, Failed and Cancelled
- [ ] `US-303-T2` Run the agent as a job in agent-worker with a checkpoint after every step so a crashed run can resume
- [ ] `US-303-T3` Persist every step (decision, tool call, result) as AgentStep records
- [ ] `US-303-T4` Expose start, get and cancel endpoints with project-level authorization
- [ ] `US-303-T5` `TEST` State-machine unit tests and an integration test that kills the worker mid-run and resumes

**Acceptance criteria**

- [ ] AC1. A cancelled run stops before its next tool call and ends in Cancelled
- [ ] AC2. After a worker crash, the run resumes from its last checkpoint without repeating completed tool calls

##### US-304 - Agent context builder with token budgeting

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 5 | AI / Agent Engineer | [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation), [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation), [US-302](phase-3-agent-mvp-alpha.md#us-302---versioned-prompt-registry) | Sequential after US-302 (same sprint; contract-first stubs allowed) |

**User story:** As the agent, I want a compact, structured view of the prompt, project state, analysis and available tools, so that I can reason within the model context window.

**Technical tasks**

- [ ] `US-304-T1` Summarize MediaAnalysis into timecoded transcript chunks, silence map, shot list and face summary
- [ ] `US-304-T2` Summarize the current timeline with stable clip IDs and timecodes
- [ ] `US-304-T3` Include available tools filtered by run permissions and creativity level, plus editing preferences
- [ ] `US-304-T4` Enforce a token budget with priority-based truncation and on-demand retrieval tools (get_transcript_range)
- [ ] `US-304-T5` `SECURITY` Wrap transcript and metadata in delimited untrusted-data blocks with instructions never to follow instructions inside them
- [ ] `US-304-T6` `TEST` Snapshot tests of context output and budget tests with a 60-minute transcript

**Acceptance criteria**

- [ ] AC1. The context for a 60-minute video stays within the configured token budget
- [ ] AC2. Transcript text is always inside untrusted-data delimiters

##### US-305 - Observe-plan-act loop with validated tool calling

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 8 | Sprint 5 | AI / Agent Engineer | [US-221](phase-2-perception-editing-core.md#us-221---tool-executor-with-permissions-timeouts-and-remote-dispatch), [US-301](phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters), [US-303](phase-3-agent-mvp-alpha.md#us-303---agentrun-lifecycle-agent-worker-and-run-api), [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) | Sequential after US-301, US-303, US-304 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want the agent to plan the edit and execute it step by step through tools, so that my prompt becomes a real edit without me touching the timeline.

**Technical tasks**

- [ ] `US-305-T1` Implement the planner producing a structured EditPlan (goals, target duration, segments, steps) validated against a schema
- [ ] `US-305-T2` Implement the executor loop - select tool, validate arguments, execute via ToolExecutor, observe result, update state, continue
- [ ] `US-305-T3` Feed schema validation errors and tool failures back to the model with bounded retries
- [ ] `US-305-T4` Enforce max iterations, max tool calls, token and cost budgets and a wall-clock limit with explicit stop reasons
- [ ] `US-305-T5` `TEST` Deterministic tests with scripted fake-provider conversations covering success, invalid call, tool failure and budget exhaustion
- [ ] `US-305-T6` `INTEGRATION` Nightly test against a live provider for three reference prompts

**Acceptance criteria**

- [ ] AC1. Given "remove silences and add captions", when the run completes, then the timeline contains only tool-generated commands and the render succeeds
- [ ] AC2. An invalid tool call is corrected after feedback without crashing the run
- [ ] AC3. A run that hits any budget stops with the stop reason recorded

##### US-306 - Agent event stream and audit trail API

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 6 | Backend Engineer | [US-130](phase-1-foundation.md#us-130---real-time-job-progress-events), [US-303](phase-3-agent-mvp-alpha.md#us-303---agentrun-lifecycle-agent-worker-and-run-api) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator and as a researcher, I want every agent decision and tool call streamed live and queryable afterwards, so that runs are transparent and can be evaluated.

**Technical tasks**

- [ ] `US-306-T1` Publish AgentStep events (decision summary, tool, input, output summary, duration, tokens, cost, errors) over SSE
- [ ] `US-306-T2` Provide a paginated audit trail endpoint and a JSON export per run
- [ ] `US-306-T3` Redact secrets and large payloads from events while keeping hashes for traceability
- [ ] `US-306-T4` `TEST` Integration test asserting the complete ordered trail for a scripted run

**Acceptance criteria**

- [ ] AC1. Every tool call of a run appears in the audit trail with input, output summary and timing
- [ ] AC2. The exported JSON is sufficient to replay the run's commands on the original project version

#### FT-14.2 - Editorial Skills

##### US-307 - Highlight selection and semantic cutting

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 8 | Sprint 6 | AI / Agent Engineer | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper), [US-305](phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want the agent to choose the strongest, most relevant moments for my audience, so that a long recording becomes a focused short video.

**Technical tasks**

- [ ] `US-307-T1` Segment the transcript into sentence-level candidate units with timing and shot context
- [ ] `US-307-T2` Score candidates for relevance to the prompt and audience, standalone clarity and hook strength using structured LLM output
- [ ] `US-307-T3` Select units to meet the target duration within 10 percent, placing the strongest hook first, cutting only at sentence or word boundaries
- [ ] `US-307-T4` Emit the selection as timeline commands with rationale stored in the audit trail
- [ ] `US-307-T5` `TEST` Evaluation against human-selected highlights on the dataset (content retention metric)

**Acceptance criteria**

- [ ] AC1. Output duration is within 10 percent of the requested duration
- [ ] AC2. No cut falls inside a word
- [ ] AC3. Content retention against human references is reported by the evaluation harness

##### US-308 - Short-form generation for platform presets

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 6 | Backend Engineer | [US-307](phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting), [US-310](phase-3-agent-mvp-alpha.md#us-310---auto-reframing-to-target-aspect-ratio) | Sequential after US-307 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to ask for a TikTok, Reel or Short and get the right format automatically, so that the video is ready to publish.

**Technical tasks**

- [ ] `US-308-T1` Define platform presets (resolution, aspect ratio, max duration, safe zones, loudness target) as configuration data
- [ ] `US-308-T2` Parse platform, duration and style constraints from the prompt into the EditPlan
- [ ] `US-308-T3` Orchestrate highlight selection, cleanup, reframing, captions and audio into one plan
- [ ] `US-308-T4` `TEST` Scenario tests for 9:16, 1:1 and 16:9 targets using recorded cassettes

**Acceptance criteria**

- [ ] AC1. Given "45-second Reel", then the output is 1080x1920, within 10 percent of 45 seconds and meets the loudness target
- [ ] AC2. Adding a new platform preset requires only a configuration entry

### EP-15 - Core Editing Tools

**Epic goal:** Provide the MVP editing capabilities as SDK tools usable by both the agent and deterministic workflows.

#### FT-15.1 - Cleanup Cutting

##### US-309 - Range removal tool for silences, fillers and repetitions

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 5 | Multimedia Engineer | [US-203](phase-2-perception-editing-core.md#us-203---filler-word-and-repetition-detection), [US-223](phase-2-perception-editing-core.md#us-223---one-click-silence-removal-workflow) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want one tool that removes a set of ranges with smart padding, so that silence and filler-word removal are clean and consistent.

**Technical tasks**

- [ ] `US-309-T1` Implement remove_ranges with padding, word-boundary snapping, minimum clip length and optional micro-crossfades
- [ ] `US-309-T2` Accept range sources (silence, filler, repetition, explicit) and record the source per removed range
- [ ] `US-309-T3` `TEST` Unit tests for overlapping ranges and boundary snapping; integration test on fixtures

**Acceptance criteria**

- [ ] AC1. Overlapping ranges are merged and no resulting clip is shorter than the minimum length
- [ ] AC2. Audio at cut points has no audible clicks (crossfade applied)

#### FT-15.2 - Framing and Motion

##### US-310 - Auto-reframing to target aspect ratio

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 8 | Sprint 5 | Multimedia Engineer | [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking), [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want horizontal footage reframed to vertical with the speaker always in frame, so that it looks native on short-form platforms.

**Technical tasks**

- [ ] `US-310-T1` Compute a crop window path from face tracks with dead-zone, smoothing (One Euro or Kalman filter) and maximum pan speed
- [ ] `US-310-T2` Handle no-face segments with center crop or blurred-background padding and shot-boundary resets
- [ ] `US-310-T3` Store the crop path as keyframed effect parameters on clips, rendered by the Remotion strategy
- [ ] `US-310-T4` Expose reframe_video as an SDK tool with target aspect ratio and style options
- [ ] `US-310-T5` `TEST` Tests asserting the tracked face stays inside the frame for at least 95 percent of frames on fixtures

**Acceptance criteria**

- [ ] AC1. On the single-speaker fixture the face stays fully inside the 9:16 frame for at least 95 percent of frames
- [ ] AC2. The crop path has no jitter above the configured threshold

##### US-311 - Zoom and punch-in effects

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 6 | Generative Video / Remotion Engineer | [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking), [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want to add smooth zooms to emphasize important words, so that talking-head footage feels dynamic.

**Technical tasks**

- [ ] `US-311-T1` Implement add_zoom (time range, intensity, easing, anchor at face center or a point) as a Remotion effect
- [ ] `US-311-T2` Clamp zoom so the face is never cropped out and combine correctly with reframing
- [ ] `US-311-T3` `TEST` Visual snapshot tests at start, middle and end of a zoom

**Acceptance criteria**

- [ ] AC1. Zooms follow the specified easing and never crop the tracked face
- [ ] AC2. Zoom intensity is a parameter recorded in the timeline

#### FT-15.3 - Captions

##### US-312 - Word-synchronized caption component

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 5 | Generative Video / Remotion Engineer | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper), [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) | Parallel - can start on day 1 of the sprint |

**User story:** As a viewer, I want professional captions that highlight words as they are spoken, so that the video is engaging without sound.

**Technical tasks**

- [ ] `US-312-T1` Build a Remotion caption component driven by word timestamps with active-word highlight styles
- [ ] `US-312-T2` Support right-to-left scripts and Arabic shaping, outline and shadow styles and per-word emphasis
- [ ] `US-312-T3` Define its props schema so it registers with the component factory
- [ ] `US-312-T4` `TEST` Visual snapshot tests for English and Arabic captions

**Acceptance criteria**

- [ ] AC1. Highlighted words change within one frame of their timestamps
- [ ] AC2. Arabic captions render right-to-left with correct shaping

##### US-313 - Caption tool with segmentation, readability rules and safe zones

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 6 | Generative Video / Remotion Engineer | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation), [US-312](phase-3-agent-mvp-alpha.md#us-312---word-synchronized-caption-component) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want an add_caption tool that splits speech into readable lines placed inside platform safe zones, so that captions are legible and never hidden by platform UI.

**Technical tasks**

- [ ] `US-313-T1` Segment words into caption blocks using max characters per line, max lines, min duration and reading speed limits
- [ ] `US-313-T2` Place captions using platform safe-zone presets and avoid face regions when possible
- [ ] `US-313-T3` Register add_caption and update_caption_style as SDK tools
- [ ] `US-313-T4` `TEST` Unit tests for segmentation rules and placement

**Acceptance criteria**

- [ ] AC1. No caption block exceeds the configured characters per line or reading speed
- [ ] AC2. Captions stay inside the platform safe zone for every preset

#### FT-15.4 - Audio Tools

##### US-314 - Audio normalization, music and ducking tools

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 6 | Multimedia Engineer | [US-202](phase-2-perception-editing-core.md#us-202---voice-activity-detection-and-speech-segmentation), [US-204](phase-2-perception-editing-core.md#us-204---silence-loudness-peak-and-energy-analysis), [US-222](phase-2-perception-editing-core.md#us-222---core-ffmpeg-editing-tools) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want balanced voice and background music, so that speech is always clear and the loudness fits the platform.

**Technical tasks**

- [ ] `US-314-T1` Implement mix_audio, add_music (user-provided or bundled default track) with fades and loop or trim to length
- [ ] `US-314-T2` Implement ducking driven by VAD speech regions with attack and release parameters
- [ ] `US-314-T3` Implement two-pass loudness normalization to the preset target (for example -14 LUFS, true peak -1 dBTP)
- [ ] `US-314-T4` `TEST` Integration tests measuring output loudness and music level under speech

**Acceptance criteria**

- [ ] AC1. Final integrated loudness is within 1 LU of the preset target and true peak below -1 dBTP
- [ ] AC2. Music is at least 12 dB below speech during speech regions

#### FT-15.5 - Render Profiles

##### US-315 - Preview and final render profiles with output validation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 6 | Generative Video / Remotion Engineer | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping), [US-218](phase-2-perception-editing-core.md#us-218---ffmpeg-render-strategy-behind-irenderstrategy) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want a fast preview and a high-quality final export, so that I can review quickly and publish in full quality.

**Technical tasks**

- [ ] `US-315-T1` Add preview (proxy-based 540p, fast encode) and final (1080p high quality) render profiles
- [ ] `US-315-T2` Validate output duration, resolution, streams and loudness after rendering and fail with a reason if invalid
- [ ] `US-315-T3` Link renders to project versions and expose signed download URLs
- [ ] `US-315-T4` `TEST` Integration tests for both profiles

**Acceptance criteria**

- [ ] AC1. A preview of a 45-second reel renders at least 3 times faster than the final render
- [ ] AC2. An invalid output is never marked as completed

### EP-16 - MVP Web Experience

**Epic goal:** Let a creator run the whole autonomous edit from the browser.

#### FT-16.1 - Prompt-Driven Editing Flow

##### US-316 - New project wizard with prompt, platform and duration

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 5 | Frontend Engineer | [US-125](phase-1-foundation.md#us-125---media-library-with-thumbnails-and-proxy-playback) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want a guided flow to upload footage, choose the platform, aspect ratio and duration and write my prompt, so that I can start an AI edit in a minute.

**Technical tasks**

- [ ] `US-316-T1` Build wizard steps (upload footage, platform, aspect ratio, duration, prompt) with validation
- [ ] `US-316-T2` Show analysis readiness and start the agent run through the run API
- [ ] `US-316-T3` Save drafts so a user can leave and return
- [ ] `US-316-T4` `TEST` E2E test of the wizard using API mocks for the run endpoint

**Acceptance criteria**

- [ ] AC1. A user can complete the wizard and start a run in under 60 seconds
- [ ] AC2. The run starts only after required analysis is complete, with a clear waiting state

##### US-317 - Live agent run view with result player and download

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 6 | Frontend Engineer | [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api), [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) | Sequential after US-306, US-315 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to watch what the AI is doing and then review and download the result, so that I trust the edit.

**Technical tasks**

- [ ] `US-317-T1` Show a live step list (plan, tool calls, renders) from the event stream with cancel
- [ ] `US-317-T2` Show the result in the player with a before/after toggle and download buttons
- [ ] `US-317-T3` Show failure reasons and a retry action
- [ ] `US-317-T4` `TEST` Component tests with a recorded event stream; E2E in US-321

**Acceptance criteria**

- [ ] AC1. Steps appear within one second of being emitted
- [ ] AC2. The user can compare original and edited video side by side

##### US-318 - Project runs and renders overview

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 6 | Frontend Engineer | [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api) | Sequential after US-306 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to see all runs and renders of a project, so that I can return to earlier results.

**Technical tasks**

- [ ] `US-318-T1` List runs with prompt, status, duration, cost and linked renders
- [ ] `US-318-T2` Open any run's audit view and render
- [ ] `US-318-T3` `TEST` Component tests for list states

**Acceptance criteria**

- [ ] AC1. Every completed run links to its render and audit trail
- [ ] AC2. Failed runs show the stop reason

### EP-17 - Agent Safety and Evaluation

**Epic goal:** Keep the agent inside its permissions and measure its quality from the first autonomous run.

#### FT-17.1 - Agent Safety

##### US-319 - Tool permission model and injection test suite

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 5 | DevOps & QA (shared) | [US-108](phase-1-foundation.md#us-108---risk-register-and-threat-model-v0), [US-221](phase-2-perception-editing-core.md#us-221---tool-executor-with-permissions-timeouts-and-remote-dispatch) | Parallel - can start on day 1 of the sprint |

**User story:** As the security owner, I want the agent restricted to explicitly granted tools and arguments, so that prompt injection cannot cause unintended actions.

**Technical tasks**

- [ ] `US-319-T1` `SECURITY` Define run-scoped permission sets (read media, write project, render) and argument allow-lists (asset IDs within the project only)
- [ ] `US-319-T2` `SECURITY` Verify there is no tool with shell, arbitrary file or network access
- [ ] `US-319-T3` `TEST` Injection suite - transcripts containing instructions, malicious filenames, tool arguments with path traversal, oversized arguments
- [ ] `US-319-T4` `DOC` Document the agent security model

**Acceptance criteria**

- [ ] AC1. Every injection test case ends without an unauthorized tool call or side effect
- [ ] AC2. A tool call referencing an asset from another project is rejected

#### FT-17.2 - MVP Evaluation

##### US-320 - Evaluation harness v0

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 6 | DevOps & QA (shared) | [US-110](phase-1-foundation.md#us-110---evaluation-dataset-collection-and-metric-definitions), [US-305](phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling) | Parallel - can start on day 1 of the sprint |

**User story:** As the AI engineer, I want an automated harness that runs the agent on the dataset and computes metrics, so that we know objectively whether changes improve the editor.

**Technical tasks**

- [ ] `US-320-T1` Build a CLI that runs configured prompts on dataset videos and stores outputs, audit trails and metrics
- [ ] `US-320-T2` Compute render success rate, duration accuracy, silence removal accuracy, caption WER and sync error, content retention
- [ ] `US-320-T3` `CI/CD` Run nightly on 6 videos and publish an HTML report as a CI artifact
- [ ] `US-320-T4` `DOC` Document how to add a metric or a dataset item

**Acceptance criteria**

- [ ] AC1. A nightly report lists every metric per video with the commit, model and prompt versions
- [ ] AC2. Metric regressions above a configured threshold are flagged in the report

##### US-321 - MVP end-to-end test in CI

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 6 | DevOps & QA (shared) | [US-308](phase-3-agent-mvp-alpha.md#us-308---short-form-generation-for-platform-presets), [US-317](phase-3-agent-mvp-alpha.md#us-317---live-agent-run-view-with-result-player-and-download) | Sequential after US-308, US-317 (same sprint; contract-first stubs allowed) |

**User story:** As the team, I want the full prompt-to-reel flow covered by an automated test, so that the MVP never regresses.

**Technical tasks**

- [ ] `US-321-T1` Record the fake-provider cassette for the 45-second Reel prompt on the podcast fixture
- [ ] `US-321-T2` `TEST` Playwright test - wizard, run with fake-provider cassette, wait for render, assert preset compliance via API
- [ ] `US-321-T3` `CI/CD` Add to the PR E2E suite with CPU models and to nightly with a live provider

**Acceptance criteria**

- [ ] AC1. The test passes in CI and fails if any stage breaks
- [ ] AC2. Runtime stays under 10 minutes in PR CI

## 7. Dependencies

### Phase-level

- Depends on [PH2](phase-2-perception-editing-core.md) Perception Engine and Editing Core.
- The agent depends on the frozen Tool SDK v1 (US-219, US-221) and the MediaAnalysis schema (US-208); no agent code may call FFmpeg, Remotion or storage directly.
- External - production LLM API keys with a monthly budget cap configured before Sprint 5.
- The evaluation harness (US-320) uses the dataset from US-110.
- Unblocks [PH4](phase-4-mvp-complete.md) MVP Completion - Generative Editing, Design System and Interactive Workspace.

### Cross-phase story dependencies (inputs from earlier phases)

| Story | Needs | From phase | Ready by |
|---|---|---|---|
| [US-301](phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters) LLM provider port with capability descriptors and adapters | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) Architecture baseline, module boundaries and ADRs | PH1 | Sprint 1 |
| [US-301](phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters) LLM provider port with capability descriptors and adapters | [US-107](phase-1-foundation.md#us-107---llm-tool-calling-feasibility-spike) LLM tool-calling feasibility spike | PH1 | Sprint 1 |
| [US-302](phase-3-agent-mvp-alpha.md#us-302---versioned-prompt-registry) Versioned prompt registry | [US-111](phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) Monorepo scaffold with enforced architecture rules | PH1 | Sprint 1 |
| [US-303](phase-3-agent-mvp-alpha.md#us-303---agentrun-lifecycle-agent-worker-and-run-api) AgentRun lifecycle, agent worker and run API | [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) Job queue abstraction with job state machine | PH1 | Sprint 2 |
| [US-303](phase-3-agent-mvp-alpha.md#us-303---agentrun-lifecycle-agent-worker-and-run-api) AgentRun lifecycle, agent worker and run API | [US-215](phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history) Edit commands with undo, redo and replayable history | PH2 | Sprint 3 |
| [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) Agent context builder with token budgeting | [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation) Analysis orchestration and aggregation | PH2 | Sprint 3 |
| [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) Agent context builder with token budgeting | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) Tool manifest, registry and schema validation | PH2 | Sprint 4 |
| [US-305](phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling) Observe-plan-act loop with validated tool calling | [US-221](phase-2-perception-editing-core.md#us-221---tool-executor-with-permissions-timeouts-and-remote-dispatch) Tool executor with permissions, timeouts and remote dispatch | PH2 | Sprint 4 |
| [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api) Agent event stream and audit trail API | [US-130](phase-1-foundation.md#us-130---real-time-job-progress-events) Real-time job progress events | PH1 | Sprint 2 |
| [US-307](phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting) Highlight selection and semantic cutting | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) Word-level transcription with Faster-Whisper | PH2 | Sprint 3 |
| [US-309](phase-3-agent-mvp-alpha.md#us-309---range-removal-tool-for-silences-fillers-and-repetitions) Range removal tool for silences, fillers and repetitions | [US-203](phase-2-perception-editing-core.md#us-203---filler-word-and-repetition-detection) Filler-word and repetition detection | PH2 | Sprint 4 |
| [US-309](phase-3-agent-mvp-alpha.md#us-309---range-removal-tool-for-silences-fillers-and-repetitions) Range removal tool for silences, fillers and repetitions | [US-223](phase-2-perception-editing-core.md#us-223---one-click-silence-removal-workflow) One-click silence removal workflow | PH2 | Sprint 4 |
| [US-310](phase-3-agent-mvp-alpha.md#us-310---auto-reframing-to-target-aspect-ratio) Auto-reframing to target aspect ratio | [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) Face detection and tracking | PH2 | Sprint 4 |
| [US-310](phase-3-agent-mvp-alpha.md#us-310---auto-reframing-to-target-aspect-ratio) Auto-reframing to target aspect ratio | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | PH2 | Sprint 4 |
| [US-311](phase-3-agent-mvp-alpha.md#us-311---zoom-and-punch-in-effects) Zoom and punch-in effects | [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) Face detection and tracking | PH2 | Sprint 4 |
| [US-311](phase-3-agent-mvp-alpha.md#us-311---zoom-and-punch-in-effects) Zoom and punch-in effects | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | PH2 | Sprint 4 |
| [US-312](phase-3-agent-mvp-alpha.md#us-312---word-synchronized-caption-component) Word-synchronized caption component | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) Word-level transcription with Faster-Whisper | PH2 | Sprint 3 |
| [US-312](phase-3-agent-mvp-alpha.md#us-312---word-synchronized-caption-component) Word-synchronized caption component | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | PH2 | Sprint 4 |
| [US-313](phase-3-agent-mvp-alpha.md#us-313---caption-tool-with-segmentation-readability-rules-and-safe-zones) Caption tool with segmentation, readability rules and safe zones | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) Tool manifest, registry and schema validation | PH2 | Sprint 4 |
| [US-314](phase-3-agent-mvp-alpha.md#us-314---audio-normalization-music-and-ducking-tools) Audio normalization, music and ducking tools | [US-202](phase-2-perception-editing-core.md#us-202---voice-activity-detection-and-speech-segmentation) Voice activity detection and speech segmentation | PH2 | Sprint 3 |
| [US-314](phase-3-agent-mvp-alpha.md#us-314---audio-normalization-music-and-ducking-tools) Audio normalization, music and ducking tools | [US-204](phase-2-perception-editing-core.md#us-204---silence-loudness-peak-and-energy-analysis) Silence, loudness, peak and energy analysis | PH2 | Sprint 3 |
| [US-314](phase-3-agent-mvp-alpha.md#us-314---audio-normalization-music-and-ducking-tools) Audio normalization, music and ducking tools | [US-222](phase-2-perception-editing-core.md#us-222---core-ffmpeg-editing-tools) Core FFmpeg editing tools | PH2 | Sprint 4 |
| [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) Preview and final render profiles with output validation | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | PH2 | Sprint 4 |
| [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) Preview and final render profiles with output validation | [US-218](phase-2-perception-editing-core.md#us-218---ffmpeg-render-strategy-behind-irenderstrategy) FFmpeg render strategy behind IRenderStrategy | PH2 | Sprint 4 |
| [US-316](phase-3-agent-mvp-alpha.md#us-316---new-project-wizard-with-prompt-platform-and-duration) New project wizard with prompt, platform and duration | [US-125](phase-1-foundation.md#us-125---media-library-with-thumbnails-and-proxy-playback) Media library with thumbnails and proxy playback | PH1 | Sprint 2 |
| [US-319](phase-3-agent-mvp-alpha.md#us-319---tool-permission-model-and-injection-test-suite) Tool permission model and injection test suite | [US-108](phase-1-foundation.md#us-108---risk-register-and-threat-model-v0) Risk register and threat model v0 | PH1 | Sprint 1 |
| [US-319](phase-3-agent-mvp-alpha.md#us-319---tool-permission-model-and-injection-test-suite) Tool permission model and injection test suite | [US-221](phase-2-perception-editing-core.md#us-221---tool-executor-with-permissions-timeouts-and-remote-dispatch) Tool executor with permissions, timeouts and remote dispatch | PH2 | Sprint 4 |
| [US-320](phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0) Evaluation harness v0 | [US-110](phase-1-foundation.md#us-110---evaluation-dataset-collection-and-metric-definitions) Evaluation dataset collection and metric definitions | PH1 | Sprint 2 |

### Same-sprint sequencing (everything else in a sprint runs in parallel)

- Sprint 5: US-302 -> US-304 Agent context builder with token budgeting
- Sprint 5: US-301, US-303, US-304 -> US-305 Observe-plan-act loop with validated tool calling
- Sprint 6: US-307 -> US-308 Short-form generation for platform presets
- Sprint 6: US-306, US-315 -> US-317 Live agent run view with result player and download
- Sprint 6: US-306 -> US-318 Project runs and renders overview
- Sprint 6: US-308, US-317 -> US-321 MVP end-to-end test in CI

## 8. Sprint allocation

| Sprint | Sprint goal | Stories | SP | AI | MM | GEN | BE | FE | OPS | ALL |
|---|---|---|---|---|---|---|---|---|---|---|
| [Sprint 5](../sprints.md#sprint-5) | Introduce the provider-agnostic LLM layer and the observe-plan-act agent loop that edits the timeline exclusively through Tool SDK tools, with captions and auto-reframing available as tools. | US-301, US-302, US-303, US-304, US-305, US-309, US-310, US-312, US-316, US-319 | 49 | 13 | 11 | 5 | 12 | 5 | 3 | 0 |
| [Sprint 6](../sprints.md#sprint-6) | Deliver the first complete autonomous edit - highlight selection to a target duration, captions, zooms, music with ducking, preview and final renders, and a live agent-run view in the web app. | US-306, US-307, US-308, US-311, US-313, US-314, US-315, US-317, US-318, US-320, US-321 | 48 | 8 | 5 | 11 | 8 | 8 | 8 | 0 |

## 9. Deliverables

- LLM provider port with capability descriptors, two provider adapters and a record/replay fake provider
- Versioned prompt registry
- AgentRun state machine, agent worker, run API, event stream and audit trail
- Context builder with token budgeting and untrusted-content isolation
- Observe-plan-act loop with schema-validated tool calling and budgets
- Highlight selection, semantic cutting and short-form generation for platform presets
- Range removal, auto-reframing, zoom, captions and audio/music tools
- Preview and final render profiles with output validation
- New-project wizard, live agent-run view and project runs overview
- Tool permission model, injection test suite, evaluation harness v0 and MVP E2E test

## 10. Definition of Done

The phase is done when all of the following hold (in addition to the story-level DoD for every story):

- [ ] Milestone M3 met - raw footage plus prompt produces a finished reel from the web UI with no manual steps
- [ ] Checkpoint CP3 met - tool-call validity at least 90 percent first attempt and 100 percent after feedback; runaway runs stopped by budgets
- [ ] Agent unit tests run deterministically against recorded LLM cassettes in PR CI; live-provider tests run nightly
- [ ] Every prompt used in production code is loaded from the prompt registry with a recorded version
- [ ] Every agent run stores a complete audit trail (decisions, tool calls, inputs, outputs, timing, tokens, cost)
- [ ] Injection tests prove transcript or metadata content cannot trigger tools outside the run's permission set
- [ ] Evaluation harness v0 runs nightly and its first report is attached to the Sprint 6 review
- [ ] v0.3 tagged, deployed to staging and demonstrated live at the Sprint 6 review

### Milestone exit criteria

**CP3 - Agent Tool-Calling Reliability** (end of Sprint 5)

- [ ] At least 90 percent of agent tool calls are schema-valid on first attempt and 100 percent after validation feedback
- [ ] The agent has no path to shell, filesystem or network except through registered tools
- [ ] Iteration, token and cost budgets stop runaway runs in tests

**M3 - MVP Alpha - First Autonomous Video** (end of Sprint 6)

- [ ] Raw footage plus prompt produces a finished short-form video from the web UI without manual steps
- [ ] Output meets the platform preset (resolution, aspect ratio, duration within 10 percent of target)
- [ ] Evaluation harness v0 runs nightly on 6 videos with render success rate at least 90 percent
