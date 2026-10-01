# syntax=docker/dockerfile:1
# Isolated Remotion benchmark image. It is not the production render-worker.
# Chromium sandbox stays on. The container runs as a non-root user.

FROM node:22.23.2-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-dejavu-core \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libgbm1 \
    libasound2 \
    libxrandr2 \
    libxkbcommon0 \
    libxfixes3 \
    libxcomposite1 \
    libxdamage1 \
    libatk-bridge2.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

WORKDIR /bench
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace

COPY spec.json captions.json ./
COPY src ./src
COPY scripts ./scripts

RUN node --input-type=module -e "import {ensureBrowser} from '@remotion/renderer'; await ensureBrowser();" \
  && groupadd --system --gid 10001 bench \
  && useradd --system --uid 10001 --gid 10001 --home-dir /home/bench --create-home --shell /usr/sbin/nologin bench \
  && mkdir -p /bench/fixtures /bench/public /bench/out /bench/results \
  && chown -R 10001:10001 /bench /home/bench

USER 10001:10001
ENV HOME=/home/bench
CMD ["node", "scripts/docker-render.mjs"]
