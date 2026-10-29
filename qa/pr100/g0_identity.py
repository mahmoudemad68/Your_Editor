#!/usr/bin/env python3
"""G0 identity, diff, protected-file, claimed-artifact, and pre-fix log checks."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from results import emit  # noqa: E402

PRODUCT = "12b09f704d32bc68f662404872586f89d26f284f"
TREE = "ae20e671caceeb8c567c227692cbdea428b7762b"
BASE = "5cdb1d794d347a36d869027947bb62504dddff92"
PR98 = "98288b652c36a3e557e45599e29ac60d27e0f92f"
MERGE = "dc975b5122f85d799319602d98b14780d1648431"
REPO = "mahmoudemad68/Your_Editor"
BLOBS = {
    ".github/workflows/ci.yml": "380cb9008b260dc51df66a916b71c52ce2f83cd8f6aefc9c889f411b6410e284",
    ".github/workflows/supply-chain.yml": "7159e14068516416ac36085d4e9f09b146531cb537fc466bcd7e36f06109d7be",
    "docs/operations/ci-security-remediation-99.md": "df9a321b9f57955d26d3826deac8cba6a43aeaed39a4602d07a32fe9ba6ff677",
    "infra/seaweedfs/Dockerfile": "98d34142553b1452f2b16eec773b14fb691524bf4a5eb60448b35e2986353722",
    "tests/architecture/ffmpeg-download.test.mjs": "03be5d3fbaf9e90cf703de2b9fd44f8a732c3bb632e0e4a08dcdd4590b73b569",
    "tests/architecture/seaweedfs-object-storage.test.mjs": "de65ab4a08ac6172adebb7d2c66350dff53d4565aee942ae2c83cca13ff8ca0a",
    "tests/architecture/seaweedfs-s3-contract.mjs": "839d623745fbe3d3d144c8604d2818e342bec0ccd001165333a01439c5f71f09",
    "tools/test/ffmpeg-download-controls.py": "d68a21f9943e03efa6b3067a9ff6e9795085c9e5c39a73e1a6c27412c03ace46",
    "workers/media-worker/build-ffmpeg.sh": "407aa62c03ec54c3c6c189f7660611ed2e709225720e4ba22a3673bf712deeff",
}
PROTECTED = [
    ".gitleaks.toml",
    ".gitleaksignore",
    ".github/workflows/e2e.yml",
    "compose.yaml",
    "infra/scripts/install-supply-chain-tools.sh",
    "infra/scripts/supply-chain-findings.py",
    "infra/scripts/supply-chain-scan-image.sh",
    "infra/scripts/supply-chain-security-gate.sh",
    "infra/scripts/verify-media-ffmpeg.sh",
    "infra/seaweedfs/apply-container-firewall.sh",
    "infra/seaweedfs/apply-host-isolation.sh",
    "infra/seaweedfs/backup-volumes.sh",
    "infra/seaweedfs/docker-entrypoint.sh",
    "infra/seaweedfs/prepare-secrets.sh",
    "infra/seaweedfs/restore-volumes.sh",
    "infra/seaweedfs/start-storage.sh",
    "infra/seaweedfs/verify-firewall-lifecycle.sh",
    "infra/seaweedfs/verify-jwt-authority.sh",
    "infra/seaweedfs/verify-trust-boundary.sh",
    "workers/media-worker/Dockerfile",
    "workers/render-worker/Dockerfile",
]
TRIVY_SHA = "f2fcb1fc4f5520b9d73e20687af05da81f6346695bca1dba2eb139a958139f1f"
SBOM_SHA = "57e7a150eb367ae6a9033a3a4cee5da8d4459c2bd92f2b45feb0de444c65e4b0"


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def blob_sha256(rev: str, path: str) -> str:
    data = subprocess.check_output(["git", "cat-file", "blob", f"{rev}:{path}"])
    return hashlib.sha256(data).hexdigest()


def gh_json(args: list[str]) -> dict | list:
    completed = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return json.loads(completed.stdout)


def main() -> int:
    results = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("qa-results-g0.jsonl")
    evidence = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("qa-evidence")
    evidence.mkdir(parents=True, exist_ok=True)
    failures = 0

    def record(case_id: str, status: str, required: bool, detail: str) -> None:
        nonlocal failures
        if status in {"FAIL", "ERROR"} or (status == "NOT_VERIFIED" and required):
            failures += 1
        emit(results, case_id, "G0" if case_id.startswith("g0.") else "G4", status, required, detail)

    head = git("rev-parse", PRODUCT)
    tree = git("rev-parse", f"{PRODUCT}^{{tree}}")
    record("g0.product_head", "PASS" if head == PRODUCT else "FAIL", True, head)
    record("g0.product_tree", "PASS" if tree == TREE else "FAIL", True, tree)
    record(
        "g0.no_head_drift",
        "PASS" if head == PRODUCT and tree == TREE else "FAIL",
        True,
        "HEAD_DRIFT" if head != PRODUCT or tree != TREE else "live product commit and tree match the frozen pin",
    )

    try:
        pr = gh_json(["pr", "view", "100", "--repo", REPO, "--json", "state,isDraft,headRefOid,baseRefOid,headRefName"])
        pr_ok = pr["state"] == "OPEN" and pr["isDraft"] and pr["headRefOid"] == PRODUCT and pr["baseRefOid"] == BASE
        record("g0.pr100_open_draft", "PASS" if pr_ok else "FAIL", True, json.dumps(pr, sort_keys=True))
        pr98 = gh_json(["pr", "view", "98", "--repo", REPO, "--json", "state,isDraft,headRefOid"])
        pr98_ok = pr98["state"] == "OPEN" and pr98["isDraft"] and pr98["headRefOid"] == PR98
        record("g0.pr98_unchanged", "PASS" if pr98_ok else "FAIL", True, json.dumps(pr98, sort_keys=True))
        main_sha = subprocess.check_output(["git", "ls-remote", "origin", "refs/heads/main"], text=True).split()[0]
        record("g0.main_sha", "PASS" if main_sha == BASE else "FAIL", True, main_sha)
    except Exception as exc:  # noqa: BLE001
        record("g0.pr100_open_draft", "ERROR", True, str(exc))
        record("g0.pr98_unchanged", "ERROR", True, str(exc))
        record("g0.main_sha", "ERROR", True, str(exc))

    mismatches = [f"{path} {blob_sha256(PRODUCT, path)}" for path, expected in BLOBS.items() if blob_sha256(PRODUCT, path) != expected]
    record("g0.nine_blob_hashes", "PASS" if not mismatches else "FAIL", True, "all nine published blob SHA-256 values match" if not mismatches else "; ".join(mismatches))
    diff = [line for line in git("diff", "--name-only", BASE, PRODUCT).splitlines() if line]
    record("g0.product_diff_exact", "PASS" if diff == sorted(BLOBS) else "FAIL", True, " ".join(diff))
    qa_diff = [line for line in git("diff", "--name-only", PRODUCT, "HEAD").splitlines() if line]
    qa_ok = all(path.startswith("qa/") or path == ".github/workflows/qa-pr100-independent.yml" for path in qa_diff)
    record("g0.qa_paths_only", "PASS" if qa_ok else "FAIL", True, " ".join(qa_diff) or "(no QA commits yet)")

    protected_bad = []
    for path in PROTECTED:
        if blob_sha256(BASE, path) != blob_sha256(PRODUCT, path) or blob_sha256(PRODUCT, path) != blob_sha256("HEAD", path):
            protected_bad.append(path)
    record(
        "g0.protected_byte_identical",
        "PASS" if not protected_bad else "FAIL",
        True,
        f"{len(PROTECTED)} tracked security/runtime files match base and HEAD" if not protected_bad else " ".join(protected_bad),
    )
    source = subprocess.check_output(["git", "cat-file", "blob", f"{PRODUCT}:workers/media-worker/build-ffmpeg.sh"])
    base_source = subprocess.check_output(["git", "cat-file", "blob", f"{BASE}:workers/media-worker/build-ffmpeg.sh"])
    tail = source[source.index(b"./configure") :]
    base_tail = base_source[base_source.index(b"./configure") :]
    tail_hash = hashlib.sha256(tail).hexdigest()
    record(
        "g0.ffmpeg_tail_byte_identical",
        "PASS" if tail == base_tail else "FAIL",
        True,
        f"configure-through-EOF sha256={tail_hash} identical_to_base={tail == base_tail}; published digest 4872da12391663be45d5592cd78991686d0d7b40c55ef65f5bee8f76d225d1bc was not reproduced from any contiguous line range",
    )
    ci_diff = git("diff", "-U0", BASE, PRODUCT, "--", ".github/workflows/ci.yml")
    ci_ok = ci_diff.count("\n+") == 2 and "--verify-backup" in ci_diff and "600000" not in ci_diff
    record("g0.ci_diff_only_backup_flag", "PASS" if ci_ok else "FAIL", True, "ci.yml adds only --verify-backup on the S3 contract step")
    sc_diff = git("diff", BASE, PRODUCT, "--", ".github/workflows/supply-chain.yml")
    sc_ok = "brotli-libs" in sc_diff and "1.2.1-r0" in sc_diff and "trivy" not in sc_diff.lower().split("brotli")[0][-200:]
    # The scan policy commands themselves must be absent from the diff hunks as changed lines.
    changed_lines = [line[1:] for line in sc_diff.splitlines() if line.startswith("+") and not line.startswith("+++")]
    policy_touch = any("ignore" in line.lower() or "severity" in line.lower() or "exit-code" in line for line in changed_lines)
    record(
        "g0.supply_chain_diff_scope",
        "PASS" if sc_ok and not policy_touch else "FAIL",
        True,
        "supply-chain.yml adds the native Brotli/uid check only" if sc_ok and not policy_touch else sc_diff[:500],
    )

    try:
        trivy_dir = evidence / "claimed-trivy"
        sbom_dir = evidence / "claimed-sbom"
        subprocess.run(["gh", "run", "download", "40827936889", "--repo", REPO, "-n", "supply-chain-trivy-seaweedfs", "-D", str(trivy_dir)], check=True)
        subprocess.run(["gh", "run", "download", "40827936889", "--repo", REPO, "-n", "supply-chain-sbom-seaweedfs", "-D", str(sbom_dir)], check=True)
        trivy_hash = hashlib.sha256((trivy_dir / "trivy-seaweedfs.json").read_bytes()).hexdigest()
        sbom_hash = hashlib.sha256((sbom_dir / "sbom-seaweedfs.spdx.json").read_bytes()).hexdigest()
        record("g0.claimed_trivy_sha", "PASS" if trivy_hash == TRIVY_SHA else "FAIL", True, trivy_hash)
        record("g0.claimed_sbom_sha", "PASS" if sbom_hash == SBOM_SHA else "FAIL", True, sbom_hash)
        document = json.loads((trivy_dir / "trivy-seaweedfs.json").read_text(encoding="utf-8"))
        (evidence / "claimed-trivy-image.txt").write_text(
            f"ArtifactName={document.get('ArtifactName')}\nImageID={(document.get('Metadata') or {}).get('ImageID')}\n",
            encoding="utf-8",
        )
        record(
            "g0.merge_ref_distinguished",
            "PASS" if MERGE in str(document.get("ArtifactName")) and PRODUCT not in str(document.get("ArtifactName")) else "FAIL",
            True,
            f"claimed scan artifact is tagged {document.get('ArtifactName')}; product head is {PRODUCT}; merge ref {MERGE} is not the product checkout",
        )
    except Exception as exc:  # noqa: BLE001
        record("g0.claimed_trivy_sha", "NOT_VERIFIED", True, str(exc))
        record("g0.claimed_sbom_sha", "NOT_VERIFIED", True, str(exc))
        record("g0.merge_ref_distinguished", "NOT_VERIFIED", True, str(exc))

    def log_has(run_id: str, needles: list[str]) -> str:
        destination = evidence / f"run-{run_id}-excerpt.txt"
        completed = subprocess.run(["gh", "run", "view", run_id, "--repo", REPO, "--log-failed"], capture_output=True, text=True, check=False)
        text = completed.stdout + completed.stderr
        lines = [line for line in text.splitlines() if any(needle in line for needle in needles)]
        destination.write_text("\n".join(lines[:80]) + "\n", encoding="utf-8")
        return "\n".join(lines[:8])

    try:
        curl_excerpt = log_has("40816237286", ["curl: (35)", "build-ffmpeg.sh"])
        media_excerpt = log_has("40816237539", ["curl: (35)", "CVE-2026-111497", "brotli-libs"])
        record("g0.pre_fix_curl35", "PASS" if "curl: (35)" in curl_excerpt and "curl: (35)" in media_excerpt else "FAIL", True, "runs 40816237286 and 40816237539 contain curl 35 from build-ffmpeg.sh")
        record("g0.pre_fix_brotli_critical", "PASS" if "CVE-2026-111497" in media_excerpt and "1.2.0-r1" in media_excerpt else "FAIL", True, "run 40816237539 reports CRITICAL brotli-libs 1.2.0-r1")
        intermediate = log_has("40826429110", ["curl: (35)", "curl: (28)"])
        walking = log_has("40826429145", ["curl: (35)", "curl: (28)"])
        record(
            "g0.intermediate_primary_exhausted",
            "PASS" if "curl: (35)" in intermediate and "curl: (28)" in intermediate and "curl: (35)" in walking else "FAIL",
            True,
            "head a0956fc runs 40826429110 and 40826429145 exhausted primary retries with curl 28/35 before fallback existed",
        )
    except Exception as exc:  # noqa: BLE001
        record("g0.pre_fix_curl35", "NOT_VERIFIED", True, str(exc))
        record("g0.pre_fix_brotli_critical", "NOT_VERIFIED", True, str(exc))
        record("g0.intermediate_primary_exhausted", "NOT_VERIFIED", True, str(exc))

    record(
        "g0.local_27_windows",
        "NOT_VERIFIED",
        False,
        "The 27 protected working-file hashes and the local handoff JSON are unpublished Windows working-copy files. This runner verified the published Git diff only.",
    )
    workflow = (ROOT / ".github/workflows/qa-pr100-independent.yml").read_text(encoding="utf-8")
    label_ok = "qa/pr100-12b09f7" in workflow and "Independent QA" in workflow
    record("g4.qa_branch_label", "PASS" if label_ok else "FAIL", True, "workflow is labeled Independent QA and triggers on qa/pr100-12b09f7")
    record("g4.no_publish_job", "PASS" if "\n  publish:" not in workflow and "owner-approved staging" not in workflow else "FAIL", True, "QA workflow has no image publish or staging job")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
