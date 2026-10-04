# syntax=docker/dockerfile:1
# SeaweedFS 4.48 on Alpine 3.24.2. The digest was scanned with the repository
# Trivy policy (HIGH,CRITICAL, no ignore file) and reported zero findings.
# The upstream entrypoint starts as root only to fix /data ownership, then
# su-exec drops to uid 1000 (seaweed).

FROM chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d
