# Software Requirements Specification

| Field         | Value      |
| ------------- | ---------- |
| Product       | EditAgent  |
| Document      | SRS        |
| Version       | 1.0        |
| Date          | 2026-09-29 |
| Status        | APPROVED   |
| Approval      | APPROVED   |
| Approved by   | Supervisor |
| Approval date | 2026-09-30 |

The Supervisor approved SRS v1.0 and the MVP boundary on 2026-09-30. That approval is recorded here and satisfies US-101 AC3. No personal name is recorded. The approval does not change the requirements in this version.

## 1. Purpose

EditAgent turns raw footage and a natural-language instruction into a rendered short-form video. The system perceives the footage, plans an edit, applies tools, renders, critiques, and can refine. This SRS states the functional requirements, the measurable quality targets, the roles, and the rule that classifies later proposals as MVP, Advanced, or out of scope.

Sequencing stays in the Agile roadmap. Technology stays in accepted ADR-001 through ADR-008. Module ownership stays in [docs/architecture/modules.md](../architecture/modules.md). This document does not reopen those decisions.

## 2. Document history

| Version | Date       | Change                                                                                 | Approval                           |
| ------- | ---------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| 1.0     | 2026-09-29 | Initial baseline for US-101.                                                           | Drafted, then APPROVED             |
| 1.0     | 2026-09-30 | Supervisor approved SRS v1.0 and the MVP boundary. No text change to the requirements. | APPROVED. Approved by: Supervisor. |

## 3. Product context

EditAgent is a modular monolith plus workers (ADR-001). The web application is presentation. The API serves synchronous use cases. Workers perform analysis, media preparation, tool execution, agent steps, and rendering. Metadata is in PostgreSQL. Bytes are in S3-compatible object storage (ADR-005). Jobs cross process boundaries as JSON Schema documents (ADR-003) on a queue behind `IJobQueue` (ADR-004). Model vendors sit behind Agent ports (ADR-006). Timeline positions are integer microseconds (ADR-008). The AI worker is Python 3.11; the API, web app, and Node workers are TypeScript (ADR-002).

People use a browser. The browser is outside the application trust zone. External asset providers and LLM providers are outside that zone as well.

## 4. Roles

Identity owns the allow or deny decision. Projects owns membership rows. A person can hold one membership role on a Project and, separately, the Admin operator role.

| Role   | May do                                                                                                                                                | May not do                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Owner  | On a Project that already exists: manage Owner, Editor, and Viewer membership; upload; edit; start an AgentRun; render; download; delete the Project. | Read another User's Project. Delete is a soft delete (US-104, US-120).                           |
| Editor | On a Project that already exists: upload, edit, start an AgentRun, render, and download.                                                              | Delete the Project or change membership.                                                         |
| Viewer | Open the Project, play proxies, and download renders.                                                                                                 | Upload, edit, start an AgentRun, or change settings.                                             |
| Admin  | Administer accounts and operational health.                                                                                                           | Read Project media, or manage Project membership, solely because the account has the Admin role. |

Creating a Project is not an Owner or Editor action on a Project that does not yet exist. An authenticated User may create a Project. That operation atomically records the User as the new Project's Owner (FR-004, US-120).

A request for a protected Project or MediaAsset the caller cannot access returns HTTP 404 and does not reveal whether the identifier exists (FR-003, US-118).

A Creator is an authenticated product user performing creation or editing workflows. On an existing Project the Creator operates as Owner or Editor. When creating a new Project, the authenticated User becomes that Project's Owner. Creator is not a fifth role. The use-case actor Viewer is the Viewer role. The use-case actor Admin is the Admin operator role.

## 5. Functional requirements

