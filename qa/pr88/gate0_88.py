"""PR #88 Independent QA, part G: Gate 0 provenance/retention (QA-authored). Reads GitHub metadata and Git objects only;
never downloads or opens held artifacts. Usage: gate0_88.py <app checkout with full history> <results.json>"""
import hashlib, json, os, re, subprocess, sys
from pathlib import Path

APP, OUT = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
REPO = os.environ["GITHUB_REPOSITORY"]
HEAD, BASE, TREE = os.environ["QA_APP_SHA"], os.environ["QA_BASE_SHA"], os.environ["QA_APP_TREE"]
CHANGED, COMMITS = int(os.environ["QA_CHANGED_FILES"]), int(os.environ["QA_COMMIT_COUNT"])
# Independently reproduced from `git diff --binary` base..head at this pin (also published on PR #88).
PATCH_SHA = "31e70b82f739c1c498564f2bb0115aba38d30ba5e7ac2633dcf4057c5fe79760"
# Published inventory-JSON digest. The PR states JSON.stringify(object, null, 2) + LF in git-diff order;
# that byte string is checked in G08 and is not assumed to match until it actually does.
INVENTORY_SHA = "b936d1d266d9b330c4a6a2152e3aaa479ce904e5a58ce23c6bef0dbbdc26cf47"
RUNS = {"CI": 40488295876, "Walking skeleton E2E": 40488295758, "Supply chain": 40488295873}
MERGE = "4c7350ff58dd6a6ee5a43174d4e98bc7a2645ea8"
# The 27 held paths (metadata only, from the Owner's local held working tree): must be untouched by PR #88.
HELD = ["docs/evaluation/METRICS.md"] + [f"docs/evaluation/artifacts/commons-{n}-{k}.json" for n, ks in {
    "148215183": ["edit-spec", "render-receipt"], "165959826": ["edit-spec", "render-receipt"], "28956463": ["edit-spec", "render-receipt", "silence-labels", "word-alignment"],
    "7740925": ["edit-spec", "render-receipt"], "82236797": ["edit-spec", "render-receipt", "silence-labels", "word-alignment"], "98650286": ["edit-spec", "render-receipt", "silence-labels", "word-alignment"]}.items() for k in ks] + [
    "packages/schemas/src/job-event-validator.generated.js", "packages/schemas/src/job-event.generated.ts", "packages/schemas/src/media-analysis-v1_1.generated.ts", "packages/schemas/src/media-analysis.generated.ts",
    "tests/architecture/ffmpeg-boundary.test.mjs", "tools/architecture/ffmpeg-boundary.mjs", "workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py", "workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_v1_1_generated.py"]
results = []


def gh(path):
    return json.loads(subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout)


def git(*a, binary=False):
    r = subprocess.run(["git", "-C", str(APP), *a], check=True, capture_output=True)
    return r.stdout if binary else r.stdout.decode()


def probe(pid, title, expected, fn, observed_ok=False):
    try:
        status, actual = fn()
    except Exception as e:  # noqa: BLE001
        status, actual = "ERROR", f"{type(e).__name__}: {str(e)[:300]}"
    results.append({"id": pid, "title": title, "status": status, "expected": expected, "actual": actual, "ms": 0, "mode": "provenance"})
    print(f"[QA88] {pid} {status} {title}", flush=True)


pr = gh(f"repos/{REPO}/pulls/88")
files_api = []
page = 1
while True:
    chunk = gh(f"repos/{REPO}/pulls/88/files?per_page=100&page={page}")
    files_api += [f["filename"] for f in chunk]
    if len(chunk) < 100:
        break
    page += 1
# Complete inventory rows are `| `path` | `hash` | YES/NO |`. The repair table omits the third column.
# Later rows win, so the complete table (a superset) is the binding map.
inventory = dict(re.findall(r"^\| `([^`]+)` \| `([0-9a-f]{64})` \|", pr["body"], re.M))
diff_files = git("diff", "--name-only", BASE, HEAD).split()


