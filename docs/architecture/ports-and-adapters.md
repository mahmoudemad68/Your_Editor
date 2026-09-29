# Ports and adapters catalogue

Ports are interfaces owned by an inner layer. Adapters are infrastructure implementations of those ports. This catalogue records the contracts so later stories can implement them without inventing a second boundary. Nothing in this catalogue is implemented in the Sprint 1 foundation slice unless a row says the scaffold already contains a type.

The composition root of a process binds a port to an adapter. Domain and application code receive the port and do not import the adapter.

## Shared infrastructure ports

| Port             | Owner of the port                                                  | Defined in                                               | Adapter, when it exists                     | Implementing story |
| ---------------- | ------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------- | ------------------ |
| `IObjectStorage` | Shared port. Media, Assets, and Rendering own the keys they store. | Domain kernel or the consuming module's public interface | S3-compatible adapter, MinIO in development | US-122             |
| `IJobQueue`      | Jobs                                                               | Jobs module                                              | Redis + BullMQ adapter                      | US-129             |
| `ISandbox`       | Agent                                                              | Agent module                                             | Sandbox runtime                             | US-501             |
| `IAssetProvider` | Assets                                                             | Assets module                                            | Local registry, then internet providers     | US-411, US-507     |

### `IObjectStorage`

Operations the adapter must provide:

- `put(key, body, contentType) → stored object`
- `get(key) → body`
- `presignPut(key, expiresAt) → URL`
- `presignGet(key, expiresAt) → URL`
- `delete(key)`

Keys are opaque strings allocated by the owning module. The adapter does not interpret module identity. The browser receives a presigned URL and never receives credentials.

### `IJobQueue`

Operations:

- `enqueue(job) → JobId`
- `reserve(queueName) → job payload`
- `complete(jobId)`
- `fail(jobId, reason)`
- `publishProgress(jobId, event)`

Payloads are JSON documents validated against a JSON Schema from `packages/schemas` before a worker runs them. The queue technology is Redis and BullMQ (ADR-004). The port does not expose BullMQ types.

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

| Port                      | Module     | Aggregate                 |
| ------------------------- | ---------- | ------------------------- |
| `IUserRepository`         | Identity   | User                      |
| `ISessionRepository`      | Identity   | Session                   |
| `IProjectRepository`      | Projects   | Project                   |
| `IBrandKitRepository`     | Projects   | BrandKit                  |
| `IMediaAssetRepository`   | Media      | MediaAsset                |
| `IDerivedAssetRepository` | Media      | DerivedAsset              |
| `IAnalysisRepository`     | Analysis   | MediaAnalysis             |
| `ITimelineRepository`     | Editing    | Timeline                  |
| `IJobRepository`          | Jobs       | Job                       |
| `IAgentRunRepository`     | Agent      | AgentRun                  |
| `IAssetRepository`        | Assets     | Asset                     |
| `IComponentRepository`    | Components | Component manifest record |
| `ICritiqueRepository`     | Critic     | Critique                  |

Persistence mapping is an infrastructure concern (US-104 and the story that introduces each aggregate). This slice does not add a database.

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

Owned by Media (inspection and derivatives) and Tools (editing commands). Implementations live in `packages/media-core`. The scaffold package exists and contains no FFmpeg invocation.

| Port                   | Owner | Capability                                                       |
| ---------------------- | ----- | ---------------------------------------------------------------- |
| `IMediaProbe`          | Media | Container, stream, and duration metadata                         |
| `IMediaCommandBuilder` | Tools | Build an FFmpeg argument vector. No string-built shell commands. |
| `IMediaProcessor`      | Tools | Execute a built command with a timeout and captured streams      |

Only `packages/media-core` may call FFmpeg or FFprobe once those stories exist.

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