Each requirement has a stable identifier, a scope class from section 8, and at least one use case. Wording here is the requirement. Stories in the roadmap implement it. They do not rename it.

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                        | Scope    | Use cases                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------- |
| FR-001 | A User can register and sign in. The stored password is an argon2id hash and is not recoverable as plaintext. Sessions expire.                                                                                                                                                                                                                                                                                     | MVP      | UC-01                      |
| FR-002 | Protected Project, MediaAsset, Timeline, render, AgentRun, and other application resources are authorized from the caller's identity and Project membership in section 4. Registration, sign-in, token refresh, and health or readiness endpoints do not require a role. A direct object-storage PUT that presents a valid time-limited presigned URL is authorized by that signed capability, not by an API role. | MVP      | UC-01, UC-02, UC-04        |
| FR-003 | A caller who is not allowed to see a protected Project or MediaAsset receives HTTP 404 without an existence leak.                                                                                                                                                                                                                                                                                                  | MVP      | UC-02                      |
| FR-004 | An authenticated User can create a Project, and that operation atomically makes the User its Owner. An Owner or Editor can read and update it. Only the Owner can delete it. Delete is a soft delete: the Project leaves normal listings and the operation does not by itself remove object-storage bytes (US-104, US-120).                                                                                        | MVP      | UC-03                      |
| FR-005 | A Project stores one platform preset and an optional target duration.                                                                                                                                                                                                                                                                                                                                              | MVP      | UC-03                      |
| FR-006 | The web application lists the caller's Projects and, inside a Project, its runs and renders.                                                                                                                                                                                                                                                                                                                       | MVP      | UC-03, UC-09               |
| FR-007 | Upload of a MediaAsset uses a time-limited presigned URL. The API does not proxy the object body. The storage key is server-generated.                                                                                                                                                                                                                                                                             | MVP      | UC-04                      |
| FR-008 | An upload that breaks section 6 is rejected with an error a Creator can read, and no Timeline is created from it.                                                                                                                                                                                                                                                                                                  | MVP      | UC-04                      |
| FR-009 | After a successful upload, the Creator can read container, codec, resolution, frame rate, and duration.                                                                                                                                                                                                                                                                                                            | MVP      | UC-05                      |
| FR-010 | EditAgent produces a playback proxy, extracted audio, and at least one thumbnail for an accepted video MediaAsset.                                                                                                                                                                                                                                                                                                 | MVP      | UC-05                      |
| FR-011 | Malformed containers, disguised extensions, oversized files, and path-traversal names are rejected and do not write outside the key prefix for that upload.                                                                                                                                                                                                                                                        | MVP      | UC-04                      |
| FR-012 | Transcription, analysis, media preparation, agent steps, and rendering run as Jobs. The web application shows progress for the Job.                                                                                                                                                                                                                                                                                | MVP      | UC-04, UC-06, UC-08, UC-09 |
| FR-013 | Logs for one HTTP request and the Jobs it causes carry one correlation identifier.                                                                                                                                                                                                                                                                                                                                 | MVP      | UC-04                      |
| FR-014 | Analysis of a video MediaAsset produces a versioned MediaAnalysis with word-level transcript times, speech segments, silence ranges, and loudness.                                                                                                                                                                                                                                                                 | MVP      | UC-06                      |
| FR-015 | Analysis can attach shot boundaries and face tracks to that MediaAnalysis.                                                                                                                                                                                                                                                                                                                                         | MVP      | UC-06                      |
| FR-016 | A second analysis for the same media fingerprint and analyzer version returns the stored MediaAnalysis and does not recompute it.                                                                                                                                                                                                                                                                                  | MVP      | UC-06                      |
| FR-017 | A Project has a Timeline of Tracks and Clips. Placements use integer microseconds.                                                                                                                                                                                                                                                                                                                                 | MVP      | UC-07                      |
| FR-018 | Timeline changes are EditCommands that support undo, redo, and replay.                                                                                                                                                                                                                                                                                                                                             | MVP      | UC-07                      |
| FR-019 | One-click silence removal commits an EditCommand sequence that cuts the silence ranges from Analysis.                                                                                                                                                                                                                                                                                                              | MVP      | UC-07                      |
| FR-020 | Editing operations that leave the process run only as registered Tools. Each Tool has a schema, a permission set, and a timeout. None declares a shell permission.                                                                                                                                                                                                                                                 | MVP      | UC-07, UC-08               |
| FR-021 | A Creator can start an AgentRun from a natural-language prompt. Tool calls are validated against JSON Schema before they execute. The run records events.                                                                                                                                                                                                                                                          | MVP      | UC-08                      |
| FR-022 | Given a platform preset and a requested duration, the AgentRun produces a Timeline whose render matches that preset's frame size, duration rule, safe zone, and loudness rule.                                                                                                                                                                                                                                     | MVP      | UC-08                      |
| FR-023 | Captions are placed only inside the safe zone of the active preset.                                                                                                                                                                                                                                                                                                                                                | MVP      | UC-08                      |
| FR-024 | The picture is reframed to the preset aspect ratio.                                                                                                                                                                                                                                                                                                                                                                | MVP      | UC-08                      |
| FR-025 | The Creator can include a zoom or punch-in Effect implemented as a Component.                                                                                                                                                                                                                                                                                                                                      | MVP      | UC-08                      |
| FR-026 | Speech loudness is normalized to the preset target. When music is present, it is ducked under speech.                                                                                                                                                                                                                                                                                                              | MVP      | UC-08, UC-12               |
| FR-027 | The Creator can render a preview and a final file. The final MVP file is H.264/AAC MP4 at or below 1080p.                                                                                                                                                                                                                                                                                                          | MVP      | UC-09                      |
| FR-028 | The agent can insert B-roll and music chosen from the local asset registry.                                                                                                                                                                                                                                                                                                                                        | MVP      | UC-12                      |
| FR-029 | After a render, deterministic checks cover caption overflow, loudness, and black or frozen frames. The MVP then runs at most one automatic refinement pass.                                                                                                                                                                                                                                                        | MVP      | UC-10                      |
| FR-030 | A later natural-language instruction changes the existing Timeline and stores a new version. Previous versions remain readable.                                                                                                                                                                                                                                                                                    | MVP      | UC-11                      |
| FR-031 | Code the agent generated or downloaded executes only inside the sandbox. It cannot install packages on the host or open a host shell.                                                                                                                                                                                                                                                                              | Advanced | UC-14                      |
| FR-032 | When the registry has no Component that satisfies the request, the agent can generate one, test-render it in the sandbox, and only then use it.                                                                                                                                                                                                                                                                    | Advanced | UC-14                      |
| FR-033 | When the local registry has no matching asset or Component, the agent can fetch one from an external provider into quarantine and must not promote it until the checks for that acquisition pass.                                                                                                                                                                                                                  | Advanced | UC-13                      |
| FR-034 | The critic can request further renders after the first refinement, stopping at a configured iteration cap.                                                                                                                                                                                                                                                                                                         | Advanced | UC-10                      |
| FR-035 | A Creator can save a BrandKit on a Project, and a later AgentRun can apply it.                                                                                                                                                                                                                                                                                                                                     | Advanced | UC-16                      |
| FR-036 | The agent can restructure a talk into hook, context, value, and payoff, and can cut on detected beats.                                                                                                                                                                                                                                                                                                             | Advanced | UC-08                      |