def g01():
    main = gh(f"repos/{REPO}/git/ref/heads/main")["object"]["sha"]
    commits = int(git("rev-list", "--count", f"{BASE}..{HEAD}").strip())
    c = {"open": pr["state"] == "open", "draft": pr["draft"] is True, "notMerged": pr["merged"] is False, "head": pr["head"]["sha"] == HEAD, "base": pr["base"]["sha"] == BASE,
         "mainUnchanged": main == BASE, "changedFiles": pr["changed_files"] == CHANGED, "commits": pr["commits"] == COMMITS and commits == COMMITS, "tree": git("rev-parse", f"{HEAD}^{{tree}}").strip() == TREE,
         "ancestry": git("merge-base", BASE, HEAD).strip() == BASE}
    return ("PASS" if all(c.values()) else "FAIL"), c


def g02():
    mism = []
    for p in diff_files:
        blob = git("cat-file", "blob", f"{HEAD}:{p}", binary=True)
        if inventory.get(p) != hashlib.sha256(blob).hexdigest():
            mism.append(p)
    c = {"inventoryRows": len(inventory), "diffFiles": len(diff_files), "apiFiles": len(files_api), "sameSets": set(inventory) == set(diff_files) == set(files_api), "hashMismatches": mism}
    return ("PASS" if c["sameSets"] and len(diff_files) == CHANGED and not mism else "FAIL"), c


def g03():
    got = hashlib.sha256(git("diff", "--binary", BASE, HEAD, binary=True)).hexdigest()
    published = re.search(r"FULL_PR_PATCH_SHA256: `([0-9a-f]{64})`", pr["body"])
    body = published.group(1) if published else None
    return ("PASS" if got == PATCH_SHA and body == PATCH_SHA else "FAIL"), {"gitDiffBinarySha256": got, "prBodyPatchSha256": body, "matchesPin": got == PATCH_SHA}


def g08():
    # PR text: UTF-8, no BOM, JSON.stringify(object, null, 2) plus LF, keys in git diff order.
    ordered = {p: inventory[p] for p in diff_files if p in inventory}
    specified = json.dumps(ordered, indent=2) + "\n"
    specified_sha = hashlib.sha256(specified.encode()).hexdigest()
    return ("PASS" if specified_sha == INVENTORY_SHA else "OBSERVED"), {
        "specifiedSha256": specified_sha, "publishedSha256": INVENTORY_SHA, "matchesPublished": specified_sha == INVENTORY_SHA,
        "note": "Per-file Git blob hashes (G02) and the binary patch digest (G03) are the binding controls. The published inventory-JSON digest is recorded and is not a substitute for those.",
    }


def g04():
    wf = git("diff", "--numstat", BASE, HEAD, "--", ".github").split("\n")
    deletions = sum(int(l.split()[1]) for l in wf if l.strip())
    unchanged = {f: git("rev-parse", f"{BASE}:{f}").strip() == git("rev-parse", f"{HEAD}:{f}").strip() for f in [".gitleaks.toml", ".gitleaksignore", "infra/scripts/install-supply-chain-tools.sh", "infra/scripts/secret-canary.py",
                 "tests/architecture/ffmpeg-boundary.test.mjs", "tools/architecture/ffmpeg-boundary.mjs", "tools/test/audit-artifacts.py"]}
    tm = lambda ref: sorted(re.findall(r"timeout-minutes:\s*(\d+)", git("show", f"{ref}:.github/workflows/ci.yml") + git("show", f"{ref}:.github/workflows/supply-chain.yml") + git("show", f"{ref}:.github/workflows/e2e.yml")))
    scan = lambda ref: [l.strip() for f in ("ci.yml", "supply-chain.yml") for l in git("show", f"{ref}:.github/workflows/{f}").splitlines() if re.search(r"gitleaks|trivy|syft|secret-canary|audit-artifacts|--exit-code|severity", l)]
    removed_scan = [l for l in scan(BASE) if l not in scan(HEAD)]
    asr = lambda ref: len(re.findall(r"600000|600_000", git("grep", "-h", "-E", "600000|600_000", ref, "--", "workers/ai-worker", ".github", "tools/asr", "compose.yaml")))
    ai_changed = [p for p in diff_files if p.startswith("workers/ai-worker") or p.startswith("tools/asr")]
    c = {"workflowDeletions": deletions, "unchangedSecurityFiles": unchanged, "timeoutBudgetsEqual": tm(BASE) == tm(HEAD), "timeouts": tm(HEAD), "removedScannerLines": removed_scan, "asr600sMentions": [asr(BASE), asr(HEAD)], "asrFilesChanged": ai_changed}
    ok = deletions == 0 and all(unchanged.values()) and c["timeoutBudgetsEqual"] and not removed_scan and c["asr600sMentions"][0] == c["asr600sMentions"][1] and not ai_changed
    return ("PASS" if ok else "FAIL"), c


