# syntax=docker/dockerfile:1
# Production image for the media worker. Multi-stage, non-root, no secrets in the image.

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true \
    HUSKY=0
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/tool-sdk/package.json packages/tool-sdk/package.json
COPY packages/media-core/package.json packages/media-core/package.json
COPY packages/job-queue/package.json packages/job-queue/package.json
COPY workers/agent-worker/package.json workers/agent-worker/package.json
COPY workers/media-worker/package.json workers/media-worker/package.json
COPY workers/render-worker/package.json workers/render-worker/package.json
COPY workers/ai-worker/package.json workers/ai-worker/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY tools/media tools/media
COPY tools/schema tools/schema
COPY tsconfig.base.json ./
COPY workers/media-worker workers/media-worker
COPY packages/domain packages/domain
COPY packages/schemas packages/schemas
# Both language bindings are build inputs for the schema drift gate.
COPY workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py
COPY workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_v1_1_generated.py workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_v1_1_generated.py
COPY packages/shared packages/shared
COPY packages/media-core packages/media-core
COPY packages/job-queue packages/job-queue
RUN pnpm --filter @editagent/media-worker... build \
    && find /app -type f \( -name '*.test.ts' -o -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) -delete \
    && pnpm --filter @editagent/media-worker --prod deploy --legacy /out \
    && rm -f /out/node_modules/.pnpm/node_modules/@editagent/media-worker

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS ffmpeg
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      xz-utils \
      build-essential \
      pkg-config \
      nasm \
      zlib1g-dev \
      libx264-dev \
      libvpx-dev \
      libopus-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY workers/media-worker/build-ffmpeg.sh /tmp/build-ffmpeg.sh
RUN chmod 0755 /tmp/build-ffmpeg.sh && /tmp/build-ffmpeg.sh

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libx264-164 libvpx9 libopus0 \
    && rm -rf /var/lib/apt/lists/* \
    && if dpkg -s libxml2 >/dev/null 2>&1; then echo "libxml2 must not be installed" >&2; exit 1; fi \
    && groupadd --system --gid 10001 editagent \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/editagent --create-home --shell /usr/sbin/nologin editagent
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
RUN ffprobe -version \
    && ffprobe -version | head -n 1 > /etc/editagent-ffprobe-release \
    && if ldd /usr/local/bin/ffprobe /usr/local/bin/ffmpeg | grep -i xml; then echo "linked to libxml2" >&2; exit 1; fi \
    && if ffmpeg -hide_banner -demuxers | grep -w dash; then echo "MPEG-DASH demuxer was built" >&2; exit 1; fi
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    FFPROBE_PATH=/usr/local/bin/ffprobe
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3200/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
