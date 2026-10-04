# syntax=docker/dockerfile:1
# Staging object ingress. The runtime is the same digest-pinned Node image
# used by the API. It forwards signed object requests and refuses MinIO
# STS and admin paths.

FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libpcre2-8-0=10.46-1~deb13u3 \
      libssl3t64=3.5.7-1~deb13u3 \
      openssl-provider-legacy=3.5.7-1~deb13u3 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN groupadd --system --gid 10001 editagent \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/editagent --create-home --shell /usr/sbin/nologin editagent
COPY infra/object-ingress/server.mjs /srv/server.mjs
USER 10001:10001
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "/srv/server.mjs"]