def g05():
    out = {}
    for name, rid in RUNS.items():
        r = gh(f"repos/{REPO}/actions/runs/{rid}")
        out[name] = {"head": r["head_sha"] == HEAD, "conclusion": r["conclusion"], "name": r["name"], "event": r["event"], "attempt": r["run_attempt"]}
    merge = gh(f"repos/{REPO}/commits/{MERGE}")
    parents = [p["sha"] for p in merge["parents"]]
    out["syntheticMerge"] = {"parents": [p[:7] for p in parents], "treeEqualsHeadTree": merge["commit"]["tree"]["sha"] == TREE, "hasHeadParent": HEAD in parents}
    ok = all(v["head"] and v["conclusion"] == "success" for k, v in out.items() if k in RUNS) and out["syntheticMerge"]["treeEqualsHeadTree"] and out["syntheticMerge"]["hasHeadParent"]
    return ("PASS" if ok else "FAIL"), out


def g06():
    touched = [p for p in HELD if p in diff_files]
    changed = [p for p in HELD if git("rev-parse", f"{BASE}:{p}").strip() != git("rev-parse", f"{HEAD}:{p}").strip()]
    return ("PASS" if len(HELD) == 27 and not touched and not changed else "FAIL"), {"heldPaths": len(HELD), "inPrDiff": touched, "blobChangedBaseToHead": changed}


def g07():
    return "NOT_VERIFIED", {"reason": "The pinned approved held-file hash manifest is not published on GitHub; preservation was checked by Git blob identity and absence from the diff (G06) without opening held artifacts.", "heldPaths": len(HELD)}


probe("G01", "Frozen identity: PR #88 open Draft, unmerged, head 9f2333a1 / tree 1dcc7c50, base = current main a789540, 51 files, 9 commits", "all identity facts true", g01)
probe("G02", "Changed-file inventory: base..head diff = PR files API = published table (51 rows); every committed Git-blob SHA-256 matches", "identical sets, 0 hash mismatches", g02)
probe("G03", "Published patch SHA-256 reproduced from git diff --binary base..head", "31e70b82... exactly, including the PR body pin", g03)
probe("G04", "No weakened gate: workflow changes additive only; security/scanner files, architecture rules, job budgets, scanner lines and ASR 600 s deadline unchanged", "0 workflow deletions; listed files identical; timeouts equal; no removed scanner lines; ASR untouched", g04)
probe("G05", "Exact-head CI / Walking Skeleton / Supply Chain runs bind head 9f2333a1; synthetic merge checkout tree equals the head tree", "3 runs head_sha=9f2333a1 conclusion success; merge 4c7350ff has head parent and identical tree", g05)
probe("G06", "Held-file retention: none of the 27 held paths is changed by PR #88", "27 paths; none in the diff; identical Git blobs base->head", g06)
probe("G07", "Held-file hashes compared with the pinned approved manifest", "requires the approved manifest", g07)
probe("G08", "Published inventory-JSON SHA-256 reproduced", "matches if the serialization is reproducible (OBSERVED otherwise)", g08)
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"appSha": HEAD, "results": results}, indent=2))