FR-031 through FR-036 are required for the advanced phase. They are not required for milestone M4.

## 6. Media rules

These are non-functional where they state a limit, and they are repeated in section 7 with a verification method. The numbers here are the normative limits.

### 6.1 Accepted inputs (MVP)

| Kind        | Accepted values                  | Rejection              |
| ----------- | -------------------------------- | ---------------------- |
| Container   | MP4, MOV, MKV, WebM              | Any other container    |
| Video codec | H.264, HEVC, VP9, AV1            | Any other video codec  |
| Audio codec | AAC, Opus, PCM                   | Any other audio codec  |
| Duration    | Less than or equal to 30 minutes | Longer than 30 minutes |
| Size        | Less than or equal to 4 GB       | Larger than 4 GB       |

Duration is the container duration. The normative rule is duration <= 1,800,000,000 microseconds. That value is 30 minutes: 30 × 60 × 1,000,000. A duration of 1,800,000,000 microseconds is accepted. A duration of 1,800,000,001 microseconds is rejected. Size is the object size in bytes. 4 GB means 4 × 1024³ bytes.

An image or audio-only MediaAsset may be stored when a later story adds that subtype. The MVP input promise for the short-form journeys is a video file that satisfies the table.

### 6.2 MVP output

| Property   | Threshold                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container  | MP4                                                                                                                                                                  |
| Video      | H.264, 4:2:0, long side at most 1920 pixels and short side at most 1080 pixels                                                                                       |
| Audio      | AAC                                                                                                                                                                  |
| Frame rate | The source rate when it is at most 60 frames per second; otherwise 60 frames per second. The rate is a rational numerator/denominator, not a binary float (ADR-008). |

Vertical presets use 1080×1920. That is 1080p portrait and satisfies the short-side rule.

## 7. Non-functional requirements

Every row has a threshold that can be measured and a verification method. Reading an identifier is enough to find both. AC1 of US-101 is this table.

