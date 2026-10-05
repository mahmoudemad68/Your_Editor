# syntax=docker/dockerfile:1
# Production image for the AI worker. Multi-stage, non-root, no secrets in the image.
# The default image does not require the NVIDIA container runtime.

FROM python:3.11-slim-trixie@sha256:45037981b62b34b44602584fccbc4d884d5f7dc92c7ee86bb38a698a79fe1e51 AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.20 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON=/usr/local/bin/python
WORKDIR /app
COPY workers/ai-worker/pyproject.toml workers/ai-worker/uv.lock ./
COPY workers/ai-worker/src ./src
COPY packages/schemas/src/job-envelope.schema.json ./src/editagent_ai_worker/infrastructure/job-envelope.schema.json
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.11-slim-trixie@sha256:45037981b62b34b44602584fccbc4d884d5f7dc92c7ee86bb38a698a79fe1e51 AS runtime
RUN groupadd --system --gid 10001 editagent \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/editagent --create-home --shell /usr/sbin/nologin editagent
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
  CMD ["/app/.venv/bin/python", "-c", "import os,sys; sys.exit(0 if os.path.isfile('/tmp/editagent.ready') else 1)"]
CMD ["python", "-m", "editagent_ai_worker"]
