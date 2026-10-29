# SeaweedFS 4.51; immutable upstream image contains brotli-libs 1.2.1-r0,
# fixing native decoder CVE-2026-111497. Fresh scans remain mandatory.
# The upstream entrypoint starts as root only to fix /data ownership, then
# su-exec drops to uid 1000 (seaweed).

FROM golang:1.26.10-alpine3.24@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS compiler

FROM chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8 AS builder
COPY --from=compiler /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 \
    GOMAXPROCS=2 GOMEMLIMIT=5GiB GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
    GOPRIVATE="" GONOPROXY="" GONOSUMDB=""
WORKDIR /build
COPY infra/seaweedfs/security-build.lock.json /build/security-build.lock.json
COPY infra/seaweedfs/build-weed.sh /build/build-weed.sh
RUN --network=none sh /build/build-weed.sh bootstrap
RUN sh /build/build-weed.sh prepare
RUN --network=none sh /build/build-weed.sh compile

FROM chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8 AS runtime-files
RUN rm /usr/bin/weed

# Copy the resulting filesystem, not the donor layers: the old Go ELF is absent
# from EVERY final layer. Never copy the builder's source/cache/compiler tree.
FROM scratch AS runtime
COPY --from=runtime-files / /
COPY --from=builder /out/weed /usr/bin/weed
COPY --from=builder /out/provenance /usr/share/editagent-seaweedfs
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
LABEL org.opencontainers.image.title="EditAgent SeaweedFS 4.51 security rebuild" \
    org.opencontainers.image.version="4.51-editagent-sec1" \
    io.editagent.seaweedfs.source="ffa87c25fdf587178b1521ad87f2a4a72a02e584"
WORKDIR /data
VOLUME /data
EXPOSE 18080 8080 18888 8888 19333 9333 8333 7333
CMD ["mini", "-dir=/data"]

# The upstream entrypoint drops to uid 1000. This wrapper holds that entry
# until apply-container-firewall.sh has installed this namespace's input rules.
COPY infra/seaweedfs/docker-entrypoint.sh /usr/local/bin/editagent-entrypoint.sh
RUN chmod 755 /usr/local/bin/editagent-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/editagent-entrypoint.sh"]

# Test-only executable; never part of the default production target.
FROM runtime AS security-probes
COPY --from=builder /out/security-probe /security-probe
COPY --from=builder /out/jose.test /jose.test
COPY --from=builder /out/brotli.test /brotli.test
COPY --from=builder /root/go/pkg/mod/github.com/go-jose/go-jose/v4@v4.1.6 /tests/jose
COPY --from=builder /root/go/pkg/mod/github.com/andybalholm/brotli@v1.2.7 /tests/brotli
ENTRYPOINT ["/security-probe"]

FROM runtime AS final