| ID           | Quality           | Threshold                                                                                                                                                                                        | Verification                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-MEDIA-01 | Input container   | Accept only MP4, MOV, MKV, and WebM. Reject every other container with an error that names the container.                                                                                        | Upload one fixture of each accepted container and one AVI fixture. Assert the four accepted uploads are stored and the AVI upload is rejected with an error that names the container. (US-127)                                                                                                                                                                      |
| NFR-MEDIA-02 | Input video codec | Accept only H.264, HEVC, VP9, and AV1.                                                                                                                                                           | Upload one fixture each for H.264, HEVC, VP9, and AV1, and one MPEG-2 fixture. Assert the four are accepted and MPEG-2 is rejected. (US-127)                                                                                                                                                                                                                        |
| NFR-MEDIA-03 | Input audio codec | Accept only AAC, Opus, and PCM.                                                                                                                                                                  | Upload one fixture each for AAC, Opus, and PCM, and one MP3-only fixture. Assert the three are accepted and the MP3-only fixture is rejected. (US-127)                                                                                                                                                                                                              |
| NFR-MEDIA-04 | Input duration    | Accept duration <= 1,800,000,000 microseconds. Reject any larger duration.                                                                                                                       | At the metadata and domain-validation boundary, assert that 1,800,000,000 microseconds is accepted and 1,800,000,001 microseconds is rejected. A media-file fixture may use a coarser over-limit duration, such as 30 minutes plus 1 second, when the container cannot represent a one-microsecond difference; that coarser fixture must also be rejected. (US-127) |
| NFR-MEDIA-05 | Input size        | Reject when object size is greater than 4 × 1024³ bytes.                                                                                                                                         | Submit an object of size 4 × 1024³ bytes and assert the size check accepts it. Submit one byte more and assert rejection before analysis starts. (US-127)                                                                                                                                                                                                           |
| NFR-MEDIA-06 | Hostile input     | A malformed container, a disguised extension, a path-traversal file name, and an oversized object produce zero keys outside the upload prefix.                                                   | Run malformed-container, disguised-extension, path-traversal-name, and oversized-object fixtures. Assert each operation is rejected and an object-storage listing contains zero keys outside the assigned upload prefix. (US-127)                                                                                                                                   |
| NFR-OUT-01   | Final picture     | H.264 in MP4, dimensions inside the 1080p bound in section 6.2, matching the preset frame size when a preset is selected.                                                                        | Run ffprobe on the rendered file. Assert the container is MP4, the video codec is H.264, and both dimensions are inside the section 6.2 bound and equal the active preset frame size. (US-315)                                                                                                                                                                      |
| NFR-OUT-02   | Final audio       | AAC in the same MP4.                                                                                                                                                                             | Run ffprobe on the same rendered file. Assert an audio stream is present and its codec name is AAC. (US-315)                                                                                                                                                                                                                                                        |
| NFR-PERF-01  | Render budget     | A 60-second 1080p 9:16 render that includes captions and one animated title finishes in at most 180 seconds on the reference machine.                                                            | On the reference machine, render that 60-second fixture and assert the wall-clock time from start to finished file is at most 180 seconds. (CP4; measurement method from US-106)                                                                                                                                                                                    |
| NFR-PERF-02  | Metadata latency  | For a 10-minute accepted file, metadata is readable from the API within 120 seconds after the upload Job starts, measured on the reference machine and excluding network transfer of the source. | On the reference machine, start the metadata Job for a 10-minute fixture. Assert the metadata API returns container, codec, resolution, and duration within 120 seconds of Job start. Do not count source transfer. (US-117)                                                                                                                                        |
| NFR-PERF-03  | Health latency    | When dependencies are healthy, `GET /health` returns HTTP 200 in at most 1 second.                                                                                                               | With dependencies healthy, call `GET /health` and assert status 200 and elapsed time at most 1 second. (US-115)                                                                                                                                                                                                                                                     |
| NFR-REL-01   | Job completion    | Every Job that was accepted reaches a terminal state of completed or failed. A failed Job stores a reason string.                                                                                | Drive one Job to success and one to failure. Assert both end in completed or failed, and the failed record stores a non-empty reason string. (US-129)                                                                                                                                                                                                               |
| NFR-REL-02   | Worker crash      | If the worker process is killed while a Job is running, that Job is not still running 5 minutes later.                                                                                           | Start a Job, kill its worker process, then poll. Assert the Job is not in the running state 5 minutes after the kill. (US-129)                                                                                                                                                                                                                                      |
| NFR-SEC-01   | No shell          | The count of Tools whose manifest declares a shell permission is 0. The executor denies a call that needs an undeclared permission.                                                              | List every registered Tool manifest and assert the shell-permission count is 0. Submit a call that requires an undeclared permission and assert the executor denies it. (US-319)                                                                                                                                                                                    |
| NFR-SEC-02   | Isolation         | Cross-user Project and media reads return HTTP 404.                                                                                                                                              | Authenticate as user A and request user B's Project id and MediaAsset id. Assert both responses are HTTP 404 and neither body contains B's title or object key. (US-118)                                                                                                                                                                                            |
| NFR-SEC-03   | Password storage  | 100 percent of stored passwords in the test database are argon2id encodings.                                                                                                                     | After registration, read the stored password. Assert it matches an argon2id encoding and is not equal to the submitted plaintext. (US-118)                                                                                                                                                                                                                          |
| NFR-SEC-04   | Secrets           | A commit that contains a planted test secret fails the secret scanner. Images do not contain the source `.env`.                                                                                  | Run the secret scanner on a fixture commit that contains a known test secret and assert the scanner fails. Inspect a built image and assert it does not contain a source `.env` file. (US-113)                                                                                                                                                                      |
| NFR-USE-01   | First session     | A new Creator reaches a created Project in at most 8 UI actions and at most 60 seconds of interaction, excluding media transfer.                                                                 | Run a Playwright script that signs up and creates a Project. Assert it performs at most 8 UI actions and the interaction timer, excluding media transfer, is at most 60 seconds. (US-119)                                                                                                                                                                           |
| NFR-USE-02   | Progress          | Each visible Job shows either a stage name plus a percentage in the range 0 to 100, or an explicit indeterminate state.                                                                          | Open a running Job in the web application. Assert the screen shows a stage name plus an integer from 0 to 100, or an explicit indeterminate indicator. (US-131)                                                                                                                                                                                                     |
| NFR-PORT-01  | Local boot        | From a fresh clone, `docker compose up` reaches healthy services in at most 5 minutes, measured after images are already present.                                                                | With images already present, run `docker compose up` from a fresh clone and assert every service healthcheck is healthy within 5 minutes. (US-114)                                                                                                                                                                                                                  |
| NFR-PORT-02  | Configuration     | Starting the API with a required variable missing exits non-zero before it listens, and the stderr text contains the variable name.                                                              | Start the API with one required variable unset. Assert a non-zero exit before the process binds a port, and assert stderr contains that variable name. (US-114)                                                                                                                                                                                                     |
| NFR-OBS-01   | Correlation       | In a traced upload, 100 percent of API and worker log lines for that request and its Jobs contain the same correlation identifier.                                                               | Send an upload with a known correlation identifier. Collect the API and worker log lines for that request and its Jobs. Assert every collected line contains that identifier. (US-115)                                                                                                                                                                              |
| NFR-OBS-02   | Error body        | An unhandled API error is `application/problem+json`, includes a trace identifier, and does not include a stack trace.                                                                           | Force an unhandled API exception. Assert the Content-Type is application/problem+json, the body includes a trace identifier, and the body does not include a stack trace. (US-115)                                                                                                                                                                                  |
| NFR-REP-01   | Command replay    | Replaying the same EditCommand list yields the same Clip boundaries in integer microseconds.                                                                                                     | Apply an EditCommand list, replay it from an empty Timeline, and assert every Clip boundary integer is identical. (US-215)                                                                                                                                                                                                                                          |
| NFR-REP-02   | Analysis cache    | The second analysis of an unchanged fingerprint and analyzer version performs zero new model invocations.                                                                                        | Run analysis twice for one fingerprint and analyzer version. Assert the second run records zero model invocations and returns the stored MediaAnalysis. (US-423)                                                                                                                                                                                                    |
| NFR-REP-03   | Agent cassettes   | A cassette-backed agent test performs zero live provider HTTP calls.                                                                                                                             | Run a cassette-backed agent test with provider network egress denied. Assert the test passes and the provider client records zero HTTP calls. (US-305)                                                                                                                                                                                                              |

