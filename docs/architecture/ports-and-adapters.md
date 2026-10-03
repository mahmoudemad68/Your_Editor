# Ports and adapters catalogue

Ports are interfaces owned by an inner layer. Adapters are infrastructure implementations of those ports. This catalogue records the contracts so later stories can implement them without inventing a second boundary. Nothing in this catalogue is implemented in the Sprint 1 foundation slice unless a row says the scaffold already contains a type.

The composition root of a process binds a port to an adapter. Domain and application code receive the port and do not import the adapter.

## Aggregate repositories

US-104 defines one repository interface per initial aggregate. The interfaces live in the domain module that owns the aggregate. They return domain objects and do not mention an ORM, SQL, or a migration. US-120 implements `ProjectRepository` against Postgres. The other adapters wait for their stories. The diagram and the interface list are in [data-model.md](data-model.md).

## Shared infrastructure ports

| Port             | Owner of the port                                                  | Defined in                                               | Adapter, when it exists                     | Implementing story |
| ---------------- | ------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------- | ------------------ |
| `IObjectStorage` | Shared port. Media, Assets, and Rendering own the keys they store. | Domain kernel or the consuming module's public interface | S3-compatible adapter, MinIO in development | US-122             |
| `IJobQueue`      | Jobs                                                               | Jobs module                                              | Redis + BullMQ adapter                      | US-129             |
| `ISandbox`       | Agent                                                              | Agent module                                             | Sandbox runtime                             | US-501             |
| `IAssetProvider` | Assets                                                             | Assets module                                            | Local registry, then internet providers     | US-411, US-507     |

### `IObjectStorage`

Operations the adapter must provide:

- `put(key, body, contentType, checksumSha256) → stored object`
- `get(key) → body`
- `presignPut(key, contentType, checksumSha256, expiresIn, onlyIfAbsent) → URL and required headers`
- `presignGet(key, expiresIn) → URL`
- `stat(key) → size, content type, and SHA-256 when the object exists`
- `delete(key)`

Keys are opaque strings allocated by the owning module. The adapter does not interpret module identity. The browser receives a presigned URL and never receives credentials. US-122 implements this port as `S3ObjectStorage`. Presigned URLs use `S3_PUBLIC_ENDPOINT`. API calls use `S3_ENDPOINT`.

### `IJobQueue`

Operations:

- `enqueue(job) → job id and whether the idempotency key was already present`
- `reserve(queueName) → job payload and an opaque receipt`
- `complete(receipt)`
- `fail(receipt, reason, transient)`
- `requestCancel(jobId)` and `isCancelRequested(jobId)`
- `discardQueued(jobId, queueName)` for a job that has not started
- `publishProgress(jobId, event)`
- `close()`

Payloads are JSON documents validated against a JSON Schema from `packages/schemas` before a worker runs them. The queue technology is Redis and BullMQ (ADR-004). The port does not expose BullMQ types. US-129 names the port `JobQueue` in the domain package, matching the other ports, which do not use an `I` prefix. The BullMQ adapter and the Postgres job repository live in `packages/job-queue`. The API composition root and the media worker both use that package. A request correlation id travels inside `JobEnvelope.payload`.

### `ISandbox`

Future port. Operations, recorded now so the boundary stays stable:

- `run(request) → result` inside an isolated runtime
- No host shell, no host package install, no host filesystem beyond the sandbox workspace

### `IAssetProvider`

Future port. Operations:

- `search(query) → candidates`
- `fetch(candidate) → quarantined object`

A chain of providers (local, then internet, then generation) is a later Assets story. The domain sees one port.

## Repository ports

Each aggregate has one repository port. ORM types stay in the adapter. The domain package must not import an ORM.

Names match the domain interfaces. This slice does not use an `I` prefix. A row marked later is a planned port, not an interface in the package yet.

| Port                     | Module     | Aggregate                 | In this slice |
| ------------------------ | ---------- | ------------------------- | ------------- |
| `UserRepository`         | Identity   | User                      | Yes           |
| `ProjectRepository`      | Projects   | Project                   | Yes           |
| `MediaAssetRepository`   | Media      | MediaAsset                | Yes           |
| `DerivedAssetRepository` | Media      | DerivedAsset              | Yes           |
| `JobRepository`          | Jobs       | Job                       | Yes           |
| `SessionRepository`      | Identity   | Refresh session           | Later, US-118 |
| `AnalysisRepository`     | Analysis   | MediaAnalysis             | Later         |
| `TimelineRepository`     | Editing    | Timeline                  | Later         |
| `AgentRunRepository`     | Agent      | AgentRun                  | Later         |
| `AssetRepository`        | Assets     | Asset                     | Later         |
| `ComponentRepository`    | Components | Component manifest record | Later         |
| `CritiqueRepository`     | Critic     | Critique                  | Later         |

