# Supply-chain security check

`.github/workflows/supply-chain.yml` is the security check for `main`. The stable job name is `supply-chain-security`. This workflow does not log in to a registry, push an image, or deploy staging. Those steps stay on the US-113 pull request.

## What is scanned

Dependency scans:

- Gitleaks `8.30.1` over the git history, with `.gitleaks.toml`.
- `pnpm audit` of the frozen lockfile. The JSON report is kept. Critical findings fail the dependency job. High findings are printed and kept.
- `uv export` plus `pip-audit` for `workers/ai-worker`. Severity comes from the OSV CVSS vector. Critical findings fail the job. High findings are printed and the JSON report is kept. A finding with no CVSS vector is printed and does not fail the critical gate.

Images built from Dockerfiles that `compose.yaml` already references:

- `apps/api/Dockerfile`
- `apps/web/Dockerfile`
- `workers/media-worker/Dockerfile`
- `workers/render-worker/Dockerfile`
- `workers/agent-worker/Dockerfile`
- `workers/ai-worker/Dockerfile`
- `infra/minio/Dockerfile`

Upstream images pinned by `compose.yaml`:

- `postgres:16.10-alpine`
- `redis:7.4-alpine`

`tools/benchmarks/rendering/docker/Dockerfile` is a research harness and is not a runtime service, so it is outside this matrix. Object ingress, a rebuilt Postgres image, and SeaweedFS are not on `main`, so this workflow does not scan them.

## Policy

Trivy `0.75.0` writes a JSON report at `--severity HIGH,CRITICAL` and then fails the image job on `--severity CRITICAL --exit-code 1`. The SBOM is SPDX JSON from Syft `1.54.0`. SBOM files, Trivy JSON, Trivy version text, and dependency reports are uploaded even when a later critical scan fails.

There is no `.trivyignore`, no `--ignore-unfixed`, and no vulnerability ignore file. `supply-chain-scan-image.sh` stops if one is present and unsets `TRIVY_IGNORE_UNFIXED` and `TRIVY_IGNOREFILE`. High findings are not accepted by this check. They remain in the report and in the `supply-chain-security` log. The job `supply-chain-security` passes only when every required scan result file contains `pass`.

`.gitleaks.toml` allows two local Compose placeholders, `editagent-dev-password` and `editagent-dev-secret`. That allowlist is not a vulnerability exception.

## Required check

This pull request does not change the `main` ruleset. The required status check stays `ci` until a repository admin adds `supply-chain-security`.
