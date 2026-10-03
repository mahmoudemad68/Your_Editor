# Infrastructure

Local runtime for US-114. Application adapters stay in later stories. This directory does not implement repositories, BullMQ, uploads, or authentication.

Staging release, image digests, and rollback are documented in `docs/operations/staging-release.md`. That path is not the local stack below.

## Start

From the repository root:

```bash
docker compose up
```

`make up` is the same stack and waits for health checks. `make down`, `make logs`, `make test`, `make seed`, and `make compose-config` are the other developer commands.

`make compose-config` runs `docker compose config` and `docker compose --profile gpu config`. It checks the committed file. It does not start containers and does not need a GPU. The same check runs in `tests/architecture/compose-config.test.mjs`.

`make seed` checks that PostgreSQL and Redis answer, then creates the development bucket if it is missing. It does not insert users, projects, or other application rows.

## Services

| Service       | Image                           | Published port |
| ------------- | ------------------------------- | -------------- |
| postgres      | `postgres:16.10-alpine`         | 5432           |
| redis         | `redis:7.4-alpine`              | 6379           |
| minio         | `editagent-minio:local`         | 9000 and 9001  |
| api           | `editagent-api:local`           | 3001           |
| web           | `editagent-web:local`           | 3000           |
| agent-worker  | `editagent-agent-worker:local`  | none           |
| media-worker  | `editagent-media-worker:local`  | none           |
| render-worker | `editagent-render-worker:local` | none           |
| ai-worker     | `editagent-ai-worker:local`     | none           |

Worker containers become healthy after typed configuration loads. A ready file at `/tmp/editagent.ready` is process plumbing so Compose can see that. It is not a queue consumer. The API health check calls the existing `/health` route. The web health check calls `/`.

## Images

Dockerfiles:

- `apps/api/Dockerfile`
- `apps/web/Dockerfile`
- `workers/agent-worker/Dockerfile`
- `workers/media-worker/Dockerfile`
- `workers/render-worker/Dockerfile`
- `workers/ai-worker/Dockerfile`
- `infra/minio/Dockerfile`

Application images are multi-stage. The runtime stage runs as uid 10001. Development passwords are not copied into those images. Compose injects them from `.env` or from the placeholders in `compose.yaml`. `.env.example` lists the placeholders. `.env` is git-ignored.

`docker.io/minio/minio` was removed from Docker Hub. The development object store is still MinIO (ADR-005). `infra/minio/Dockerfile` builds that release from the official `minio/minio` source instead of a community republish. The pinned tag is `RELEASE.2025-10-15T17-29-55Z`, commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`. The image sets `MINIO_RELEASE=RELEASE` during compilation so `minio --version` reports that tag. Build tools stay in the first stage. The image contains no MinIO credentials.

The entrypoint starts as root only to create `/data` and give it to the `minio` user. It then executes the server with `su-exec`, so the MinIO process runs as uid 1000. Application images stay on uid 10001.

## GPU profile

The default AI worker sets `EDITAGENT_AI_DEVICE=cpu` and does not request a GPU. Machines without the NVIDIA container runtime can use `docker compose up`.

```bash
make up-gpu
```

That runs `docker compose --profile gpu up --scale ai-worker=0`. The `ai-worker-gpu` service requests an NVIDIA GPU with a Compose device reservation (`driver: nvidia`, `count: all`, `capabilities: [gpu]`) and sets `EDITAGENT_AI_DEVICE=cuda`. The default `ai-worker` stays on `cpu` and does not request a device. The GPU service does not load a model. A machine without an NVIDIA runtime can still validate the file with `make compose-config`. Running the GPU service itself needs that runtime and is not part of the default stack.

## Configuration

TypeScript processes parse environment variables with Zod once, in each process's `infrastructure/config.ts`. The web instrumentation hook does the same at server start and skips the production build. The AI worker uses pydantic-settings in `infrastructure/config.py`. Missing or invalid required values raise a configuration error and the process exits before it waits.

The API requires `DATABASE_URL`. It does not open a database connection in this story. Workers that the container diagram shows talking to Redis or object storage require those settings too, and still do not open clients.