Persistence mapping is an infrastructure concern. `PostgresProjectRepository` in the API infrastructure layer implements `ProjectRepository` and restores rows with `Project.restore`. `project_memberships.user_id` does not reference a User table until US-118.

## Model ports

Owned by Agent. Adapters live in the agent worker's infrastructure layer. The domain does not import a provider SDK (ADR-006).

| Port                     | Capability                                            |
| ------------------------ | ----------------------------------------------------- |
| `IChatModel`             | Text completion for a prompt                          |
| `IToolCallingModel`      | Native tool calls that validate against a tool schema |
| `IStructuredOutputModel` | Output that validates against a JSON Schema           |
| `IVisionModel`           | Completion that accepts image input                   |

A provider adapter implements only the ports that provider can satisfy. Missing capabilities are declared, not emulated inside the domain.

## Perception ports

Owned by Analysis. Adapters live in `workers/ai-worker` infrastructure. They are not implemented in this slice.

| Port                     | Capability                      |
| ------------------------ | ------------------------------- |
| `ITranscriber`           | Word-level transcript           |
| `IVoiceActivityDetector` | Speech segments                 |
| `IFaceDetector`          | Faces and tracks                |
| `ISceneDetector`         | Shot and scene boundaries       |
| `IAudioClassifier`       | Speech, music, and noise labels |

Each adapter writes its section of `MediaAnalysis`. The schema itself is a JSON Schema contract (ADR-003), generated into TypeScript and Python in US-208.

## Media processing ports

Owned by Media (inspection and derivatives) and Tools (editing commands). Implementations live in `packages/media-core`.

| Port                   | Owner | Capability                                                       |
| ---------------------- | ----- | ---------------------------------------------------------------- |
| `IMediaProbe`          | Media | Container, stream, and duration metadata                         |
| `IMediaCommandBuilder` | Tools | Build an FFmpeg argument vector. No string-built shell commands. |
| `IMediaProcessor`      | Tools | Execute a built command with a timeout and captured streams      |

`IMediaProbe` is declared in `packages/domain/src/modules/media`. The roadmap task that names `packages/media-core` as the port location is reconciled here: application code cannot import `media-core` (`application-no-outer-layers`), so the contract stays in the Media module and the FFprobe adapter stays in `packages/media-core`. Only that package spawns FFprobe. The adapter uses an argument array with `shell: false`, a finite timeout, and `-protocol_whitelist file`. That restriction is not the hostile-media validation required by US-127.

US-126 inspection is not automatic. `CompleteMediaUpload` publishes a durable `media.inspect` job after the asset row is stored. It does not run FFprobe. `GET /projects/:projectId/media/:mediaAssetId` does not inspect either. The media worker reserves that job through `JobQueue` and completes it. `inspectMediaAsset` and `node dist/inspect.js <mediaAssetId>` remain the FFprobe entry points.

## Rendering port

Owned by Rendering.

| Port              | Capability                                        |
| ----------------- | ------------------------------------------------- |
| `IRenderStrategy` | `render(request) → output object` for one backend |

Known strategies, both later stories: Remotion (US-216, US-217) and FFmpeg (US-218). The application selects a strategy. It does not import Remotion or FFmpeg.

## Tool port

Owned by Tools. The port lives with `packages/tool-sdk`, which may depend on the domain. The domain does not depend on the SDK.

| Port           | Capability                                                    |
| -------------- | ------------------------------------------------------------- |
| `ITool`        | `execute(call, context) → result`                             |
| `ToolManifest` | Name, version, argument schema, permission set, cost, timeout |

The executor denies permissions the manifest does not declare. No tool declares a shell permission.

## Component port

Owned by Components.

| Port                | Capability                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `ComponentManifest` | Name, props schema, trust level                                     |
| Component registry  | Resolve a manifest to a Remotion component inside the render worker |

The registry is a plugin. The render worker is the composition root that loads it.

## Binding rule

1. The port type is declared in the owning module (or in `packages/tool-sdk` / `packages/media-core` when the table says so).
2. The adapter is declared in an infrastructure folder or in `packages/media-core`.
3. The composition root constructs the adapter and passes it to the use case.
4. A pull request that imports an adapter from `packages/domain` or from an `application/` folder violates `domain-no-infrastructure` or `application-no-outer-layers` and must fail the architecture check.
