# Infrastructure

Deployment manifests live here. Docker Compose, Dockerfiles, and typed runtime configuration are US-114 and are not part of the foundation scaffold.

Application adapters (database, object storage, queue) are also later stories. They will sit behind the ports in [docs/architecture/ports-and-adapters.md](../docs/architecture/ports-and-adapters.md), in each process's `infrastructure` directory or in `packages/media-core`.
