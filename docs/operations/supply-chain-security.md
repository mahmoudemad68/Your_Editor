# Supply-chain security check

`.github/workflows/supply-chain.yml` is the security check for `main`. The stable job name is `supply-chain-security`. This workflow does not log in to a registry, push an image, or deploy staging. Those steps stay on the US-113 pull request.

## What is scanned

Dependency scans:

- Gitleaks `8.30.1` over the git history, with `.gitleaks.toml`.
- `pnpm audit` of the frozen lockfile. The JSON report is kept. Critical findings fail the dependency job. High findings are printed and kept.
- `uv export --all-groups` plus `pip-audit` for `workers/ai-worker`, including the locked development group. `UV_NO_DEV`, `UV_NO_GROUP`, and `UV_NO_DEFAULT_GROUPS` are unset so they cannot drop that group. Severity comes from OSV CVSS v3 and CVSS v4.0 vectors. Critical findings fail the job. A finding with no severity, or a severity that cannot be scored, also fails. High findings are printed and the JSON report is kept.

Images built from Dockerfiles that `compose.yaml` already references:

- `apps/api/Dockerfile`
- `apps/web/Dockerfile`
- `workers/media-worker/Dockerfile`
- `workers/render-worker/Dockerfile`
- `workers/agent-worker/Dockerfile`
- `workers/ai-worker/Dockerfile`
- `infra/seaweedfs/Dockerfile`
- `infra/postgres/Dockerfile`
- `infra/redis/Dockerfile`

`tools/benchmarks/rendering/docker/Dockerfile` is a research harness and is not a runtime service, so it is outside this matrix. The SeaweedFS image is the digest pinned in `infra/seaweedfs/Dockerfile`. Master, volume, filer, and the S3 gateway share that one image, so the workflow scans it once. Object ingress is not in this tree.

## Policy

Trivy `0.75.0` writes a JSON report at `--severity HIGH,CRITICAL` and then fails the image job on `--severity CRITICAL --exit-code 1`. The SBOM is SPDX JSON from Syft `1.54.0`. SBOM files, Trivy JSON, Trivy version text, and dependency reports are uploaded even when a later critical scan fails.

The image scan passes `--config=`, `--ignorefile=`, `--secret-config=`, and `--ignore-unfixed=false`, so a repository `trivy.yaml`, a custom ignore file, or `trivy-secret.yaml` cannot weaken the policy. A conventional `.trivyignore` or `.trivyignore.yaml` still stops the scan. High findings are not accepted by this check. They remain in the report and in the `supply-chain-security` log. The job `supply-chain-security` passes only when every required scan result file contains `pass`.

`.gitleaks.toml` allows only the detected secrets `editagent-dev-password` and `editagent-dev-secret`. Another credential on the same line is still reported. That allowlist is not a vulnerability exception.

## Required check

### Issue #86: exact historical synthetic-fixture exceptions

On 2026-10-26, the project Owner (mahmoudemad68), also acting as Security
Reviewer, authorized six exact `.gitleaksignore` fingerprints on Draft PR #84.
These are two roles held by the same person, not two independent approvals.
The [classification](https://github.com/mahmoudemad68/Your_Editor/issues/86#issuecomment-6413865527)
and [implementation authorization](https://github.com/mahmoudemad68/Your_Editor/issues/86#issuecomment-6413921336)
cover only three invalid, unsigned or incomplete JWT-shaped adversarial QA
fixtures detected twice in historical QA commits. No live credential exception
is approved.

The six lines are copied from the `Fingerprint` fields of the redacted
`supply-chain-dependencies` artifact (ID `12614147383`, run `40234287281`).
The authenticated archive SHA-256 is
`69da7fd5590433991ea427da52876162f0aa0149c5a1101096c94b4f5476be22`.
The exact six-line ignore file SHA-256 is
`3eddba83701c1d63d7d7cab7b45eda5b9b8280e15a89904a269e391228265a7f`.
Each entry binds a commit, path, detector rule and line. The file itself is the
complete exception inventory; it contains no path, rule, branch or whole-commit
allowlist. QA branch history is preserved. Matches elsewhere remain findings.

Risk: these six historical detections are no longer reported. This does not
waive new detections or establish credential validity from a rule name. Full
history, default rules, the existing config, redaction, pinned Gitleaks 8.30.1,
and failure exit code remain unchanged. New or uncertain credentials require
incident triage rather than expansion of this exception.

Manual review date: **2026-11-26** (review reminder, not automatic expiry).
Owner/Security Reviewer must reassess scope and continued need. Rollback:
remove the six-line `.gitleaksignore` and rerun the unchanged full-history scan;
the six historical findings will block again until separately resolved.

Regression commands with the pinned scanner on PATH:

```sh
python3 infra/scripts/secret-canary.py
python3 infra/scripts/test-secret-exceptions.py
```

The original canary remains unchanged. New controls generate only disposable
synthetic history, verify the exact six-line inventory, prove fingerprint
loading, and require fresh secrets plus moved commit/line/path and newly
generated QA-coordinate JWT data to fail. They never copy the historical
matched values. The architecture suite runs the new controls as well.

This scoped security-policy decision does not approve Ready, merge, deployment
or Independent Re-QA. All three required workflows must pass at the published
head before the Technical Lead assigns separate Re-QA.

This pull request does not change the `main` ruleset. The required status check stays `ci` until a repository admin adds `supply-chain-security`.
