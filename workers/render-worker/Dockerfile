# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Issue #45 Owner exception: Chromium sandbox is disabled by Remotion, not enabled
# by non-root execution. The executor MUST use the isolated compose settings.
# Optional named build context can supply an already verified pnpm store.
FROM scratch AS pnpm-store
COPY tools/render/empty-store/ /

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true HUSKY=0 NODE_USE_ENV_PROXY=1
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca --mount=type=bind,from=pnpm-store,source=/,target=/pnpm-cache,readonly \
    set -eu; if [ -d /pnpm-cache/v10 ]; then mkdir -p /pnpm-offline; cp -a /pnpm-cache/. /pnpm-offline/; export npm_config_store_dir=/pnpm-offline npm_config_offline=true; if [ -d /pnpm-cache/metadata-v1.3 ]; then mkdir -p /root/.cache/pnpm; cp -a /pnpm-cache/metadata-v1.3 /root/.cache/pnpm/; fi; fi; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile --filter @editagent/render-worker... --ignore-scripts \
 && pnpm --filter @editagent/render-worker... build \
 && find /app -type f \( -name '*.test.js*' -o -name '*.test.d.ts*' -o -name '*.test.ts' \) -delete \
 && pnpm --filter @editagent/render-worker --prod deploy --legacy /out \
 && node -e 'require.resolve("@remotion/compositor-linux-x64-gnu", {paths:["/out"]})' \
 && rm -rf /pnpm-offline

# Reuse the audited US-127 media-tool build recipe: no network protocols/libxml2/DASH.
FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS media-tools
COPY workers/media-worker/build-ffmpeg.sh /tmp/build-ffmpeg.sh
WORKDIR /src
RUN --mount=type=secret,id=proxy_ca \
    set -eu; if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils build-essential pkg-config nasm zlib1g-dev libx264-dev libvpx-dev libopus-dev \
 && sh /tmp/build-ffmpeg.sh

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS chromium-download
RUN --mount=type=secret,id=proxy_ca \
    set -eu; apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && mkdir -p /opt/chromium \
 && if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    curl --fail --location --retry 2 --max-time 180 'https://remotion.media/chromium-headless-shell-linux-x64-157.0.8080.0.zip?clear' -o /tmp/chromium.zip \
 && echo '7c4a2751b361aeb3cff3ed788fa18b7a0849371b983d478bb9205b6cc25a8c52  /tmp/chromium.zip' | sha256sum -c - \
 && unzip -q /tmp/chromium.zip -d /opt/chromium

# Debian's current Expat 2.8.3 has five HIGH advisories. Build the unmodified
# official release fixing them; keep its version/license/source identity visible.
FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS expat-build
RUN --mount=type=secret,id=proxy_ca \
    set -eu; apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils build-essential \
 && if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    curl --fail --location --retry 2 --max-time 180 https://github.com/libexpat/libexpat/releases/download/R_2_9_0/expat-2.9.0.tar.xz -o /tmp/expat.tar.xz \
 && echo '1e6371862cc31999b368c3b89b49994f0677e1bab5f1b2b85ae3741f5d803051  /tmp/expat.tar.xz' | sha256sum -c - \
 && mkdir /src && tar -xJf /tmp/expat.tar.xz -C /src --strip-components=1 \
 && cd /src && ./configure --prefix=/usr/local --disable-static --without-xmlwf --without-docbook \
 && make -j2 && make DESTDIR=/out install \
 && mkdir -p /out/usr/local/share/editagent/expat \
 && cp COPYING Changes /out/usr/local/share/editagent/expat/ \
 && printf '%s\n' 'expat 2.9.0' 'source=https://github.com/libexpat/libexpat/releases/download/R_2_9_0/expat-2.9.0.tar.xz' 'sourceSha256=1e6371862cc31999b368c3b89b49994f0677e1bab5f1b2b85ae3741f5d803051' > /out/usr/local/share/editagent/expat/provenance.txt

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libx264-164 libvpx9 libopus0 ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && groupadd --system --gid 10001 editagent \
 && useradd --system --uid 10001 --gid 10001 --home-dir /home/editagent --create-home --shell /usr/sbin/nologin editagent \
 && mkdir -p /render-work /run/render && chown 10001:10001 /render-work /run/render
COPY --from=media-tools /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
ENV FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe
WORKDIR /app
ENV NODE_ENV=production

FROM runtime AS browser-runtime
# Actual Chrome 157 ldd dependencies: NSS/NSPR, Expat and libc. No GUI stack,
# libxml2, libcups, curl or package manager is needed by the runtime.
RUN apt-get update && apt-get install -y --no-install-recommends libnss3 fonts-dejavu-core fontconfig-config \
 && rm -rf /var/lib/apt/lists/*
COPY --from=expat-build /out/usr/local/lib/libexpat.so* /usr/local/lib/
COPY --from=expat-build /out/usr/local/share/editagent/expat /usr/local/share/editagent/expat
RUN ldconfig && test "$(ldd /usr/local/lib/libexpat.so.1 | grep -c 'not found')" = 0
COPY --from=chromium-download /opt/chromium /opt/chromium

FROM browser-runtime AS executor
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
CMD ["node", "dist/infrastructure/executor.js"]
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
 CMD ["node", "-e", "require('node:http').get({socketPath:'/run/render/control.sock',path:'/ready'},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]

# Default target is the credentialed coordinator; Chromium exists only in executor.
FROM runtime AS coordinator
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
CMD ["node", "dist/index.js"]
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
 CMD ["node", "-e", "fetch('http://127.0.0.1:3200/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
