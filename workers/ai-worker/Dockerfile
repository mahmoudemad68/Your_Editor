# syntax=docker/dockerfile:1
# Production image for the AI worker. Multi-stage, non-root, no secrets in the image.
# The default image does not require the NVIDIA container runtime.

FROM python:3.11-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.20 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON=/usr/local/bin/python
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.11-slim-bookworm AS runtime
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
