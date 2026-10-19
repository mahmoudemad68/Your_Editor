# syntax=docker/dockerfile:1
# Production image for the agent worker. Multi-stage, non-root, no secrets in the image.

FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS base
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
COPY workers/agent-worker workers/agent-worker
COPY packages/shared packages/shared
COPY packages/tool-sdk packages/tool-sdk
COPY packages/domain packages/domain
COPY packages/schemas packages/schemas
COPY tools/schema tools/schema
COPY workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py
COPY workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_v1_1_generated.py workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_v1_1_generated.py
RUN pnpm --filter @editagent/agent-worker... build \
    && find /app -type f \( -name '*.test.ts' -o -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) -delete \
    && pnpm --filter @editagent/agent-worker --prod deploy --legacy /out \
    && rm -f /out/node_modules/.pnpm/node_modules/@editagent/agent-worker

FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS runtime
RUN groupadd --system --gid 10001 editagent \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/editagent --create-home --shell /usr/sbin/nologin editagent
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
ENV NODE_ENV=production
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
  CMD ["node", "-e", "require('node:fs').accessSync('/tmp/editagent.ready')"]
CMD ["node", "dist/index.js"]