NFR-PERF-01 is the MVP render gate. Phase 1 records an earlier feasibility checkpoint of 300 seconds for a similar 60-second composition. That checkpoint is not a second, looser acceptance target. MVP acceptance uses 180 seconds.

## 8. Scope classification

A proposal is classified by this procedure and by no other discussion:

1. If the proposal matches a row in section 8.3, or an alias in section 8.4 whose class is out of scope, the class is **out of scope**.
2. Otherwise, if it matches a row in section 8.1, or an alias in section 8.4 whose class is MVP, the class is **MVP**.
3. Otherwise, if it matches a row in section 8.2, or an alias in section 8.4 whose class is Advanced, the class is **Advanced**.
4. Otherwise the class is **out of scope** until this SRS is revised and the new row names the class.

Normalize a proposal by trimming spaces and lowercasing. It matches a row when that text equals the normalized Capability cell or the normalized Proposal cell. It matches an alias when it equals the normalized Alias cell in section 8.4. Wording that is merely similar does not match. If two rows could match, use the earliest step above. Stretch items are Advanced. They are not a fourth class and they are not a sprint commitment.

A roadmap story whose deliverable is only a test, a report, or a document takes the class of the capability it verifies. It does not become out of scope merely because the story title is absent from the tables.

### 8.1 MVP

