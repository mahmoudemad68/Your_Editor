# Layer and module dependency rules

These rules are the Clean Architecture dependency direction for EditAgent. US-111 enforces the tables below with dependency-cruiser (TypeScript) and import-linter (Python). A rule that is marked **enforced** has the same name in `tools/architecture/forbidden-rules.cjs` or in `workers/ai-worker/pyproject.toml`. A rule marked **review** is a design rule that a dependency graph cannot fully judge.

The dependency direction is:

```text
presentation → application → domain ← infrastructure
```

The domain defines ports. Infrastructure implements them. The composition root is the only code that may see every layer, and it may only wire dependencies and start the process.

## Layer definitions

| Layer            | Meaning                                                                                                                                   | TypeScript homes                                                               | Python home                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| Domain           | Entities, value objects, domain services, and ports. No frameworks, databases, web frameworks, queues, or infrastructure implementations. | `packages/domain`                                                              | `editagent_ai_worker.domain`         |
| Application      | Use cases. Orchestrates domain modules. Depends on ports, not on adapters.                                                                | `*/src/application`                                                            | `editagent_ai_worker.application`    |
| Presentation     | HTTP, UI, and other delivery mechanisms.                                                                                                  | `apps/web`, `apps/api/src/presentation`                                        | none in the scaffold                 |
| Infrastructure   | Adapters that implement ports: databases, object storage, queues, FFmpeg, model runtimes.                                                 | `*/src/infrastructure`, `packages/media-core`, `infra/`                        | `editagent_ai_worker.infrastructure` |
| Composition root | Process entry that constructs adapters and calls a use case.                                                                              | `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `workers/*/src/index.ts` | `editagent_ai_worker/__main__.py`    |

`apps/web/src/app` is presentation. Next.js requires that directory name. `presentation-no-infrastructure` treats that tree as presentation, and the web allow-list constrains which packages it may import.

`packages/schemas` and `packages/shared` are not domain. Application, presentation, infrastructure, and composition may depend on them. Domain may not.

`packages/tool-sdk` is the Tools plugin surface. It may depend on domain, schemas, and shared. Domain may not depend on it.

## Allowed direction

| From                  | May depend on                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Presentation          | Application, domain, `packages/schemas`, `packages/shared`, and the delivery framework for that process |
| Application           | Domain, `packages/schemas`, `packages/shared`                                                           |
| Domain module         | `packages/domain/src/kernel` and its own folder                                                         |
| Domain kernel         | Nothing inside the repo and no npm packages                                                             |
| Infrastructure        | Domain, `packages/schemas`, `packages/shared`, and adapter libraries                                    |
| `packages/media-core` | Domain, schemas, shared, and adapter libraries                                                          |
| `packages/tool-sdk`   | Domain, schemas, shared                                                                                 |
| Composition root      | Presentation, application, infrastructure, and domain of the same process                               |
| Web                   | Its own tree, schemas, shared, and npm packages required by Next.js                                     |
| API                   | Its own tree, domain, schemas, shared, and npm packages required by NestJS                              |
| Agent worker          | Its own tree, domain, schemas, tool-sdk, shared, and npm                                                |
| Media worker          | Its own tree, domain, schemas, tool-sdk, media-core, shared, and npm                                    |
| Render worker         | Its own tree, domain, schemas, media-core, shared, and npm                                              |

Application code must not construct an adapter. The composition root binds a port to an adapter.

A domain module must not import another domain module. Cross-module workflows are application use cases that call each module's public interface.

## TypeScript rules enforced by dependency-cruiser

Paths are repository-relative. `*.test.ts` may import `node:test` and `node:assert`. Production domain code may not.

| Rule name                                 | From                                                      | Forbidden targets                                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domain-no-infrastructure`                | `packages/domain`                                         | `/infrastructure/`, top-level `infra/`, `packages/media-core`, `apps/`, `workers/`                                                                                                               |
| `domain-no-frameworks`                    | `packages/domain`                                         | npm packages `@nestjs/*`, `next`, `react`, `react-dom`, `express`, `bullmq`, `ioredis`, `typeorm`, `prisma`, `@prisma/*`, `remotion`, `@remotion/*`                                              |
| `domain-no-npm`                           | `packages/domain`                                         | any npm dependency                                                                                                                                                                               |
| `domain-no-node-builtins`                 | `packages/domain` except `*.test.ts` and `*.test.js`      | Node.js built-in modules                                                                                                                                                                         |
| `domain-modules-do-not-import-each-other` | `packages/domain/src/modules/<A>`                         | `packages/domain/src/modules/<B>` when A is not B                                                                                                                                                |
| `domain-kernel-does-not-import-modules`   | `packages/domain/src/kernel`                              | `packages/domain/src/modules`                                                                                                                                                                    |
| `domain-no-sibling-packages`              | `packages/domain`                                         | `packages/shared`, `packages/schemas`, `packages/tool-sdk`                                                                                                                                       |
| `application-no-outer-layers`             | any `/application/` directory                             | `/infrastructure/`, `/presentation/`, `packages/media-core`, `packages/tool-sdk`, and npm packages `@nestjs/*`, `next`, `react`, `react-dom`, `express`, `bullmq`, `typeorm`, `pg`, `@aws-sdk/*` |
| `presentation-no-infrastructure`          | any `/presentation/` directory, and `apps/web/src/app/**` | `/infrastructure/`                                                                                                                                                                               |
| `infrastructure-no-presentation`          | any `/infrastructure/` directory                          | `/presentation/`                                                                                                                                                                                 |
| `packages-no-deployables`                 | `packages/`                                               | `apps/`, `workers/`                                                                                                                                                                              |
| `leaf-schemas`                            | `packages/schemas`                                        | any other workspace path (`apps`, `workers`, `packages` other than itself)                                                                                                                       |
| `leaf-shared`                             | `packages/shared`                                         | any other workspace path                                                                                                                                                                         |
| `tool-sdk-allow-list`                     | `packages/tool-sdk`                                       | anything outside itself, domain, schemas, shared, and `node_modules`                                                                                                                             |
| `media-core-allow-list`                   | `packages/media-core`                                     | anything outside itself, domain, schemas, shared, and `node_modules`                                                                                                                             |
| `web-allow-list`                          | `apps/web`                                                | anything outside itself, schemas, shared, and `node_modules`                                                                                                                                     |
| `api-allow-list`                          | `apps/api`                                                | anything outside itself, domain, schemas, shared, and `node_modules`                                                                                                                             |
| `agent-worker-allow-list`                 | `workers/agent-worker`                                    | anything outside itself, domain, schemas, tool-sdk, shared, and `node_modules`                                                                                                                   |
| `media-worker-allow-list`                 | `workers/media-worker`                                    | anything outside itself, domain, schemas, tool-sdk, media-core, shared, and `node_modules`                                                                                                       |
| `render-worker-allow-list`                | `workers/render-worker`                                   | anything outside itself, domain, schemas, media-core, shared, and `node_modules`                                                                                                                 |
| `workers-no-apps`                         | `workers/`                                                | `apps/`                                                                                                                                                                                          |
| `no-unresolved`                           | `apps/`, `packages/`, and `workers/`                      | any dependency the checker cannot resolve, including an external package that is not installed                                                                                                   |
| `no-circular`                             | any production source                                     | a dependency cycle                                                                                                                                                                               |

The production checker does not scan `tests/architecture/fixtures`. Those fixtures exist to prove the rules reject a known violation. They are not part of the product graph.

## Python rules enforced by import-linter

Root package: `editagent_ai_worker`.

| Contract name                                          | Type        | Rule                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Clean architecture layers`                            | `layers`    | `composition` → `application` → `domain`. A lower layer must not import a higher layer.                                                                                                                                                    |
| `Domain does not import outer layers`                  | `forbidden` | `domain` must not import `application`, `infrastructure`, or `composition`.                                                                                                                                                                |
| `Application does not import infrastructure`           | `forbidden` | `application` must not import `infrastructure` or `composition`.                                                                                                                                                                           |
| `Infrastructure does not import delivery or use cases` | `forbidden` | `infrastructure` must not import `application` or `composition`. It may import `domain`.                                                                                                                                                   |
| `Domain does not import frameworks`                    | `forbidden` | `domain` must not import `fastapi`, `flask`, `django`, `celery`, `redis`, `boto3`, `torch`, `transformers`, or `faster_whisper`. NestJS is a TypeScript dependency and is enforced by `domain-no-frameworks`, not by this Python contract. |

There is no presentation package in the Python worker. The process entry point is composition.

## Review rules

These are part of the architecture and are checked in review. They are not fully expressed as import edges.

- Controllers, page components, and worker entry points contain no business decisions. They call an application use case.
- A use case depends on a port, not on a concrete adapter class.
- FFmpeg and FFprobe are invoked only from `packages/media-core`. The `IMediaProbe` contract lives in the domain Media module. US-126 inspection runs from `workers/media-worker`, not from the API process.
- Adding a dependency edge that is not in the allowed-direction table requires a change to this document and to the matching enforced rule in the same pull request.
