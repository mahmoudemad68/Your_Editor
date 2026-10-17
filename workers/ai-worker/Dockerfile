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
COPY packages/media-core/python /packages/media-core/python
COPY packages/schemas/src/job-envelope.schema.json packages/schemas/src/job-event.schema.json packages/schemas/src/analysis-job.schema.json packages/schemas/src/speech-analysis.schema.json ./src/editagent_ai_worker/infrastructure/
ARG ASR_MODEL=small
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    uv sync --frozen --no-cache --no-dev --no-editable \
    && /app/.venv/bin/python -m editagent_ai_worker.infrastructure.vad_model \
    && /app/.venv/bin/python -m editagent_ai_worker.infrastructure.asr_model --root /app/.venv/share/editagent/asr-models --model "$ASR_MODEL"

FROM python:3.11-slim-trixie@sha256:45037981b62b34b44602584fccbc4d884d5f7dc92c7ee86bb38a698a79fe1e51 AS runtime
RUN groupadd --system --gid 10001 editagent \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/editagent --create-home --shell /usr/sbin/nologin editagent
WORKDIR /app
COPY workers/ai-worker/licenses /usr/share/doc/editagent-vad/
COPY --from=build --chown=10001:10001 /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=20 \
  CMD ["/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3200/ready',timeout=4).close()"]
CMD ["python", "-m", "editagent_ai_worker"]
