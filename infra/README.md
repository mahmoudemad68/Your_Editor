# Infrastructure

Local runtime for US-114. Application adapters stay in later stories. This directory does not implement repositories, BullMQ, uploads, or authentication.

## Start

From the repository root:

```bash
docker compose up
```

`make up` is the same stack and waits for health checks. `make down`, `make logs`, `make test`, and `make seed` are the other developer commands.

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

`docker.io/minio/minio` was removed from Docker Hub in September 2026. The development object store is still MinIO (ADR-005). `infra/minio/Dockerfile` wraps `alpine/minio:RELEASE.2025-10-15T17-29-55Z`, a community republish of that MinIO release, and drops to the `minio` user after preparing the data volume. That is a distribution constraint, not a change to the ADR.

## GPU profile

The default AI worker sets `EDITAGENT_AI_DEVICE=cpu` and does not request a GPU. Machines without the NVIDIA container runtime can use `docker compose up`.

```bash
make up-gpu
```

That runs `docker compose --profile gpu up --scale ai-worker=0`. The `ai-worker-gpu` service uses `runtime: nvidia` and `gpus: all`, and sets `EDITAGENT_AI_DEVICE=cuda`. It does not load a model.

## Configuration

TypeScript processes parse environment variables with Zod once, in each process's `infrastructure/config.ts`. The web instrumentation hook does the same at server start and skips the production build. The AI worker uses pydantic-settings in `infrastructure/config.py`. Missing or invalid required values raise a configuration error and the process exits before it waits.

The API requires `DATABASE_URL`. It does not open a database connection in this story. Workers that the container diagram shows talking to Redis or object storage require those settings too, and still do not open clients.
