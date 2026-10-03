# syntax=docker/dockerfile:1
# Production image for the media worker. Multi-stage, non-root, no secrets in the image.

FROM node:22.23.3-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a AS base
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
COPY tsconfig.base.json ./
COPY workers/media-worker workers/media-worker
COPY packages/domain packages/domain
COPY packages/schemas packages/schemas
COPY packages/shared packages/shared
COPY packages/media-core packages/media-core
COPY packages/job-queue packages/job-queue
RUN pnpm --filter @editagent/media-worker... build \
    && find /app -type f \( -name '*.test.ts' -o -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) -delete \
    && pnpm --filter @editagent/media-worker --prod deploy --legacy /out \
    && rm -f /out/node_modules/.pnpm/node_modules/@editagent/media-worker

FROM node:22.23.3-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a AS runtime
RUN apk add --no-cache ffmpeg=8.0.1-r1 \
    && ffprobe -version \
    && ffprobe -version | head -n 1 > /etc/editagent-ffprobe-release \
    && addgroup -S -g 10001 editagent \
    && adduser -S -D -H -u 10001 -G editagent -h /home/editagent -s /sbin/nologin editagent \
    && mkdir -p /home/editagent \
    && chown editagent:editagent /home/editagent
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
ENV NODE_ENV=production
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
  CMD ["node", "-e", "require('node:fs').accessSync('/tmp/editagent.ready')"]
CMD ["node", "dist/index.js"]
