# syntax=docker/dockerfile:1
# SeaweedFS 4.51; immutable upstream image contains brotli-libs 1.2.1-r0,
# fixing native decoder CVE-2026-111497. Fresh scans remain mandatory.
# The upstream entrypoint starts as root only to fix /data ownership, then
# su-exec drops to uid 1000 (seaweed).

FROM chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8

# The upstream entrypoint drops to uid 1000. This wrapper holds that entry
# until apply-container-firewall.sh has installed this namespace's input rules.
COPY infra/seaweedfs/docker-entrypoint.sh /usr/local/bin/editagent-entrypoint.sh
RUN chmod 755 /usr/local/bin/editagent-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/editagent-entrypoint.sh"]
