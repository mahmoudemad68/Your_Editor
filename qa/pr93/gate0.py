"""Independent Gate 0 for Draft PR #93. Reads GitHub metadata and the pinned product checkout only."""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

APP = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2])
REPO = os.environ["GITHUB_REPOSITORY"]
HEAD = os.environ["QA_APP_SHA"]
BASE = os.environ["QA_BASE_SHA"]
TREE = os.environ["QA_APP_TREE"]
CHANGED = int(os.environ["QA_CHANGED_FILES"])
COMMITS = int(os.environ["QA_COMMIT_COUNT"])
PRIOR = os.environ["QA_PRIOR_SHA"]
REPAIR = os.environ["QA_REPAIR_PATCH_SHA"]
CI = {
    "CI": "40731938064",
    "Walking skeleton E2E": "40731938198",
    "Supply chain": "40731937900",
}
HELD = (
    ["docs/evaluation/METRICS.md"]
    + [
        f"docs/evaluation/artifacts/commons-{n}-{k}.json"
        for n, ks in {
            "148215183": ["edit-spec", "render-receipt"],
            "165959826": ["edit-spec", "render-receipt"],
            "28956463": [
                "edit-spec",
                "render-receipt",
                "silence-labels",
                "word-alignment",
            ],
            "7740925": ["edit-spec", "render-receipt"],
            "82236797": [
                "edit-spec",
                "render-receipt",
                "silence-labels",
                "word-alignment",
            ],
            "98650286": [
                "edit-spec",
                "render-receipt",
                "silence-labels",
                "word-alignment",
            ],
        }.items()
        for k in ks
    ]
    + [
        "packages/schemas/src/job-event-validator.generated.js",
        "packages/schemas/src/job-event.generated.ts",
        "packages/schemas/src/media-analysis-v1_1.generated.ts",
        "packages/schemas/src/media-analysis.generated.ts",
        "tests/architecture/ffmpeg-boundary.test.mjs",
        "tools/architecture/ffmpeg-boundary.mjs",
        "workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py",
        "workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_v1_1_generated.py",
    ]
)
SECURITY = [
    ".gitleaks.toml",
    ".gitleaksignore",
    "infra/scripts/install-supply-chain-tools.sh",
    "infra/scripts/secret-canary.py",
    "tools/test/audit-artifacts.py",
    ".github/workflows/supply-chain.yml",
    ".github/workflows/e2e.yml",
    ".github/workflows/roadmap.yml",
]
results = []


def gh(path):
    return json.loads(
        subprocess.run(
            ["gh", "api", path], check=True, capture_output=True, text=True
        ).stdout
    )


def git(*args, binary=False):
    proc = subprocess.run(
        ["git", "-C", str(APP), *args], check=True, capture_output=True
    )
    return proc.stdout if binary else proc.stdout.decode()


def probe(pid, title, fn):
    try:
        status, actual = fn()
    except Exception as error:  # noqa: BLE001
        status, actual = "ERROR", f"{type(error).__name__}: {error}"[:800]
    results.append(
        {
            "id": pid,
            "title": title,
            "status": status,
            "expected": "",
            "actual": actual,
            "ms": 0,
        }
    )
    print(f"[QA93] {pid} {status} {title}", flush=True)


def g0_identity():
    pr = gh(f"repos/{REPO}/pulls/93")
    main = gh(f"repos/{REPO}/git/ref/heads/main")["object"]["sha"]
    head = git("rev-parse", "HEAD").strip()
    tree = git("rev-parse", "HEAD^{tree}").strip()
    commits = int(git("rev-list", "--count", f"{BASE}..{HEAD}").strip())
    dirty = git("status", "--porcelain").strip()
    facts = {
        "open": pr["state"] == "open",
        "draft": pr["draft"] is True,
        "merged": pr["merged"] is False,
        "head": pr["head"]["sha"] == HEAD == head,
        "base": pr["base"]["sha"] == BASE,
        "main": main == BASE,
        "tree": tree == TREE,
        "changed": pr["changed_files"] == CHANGED,
        "commits": pr["commits"] == COMMITS and commits == COMMITS,
        "ancestor": git("merge-base", "--is-ancestor", BASE, HEAD) == "" or True,
        "clean": dirty == "",
        "branch": pr["head"]["ref"] == "codex/us312-us313-captions",
    }
    # merge-base --is-ancestor exits 0; git() would have thrown otherwise.
    facts["ancestor"] = True
    ok = all(facts[k] for k in facts if k != "ancestor") and facts["ancestor"]
    return ("PASS" if ok else "FAIL"), facts


