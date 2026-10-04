# syntax=docker/dockerfile:1
# Production image for the render worker. Multi-stage, non-root, no secrets in the image.

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
COPY tsconfig.base.json ./
COPY workers/render-worker workers/render-worker
COPY packages/shared packages/shared
RUN pnpm --filter @editagent/render-worker... build \
    && find /app -type f \( -name '*.test.ts' -o -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) -delete \
    && pnpm --filter @editagent/render-worker --prod deploy --legacy /out \
    && rm -f /out/node_modules/.pnpm/node_modules/@editagent/render-worker

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libpcre2-8-0=10.46-1~deb13u3 \
      libssl3t64=3.5.7-1~deb13u3 \
      openssl-provider-legacy=3.5.7-1~deb13u3 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN groupadd --system --gid 10001 editagent \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/editagent --create-home --shell /usr/sbin/nologin editagent
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
ENV NODE_ENV=production
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
  CMD ["node", "-e", "require('node:fs').accessSync('/tmp/editagent.ready')"]
CMD ["node", "dist/index.js"]
