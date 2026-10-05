# Infrastructure

Local runtime for US-114. Application adapters stay in later stories. This directory does not implement repositories, BullMQ, uploads, or authentication.

## Start

From the repository root:

```bash
docker compose up
```

`make up` is the same stack and waits for health checks. `make down`, `make logs`, `make test`, `make seed`, and `make compose-config` are the other developer commands.

`make compose-config` runs `docker compose config` and `docker compose --profile gpu config`. It checks the committed file. It does not start containers and does not need a GPU. The same check runs in `tests/architecture/compose-config.test.mjs`.

`make seed` checks that PostgreSQL and Redis answer, then creates the development bucket if it is missing. It does not insert users, projects, or other application rows.

## Services

| Service        | Image                           | Published port |
| -------------- | ------------------------------- | -------------- |
| postgres       | `editagent-postgres:local`      | 5432           |
| redis          | `editagent-redis:local`         | 6379           |
| seaweed-master | `editagent-seaweedfs:local`     | none           |
| seaweed-volume | `editagent-seaweedfs:local`     | none           |
| seaweed-filer  | `editagent-seaweedfs:local`     | none           |
| seaweed-s3     | `editagent-seaweedfs:local`     | 127.0.0.1:9000 |
| api            | `editagent-api:local`           | 3001           |
| web            | `editagent-web:local`           | 3000           |
| agent-worker   | `editagent-agent-worker:local`  | none           |
| media-worker   | `editagent-media-worker:local`  | none           |
| render-worker  | `editagent-render-worker:local` | none           |
| ai-worker      | `editagent-ai-worker:local`     | none           |

Worker containers become healthy after typed configuration loads. A ready file at `/tmp/editagent.ready` is process plumbing so Compose can see that. It is not a queue consumer. The API health check calls the existing `/health` route. The web health check calls `/`.

## Images

Dockerfiles:

- `apps/api/Dockerfile`
- `apps/web/Dockerfile`
- `workers/agent-worker/Dockerfile`
- `workers/media-worker/Dockerfile`
- `workers/render-worker/Dockerfile`
- `workers/ai-worker/Dockerfile`
- `infra/seaweedfs/Dockerfile`

Application images are multi-stage. The runtime stage runs as uid 10001. Development passwords are not copied into those images. Compose injects them from `.env` or from the placeholders in `compose.yaml`. `.env.example` lists the placeholders. `.env` is git-ignored.

Object storage is SeaweedFS. `infra/seaweedfs/Dockerfile` pins `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`. Master, volume, and filer attach only to the internal `storage_internal` network (`172.30.210.0/24`) and publish no ports. Master HTTP routes are disabled. Each storage role has its own client certificate. `make up` runs `start-storage.sh`, which installs host firewall rules and only then starts the storage containers. Those rules admit master, volume, and filer traffic only from the four storage addresses, and they drop IPv6 on the storage bridge. The roles use `restart: "no"`. A host without systemd does not get a reboot hook. The S3 gateway is the only published listener, on `127.0.0.1:9000`. Application images stay on uid 10001.

The historical MinIO volume name `minio-data` stays in the Compose file and is not mounted. Migration copies objects through the S3 API and does not delete that volume. See [docs/operations/seaweedfs-object-storage.md](../docs/operations/seaweedfs-object-storage.md).

## GPU profile

The default AI worker sets `EDITAGENT_AI_DEVICE=cpu` and does not request a GPU. Machines without the NVIDIA container runtime can use `docker compose up`.

```bash
make up-gpu
```

That runs `docker compose --profile gpu up --scale ai-worker=0`. The `ai-worker-gpu` service requests an NVIDIA GPU with a Compose device reservation (`driver: nvidia`, `count: all`, `capabilities: [gpu]`) and sets `EDITAGENT_AI_DEVICE=cuda`. The default `ai-worker` stays on `cpu` and does not request a device. The GPU service does not load a model. A machine without an NVIDIA runtime can still validate the file with `make compose-config`. Running the GPU service itself needs that runtime and is not part of the default stack.

## Configuration

TypeScript processes parse environment variables with Zod once, in each process's `infrastructure/config.ts`. The web instrumentation hook does the same at server start and skips the production build. The AI worker uses pydantic-settings in `infrastructure/config.py`. Missing or invalid required values raise a configuration error and the process exits before it waits.

The API requires `DATABASE_URL`. It does not open a database connection in this story. Workers that the container diagram shows talking to Redis or object storage require those settings too, and still do not open clients.