Foundation that those capabilities assume is also MVP, because Phases 1 and 2 are on the path to M4. The first row is the MVP source-footage class. M4 requires those three footage classes.

| Capability                                                        | Roadmap anchor                         |
| ----------------------------------------------------------------- | -------------------------------------- |
| Talking-head, podcast, and educational footage                    | M4 exit criterion, phase 4             |
| Accounts, sessions, and the four roles                            | US-118, US-119                         |
| Project create, read, update, delete (soft delete), and dashboard | US-120, US-121                         |
| Upload, validation, metadata, proxy, thumbnails                   | US-122 through US-128                  |
| Jobs, progress, and correlation                                   | US-115, US-129, US-130, US-131         |
| Transcript, speech segments, silence, loudness, shots, faces      | US-201, US-202, US-204, US-206, US-207 |
| Filler and repetition detection                                   | US-203                                 |
| Versioned MediaAnalysis contract                                  | US-208                                 |
| Analysis cache by media fingerprint                               | US-423                                 |
| Timeline, commands, undo, replay                                  | US-214, US-215                         |
| One-click silence removal                                         | US-223                                 |
| Tool manifests, executor, safe FFmpeg use                         | US-219, US-220, US-221, US-222         |
| Remotion render worker and FFmpeg render strategy                 | US-216, US-217, US-218                 |
| Agent loop and short-form presets                                 | US-301 through US-305, US-308          |
| Captions, reframe, zoom, loudness, music ducking                  | US-310, US-311, US-312, US-313, US-314 |
| Active-speaker reframing                                          | US-424                                 |
| Basic motion graphics and transitions                             | US-401, US-402, US-403                 |
| Layout metadata used by quality checks                            | US-405                                 |
| Font registry and font selection                                  | US-406, US-407, US-408                 |
| In-browser render preview                                         | US-418                                 |
| Preview and final render                                          | US-315                                 |
| Local B-roll and music                                            | US-411 through US-414                  |
| One refinement pass, frame evidence, and deterministic checks     | US-419, US-420, US-421                 |
| Hardened worker containers at the MVP exit                        | US-422                                 |
| Natural-language revision and version history                     | US-415, US-417                         |
| CreativeMemory                                                    | US-409                                 |
| Creativity level policy                                           | US-410                                 |

The MVP capability list in the roadmap overview (speech transcription through basic self-review) is included by the rows above. A proposal that only restates one of those rows is MVP.

### 8.2 Advanced

| Capability                                                                      | Roadmap anchor                 |
| ------------------------------------------------------------------------------- | ------------------------------ |
| Sandbox and host-isolated install                                               | US-501, US-502                 |
| Generated Components and their registry                                         | US-503, US-504, US-505         |
| Generated FFmpeg filter chains (stretch, not committed)                         | US-506                         |
| Internet asset providers, quarantine, licenses                                  | US-507, US-508, US-509         |
| Component acquisition from package registries                                   | US-510                         |
| Multimodal critic and iterative refinement                                      | US-511, US-512, US-513         |
| Hook detection, narrative restructuring, beat cutting, pacing, keyword emphasis | US-514, US-515, US-516, US-518 |
| Mood detection and music matching (stretch)                                     | US-517                         |
| Semantic visual understanding for B-roll (stretch)                              | US-519                         |
| Full-autonomous creativity level                                                | US-520                         |
| BrandKit                                                                        | US-521, US-522                 |
| Speech, music, and noise classification (stretch)                               | US-205                         |
| Overlay and B-roll frame component pack (stretch)                               | US-404                         |
| Advanced reference resolution in chat (stretch)                                 | US-527                         |
| Direct mouse editing of the Timeline (stretch)                                  | US-528                         |