def g0_inventory():
    pr = gh(f"repos/{REPO}/pulls/93")
    rows = {
        path: (blob, digest)
        for path, blob, digest in re.findall(
            r"^\| `([^`]+)` \| `([0-9a-f]{40})` \| `([0-9a-f]{64})` \|",
            pr["body"],
            re.MULTILINE,
        )
    }
    diff = git("diff", "--name-only", BASE, HEAD).split()
    api, page = [], 1
    while True:
        chunk = gh(f"repos/{REPO}/pulls/93/files?per_page=100&page={page}")
        api += [item["filename"] for item in chunk]
        if len(chunk) < 100:
            break
        page += 1
    mismatches = []
    measured = {}
    for path in diff:
        blob = git("rev-parse", f"{HEAD}:{path}").strip()
        digest = hashlib.sha256(
            git("cat-file", "blob", f"{HEAD}:{path}", binary=True)
        ).hexdigest()
        measured[path] = digest
        published = rows.get(path)
        if published is not None and published != (blob, digest):
            mismatches.append(path)
    same = set(diff) == set(api) and (not rows or set(rows) == set(diff))
    return ("PASS" if same and len(diff) == CHANGED and not mismatches else "FAIL"), {
        "rows": len(rows),
        "diff": len(diff),
        "api": len(api),
        "same": same,
        "mismatches": mismatches,
        "liveChanged": pr["changed_files"],
        "hashes": measured,
    }


def g0_patch():
    full = hashlib.sha256(git("diff", "--binary", BASE, HEAD, binary=True)).hexdigest()
    repair = hashlib.sha256(
        git("diff", "--binary", PRIOR, HEAD, binary=True)
    ).hexdigest()
    return ("PASS" if repair == REPAIR else "FAIL"), {
        "full": full,
        "repair": repair,
        "publishedRepair": REPAIR,
    }


def g0_ci():
    out = {}
    ok = True
    for name, run_id in CI.items():
        run = gh(f"repos/{REPO}/actions/runs/{run_id}")
        out[name] = {
            "head": run["head_sha"],
            "conclusion": run["conclusion"],
            "attempt": run["run_attempt"],
            "event": run["event"],
            "branch": run["head_branch"],
        }
        ok = (
            ok
            and run["head_sha"] == HEAD
            and run["conclusion"] == "success"
            and run["head_branch"] == "codex/us312-us313-captions"
        )
    pr = gh(f"repos/{REPO}/pulls/93")
    merge_sha = pr["merge_commit_sha"]
    merge = gh(f"repos/{REPO}/commits/{merge_sha}")
    parents = [item["sha"] for item in merge["parents"]]
    tree_ok = (
        merge["commit"]["tree"]["sha"] == TREE and HEAD in parents and BASE in parents
    )
    out["merge"] = {
        "parents": parents,
        "tree": merge["commit"]["tree"]["sha"],
        "treeOk": tree_ok,
    }
    return ("PASS" if ok and tree_ok else "FAIL"), out


def g0_supply_retry():
    attempt1 = gh(f"repos/{REPO}/actions/runs/{CI['Supply chain']}/attempts/1")
    jobs = gh(
        f"repos/{REPO}/actions/runs/{CI['Supply chain']}/jobs?filter=all&per_page=100"
    )["jobs"]
    failed = [
        job
        for job in jobs
        if job["run_attempt"] == 1 and job["conclusion"] == "failure"
    ]
    workflow_same = (
        git("rev-parse", f"{BASE}:.github/workflows/supply-chain.yml").strip()
        == git("rev-parse", f"{HEAD}:.github/workflows/supply-chain.yml").strip()
    )
    ok = (
        attempt1["conclusion"] == "success"
        and attempt1["head_sha"] == HEAD
        and attempt1["run_attempt"] == 1
        and not failed
        and workflow_same
    )
    return ("PASS" if ok else "FAIL"), {
        "attempt1": attempt1["conclusion"],
        "attempt": attempt1["run_attempt"],
        "failedJobs": sorted(job["name"] for job in failed),
        "supplyChainWorkflowUnchanged": workflow_same,
    }


def g0_held():
    diff = set(git("diff", "--name-only", BASE, HEAD).split())
    changed = []
    digests = {}
    for path in HELD:
        base_blob = git("rev-parse", f"{BASE}:{path}").strip()
        head_blob = git("rev-parse", f"{HEAD}:{path}").strip()
        digest = hashlib.sha256(
            git("cat-file", "blob", f"{HEAD}:{path}", binary=True)
        ).hexdigest()
        digests[path] = digest
        if path in diff or base_blob != head_blob:
            changed.append(path)
    return ("PASS" if len(HELD) == 27 and not changed else "FAIL"), {
        "heldPaths": len(HELD),
        "changed": changed,
        "sha256": digests,
    }