Basic self-review (one pass) is not in this table. It is MVP. The iterative loop is Advanced.

### 8.3 Out of scope

| Proposal                                                      | Why it is outside the product                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Native iOS or Android applications                            | The client is the web application.                                                               |
| Live ingest or broadcast streaming                            | Inputs are uploaded files.                                                                       |
| Automatic posting to TikTok, Instagram, or YouTube            | The product outputs a file. Publishing is the Creator's action outside EditAgent.                |
| Real-time multi-cursor co-editing                             | Version history is in scope. Simultaneous cursors are not.                                       |
| Training or fine-tuning a foundation model inside the product | The product calls models through ports. It does not train them.                                  |
| Text-to-video as the source footage                           | The source is uploaded media. Generated Components are Advanced and are not a substitute source. |
| Final delivery above 1080p, including 4K and 8K masters       | Section 6.2 is the output cap.                                                                   |
| Inputs over 30 minutes or 4 GB as an accepted MVP upload      | Section 6.1 rejects them. Raising the cap is a new SRS row, not an interpretation.               |
| A Tool that runs a host shell                                 | NFR-SEC-01.                                                                                      |
| Unsandboxed execution of generated or downloaded code         | FR-031.                                                                                          |
| Medical, legal, or financial advice features                  | Not a video-editing capability in the roadmap.                                                   |

### 8.4 Exact aliases

These strings match with the same strength as a Capability or Proposal cell. They do not add a class of their own. The class column is the class from sections 8.1, 8.2, or 8.3.

| Alias                          | Class        | Same requirement as                                     |
| ------------------------------ | ------------ | ------------------------------------------------------- |
| talking-head editing           | MVP          | Talking-head, podcast, and educational footage          |
| podcast editing                | MVP          | Talking-head, podcast, and educational footage          |
| educational footage            | MVP          | Talking-head, podcast, and educational footage          |
| captions                       | MVP          | Captions, reframe, zoom, loudness, music ducking        |
| local B-roll                   | MVP          | Local B-roll and music                                  |
| internet B-roll acquisition    | Advanced     | Internet asset providers, quarantine, licenses          |
| generated Component            | Advanced     | Generated Components and their registry                 |
| iterative self-repair          | Advanced     | Multimodal critic and iterative refinement              |
| BrandKit                       | Advanced     | BrandKit                                                |
| native iOS app                 | Out of scope | Native iOS or Android applications                      |
| 4K final output                | Out of scope | Final delivery above 1080p, including 4K and 8K masters |
| direct mouse timeline editing  | Advanced     | Direct mouse editing of the Timeline (stretch)          |
| generated FFmpeg filter chains | Advanced     | Generated FFmpeg filter chains (stretch, not committed) |

Normalize a proposal by trimming spaces and lowercasing. It matches an alias when the normalized proposal equals the normalized Alias cell.

## 9. Platform presets

Presets are configuration (US-308). Adding a preset must not require a code change beyond a configuration entry. The three presets below are the MVP set. The preset mechanism must also accept a 1080×1080 (1:1) entry and a 1920×1080 (16:9) entry, because US-308 tests those aspect ratios. Those two entries are additional MVP configuration, not extra social networks.

Loudness for every preset in this section:

| Measure             | Threshold                       |
| ------------------- | ------------------------------- |
| Integrated loudness | -14.0 LUFS                      |
| Tolerance           | ±1.0 LU                         |
| True peak           | Less than or equal to -1.5 dBTP |

Verification is an EBU R128 measurement of the rendered file. The analyzer's calibration fixture must agree with its reference within 0.5 LU (US-204). A render fails the preset when integrated loudness is outside -15.0 to -13.0 LUFS or true peak is above -1.5 dBTP.