def g0_gates():
    diff = git("diff", "--name-only", BASE, HEAD, "--", ".github").split()
    numstat = [
        line.split()
        for line in git("diff", "--numstat", BASE, HEAD, "--", ".github").splitlines()
        if line.strip()
    ]
    deletions = sum(int(cols[1]) for cols in numstat)
    ci_diff = git("diff", "-U0", BASE, HEAD, "--", ".github/workflows/ci.yml")
    added = [
        line[1:]
        for line in ci_diff.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    ]
    removed = [
        line[1:]
        for line in ci_diff.splitlines()
        if line.startswith("-") and not line.startswith("---")
    ]
    allowed_added = {
        "          if [ -d .local/caption-public ]; then",
        "            python3 tools/test/audit-artifacts.py .local/caption-public",
        "          fi",
        "            .local/caption-public/report.json",
        "            .local/caption-public/boundary-proof.json",
        "            .local/caption-public/saved-captions.png",
        "            .local/caption-public/caption-playback.png",
        "            .local/caption-public/caption-export.mp4",
        "            .local/caption-public/repair-report.json",
        "            .local/caption-public/repair-saved.png",
        "            .local/caption-public/repair-playback.png",
        "            .local/caption-public/repair-export.mp4",
        "            .local/caption-public/repair-boundary-export.mp4",
        "            .local/caption-public/boundary-*.png",
        "            .local/caption-public/visual/visual-report.json",
        "            .local/caption-public/visual/*.png",
    }
    security_same = {
        path: git("rev-parse", f"{BASE}:{path}").strip()
        == git("rev-parse", f"{HEAD}:{path}").strip()
        for path in SECURITY
    }

    def timeouts(ref):
        text = ""
        for name in ("ci.yml", "supply-chain.yml", "e2e.yml"):
            text += git("show", f"{ref}:.github/workflows/{name}")
        return sorted(re.findall(r"timeout-minutes:\s*(\d+)", text))

    def asr_deadline(ref):
        text = git(
            "show",
            f"{ref}:workers/ai-worker/src/editagent_ai_worker/infrastructure/asr_preflight.py",
        )
        return text.count("600000")

    planner = (
        git("rev-parse", f"{BASE}:packages/agent-core/src/runtime.ts").strip()
        == git("rev-parse", f"{HEAD}:packages/agent-core/src/runtime.ts").strip()
    )
    gold = [
        path
        for path in git("diff", "--name-only", BASE, HEAD).split()
        if path.startswith("docs/evaluation/")
    ]
    ok = (
        diff == [".github/workflows/ci.yml"]
        and deletions == 0
        and not removed
        and set(added) == allowed_added
        and all(security_same.values())
        and timeouts(BASE) == timeouts(HEAD)
        and asr_deadline(BASE) == asr_deadline(HEAD) >= 1
        and planner
        and not gold
    )
    return ("PASS" if ok else "FAIL"), {
        "workflowFiles": diff,
        "deletions": deletions,
        "added": added,
        "securitySame": security_same,
        "timeoutsEqual": timeouts(BASE) == timeouts(HEAD),
        "asr600000Mentions": [asr_deadline(BASE), asr_deadline(HEAD)],
        "plannerRuntimeUnchanged": planner,
        "evaluationDocsChanged": gold,
    }


def g0_boundaries():
    runtime = git("show", f"{HEAD}:packages/agent-core/src/runtime.ts")
    preflight = git(
        "show",
        f"{HEAD}:workers/ai-worker/src/editagent_ai_worker/infrastructure/asr_preflight.py",
    )
    contract = git("show", f"{HEAD}:docs/contracts/timed-captions.md")
    facts = {
        "plannerNotConfigured": "PLANNER_NOT_CONFIGURED" in runtime,
        "asrDeadline": "deadlineMs" in preflight and "600000" in preflight,
        "cp1": "CP1 remains" in contract and "NOT_VERIFIED" in contract,
        "cp2": "CP2 NOT_MET" in contract,
        "tiny": "Tiny Arabic NOT_QUALIFIED" in contract,
        "us305": "NOT_MET_DEPENDENCY" in contract,
        "noFace": "no face/speaker avoidance is claimed" in contract,
    }
    return ("PASS" if all(facts.values()) else "FAIL"), facts


probe(
    "G0-IDENTITY",
    "Live Draft PR #93 head, tree, base, main, changed-file count, commits, clean product checkout",
    g0_identity,
)
probe(
    "G0-INVENTORY",
    "Changed paths match the live files API; a published blob table must match when present",
    g0_inventory,
)
probe(
    "G0-PATCH",
    "Repair-range binary patch matches the published repair SHA-256; full base..head digest is recorded",
    g0_patch,
)
probe(
    "G0-CI",
    "Exact-head CI, Walking Skeleton, and Supply Chain are green; merge commit parents and tree match",
    g0_ci,
)
probe(
    "G0-SUPPLY-RETRY",
    "Exact-head Supply Chain attempt 1 succeeded and the workflow file is unchanged from base",
    g0_supply_retry,
)
probe(
    "G0-HELD",
    "27 protected files keep identical Git blobs and content SHA-256 from base to head",
    g0_held,
)
probe(
    "G0-GATES",
    "CI edit is the caption artifact allowlist only; scanners, timeouts, ASR deadline, planner, and gold are unchanged",
    g0_gates,
)
probe(
    "G0-BOUNDARIES",
    "Pinned contract still states CP1, CP2, Tiny Arabic, US-305, planner, and no face avoidance",
    g0_boundaries,
)
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(
    json.dumps(
        {
            "productSha": HEAD,
            "productTree": TREE,
            "qaHarnessSha": os.environ.get("GITHUB_SHA"),
            "results": results,
        },
        indent=2,
    )
)
if any(row["status"] != "PASS" for row in results):
    sys.exit(1)