When the Creator names a duration, the rendered duration is within 10 percent of that request, and it is also less than or equal to the preset cap. A request above the cap is rejected with an error that states the cap. It is not silently shortened.

Safe zones are EditAgent policy for the preset, expressed as insets from the frame edges. A caption or title bounding box must lie entirely inside the remaining rectangle. Verification compares layout metadata (US-405) to the rectangle. Intersection with the margin fails the check (US-419).

### 9.1 TikTok

| Property         | Value                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| Frame            | 1080×1920, aspect 9:16                                                                 |
| Duration cap     | 60 seconds                                                                             |
| Safe-zone insets | Left 6 percent of width, right 18 percent, top 10 percent of height, bottom 22 percent |
| Loudness         | Section 9 table                                                                        |

### 9.2 Instagram Reels

| Property         | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| Frame            | 1080×1920, aspect 9:16                                              |
| Duration cap     | 90 seconds                                                          |
| Safe-zone insets | Left 6 percent, right 14 percent, top 14 percent, bottom 22 percent |
| Loudness         | Section 9 table                                                     |

Scenario A uses this preset with a requested duration of 45 seconds. The allowed rendered duration is 40.5 to 49.5 seconds, and the frame is 1080×1920 (US-308).

### 9.3 YouTube Shorts

| Property         | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| Frame            | 1080×1920, aspect 9:16                                              |
| Duration cap     | 60 seconds                                                          |
| Safe-zone insets | Left 6 percent, right 12 percent, top 12 percent, bottom 20 percent |
| Loudness         | Section 9 table                                                     |

The cap is the EditAgent MVP preset, not a claim about the platform's current maximum length. Scenario B uses this preset.

## 10. Security boundaries

The boundaries match the container diagram.

| Boundary           | Rule                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Browser            | Untrusted. It receives a presigned URL, not storage credentials. It calls the API, not the workers.         |
| Application zone   | Web, API, and the four workers. They hold platform credentials.                                             |
| Data stores        | PostgreSQL, Redis, and object storage are reached through ports. Domain code does not import their clients. |
| External providers | LLM and asset-provider responses are untrusted input.                                                       |
| Sandbox            | Generated or downloaded code runs outside the application zone. The sandbox is Advanced (FR-031).           |

Admin authority does not cross the Project boundary. Worker egress for MVP hardened containers is storage only, except the agent worker's calls to an LLM provider (phase 4 worker hardening, US-422). That hardening is part of finishing the MVP deployment, not a Creator-facing feature in section 8.2.

## 11. Deployment, hardware, and storage

### 11.1 Deployment

Local and staging runtime is Docker Compose with PostgreSQL, Redis, and SeaweedFS (US-114, ADR-004, ADR-005). Services run as non-root once the hardened-container story is in place. A missing required environment variable stops the process before it serves traffic (NFR-PORT-02). The web client is a browser. There is no native mobile client (section 8.3).

### 11.2 Hardware

Perception and the render budget are measured on the reference machine used for CP1 and CP4. The SRS does not name a GPU model. Pull-request CI may use CPU integer-8 models. A nightly run may use a GPU. NFR-PERF-01 is not waived because CI is on CPU. It is measured on the reference machine.

### 11.3 Storage

PostgreSQL stores module metadata, including Job state that must survive a Redis flush (ADR-004). Object storage stores source media, derivatives, and renders. Development uses MinIO. Production uses an S3-compatible API behind `IObjectStorage`. A database row that points at a missing object is a defect. Backups of the two stores are restored together.

## 12. Alignment

These notes record how this SRS sits on the accepted architecture. They are not changes to the ADRs.

- BrandKit is a canonical glossary term and an Advanced feature (US-521). Naming it does not make it MVP.
- CreativeMemory is MVP (US-409, Sprint 7, before M4).
- The Phase 1 feasibility note of 300 seconds for a 60-second render is an early checkpoint. NFR-PERF-01 uses the later MVP gate of 180 seconds.
- No contradiction with ADR-001 through ADR-008 was found. Queue, database, object storage, language split, LLM ports, and integer time are constraints on the requirements above, not alternatives.
- US-120 names the product operations CreateProject, RenameProject, ListProjects, and DeleteProject. US-104 requires soft delete in the data model. This SRS uses delete for that one operation and defines it as a soft delete. It does not add an archive operation. Rename is the update of the Project name inside FR-004.
