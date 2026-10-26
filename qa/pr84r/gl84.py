"""PR #84 Independent Re-QA, part G: Issue #86 six-fingerprint Gitleaks exception (QA-authored).
Every scan uses --redact; this script records only rule ids, counts and commit:file:rule:line fingerprints.
Secret-shaped data for positive controls is generated at runtime inside disposable repositories; nothing is pushed.
Usage: gl84.py <product checkout with full history> <base sha>"""
import hashlib
import json
import os
import re
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
from pathlib import Path

APP, BASE = Path(sys.argv[1]).resolve(), sys.argv[2]  # absolute: probes run git/gitleaks from other working directories
OUT = Path(os.environ["QA_OUT"])
EXPECTED_SHA = "3eddba83701c1d63d7d7cab7b45eda5b9b8280e15a89904a269e391228265a7f"
QA_COMMITS = {"5a966d47a12d3117febe42621c1f868711a6d432", "05f75891866ac297dd522e29499f519024e3f539"}
results = []
version = subprocess.run(["gitleaks", "version"], capture_output=True, text=True).stdout.strip()


def probe(pid, title, expected, fn):
    try:
        status, actual = fn()
    except Exception as exc:  # noqa: BLE001
        status, actual = "ERROR", f"{type(exc).__name__}: {str(exc)[:300]}"
    results.append({"id": pid, "title": title, "status": status, "expected": expected, "actual": actual, "ms": 0, "mode": "secret-scanner", "scanner": version})
    print(f"[QA84R] {pid} {status} {title}", flush=True)


def git(cwd, *args, check=True):
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True).stdout


def scan(source, cwd, ignore_path=None, log_opts=None):
    """Redacted scan; returns (exit code, [(fingerprint, rule)])."""
    report = Path(tempfile.mkstemp(suffix=".json")[1])
    cmd = ["gitleaks", "detect", "--source", str(source), "--redact", "--config", str(APP / ".gitleaks.toml"), "--report-path", str(report), "--report-format", "json", "--exit-code", "1", "--no-banner"]
    if ignore_path:
        cmd += ["--gitleaks-ignore-path", str(ignore_path)]
    if log_opts:
        cmd += ["--log-opts", log_opts]
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=900)
        data = json.loads(report.read_text() or "[]")
        return r.returncode, sorted((f["Fingerprint"], f["RuleID"]) for f in data)
    finally:
        report.unlink(missing_ok=True)


def rand(n, alphabet=string.ascii_letters + string.digits):
    return "".join(secrets.choice(alphabet) for _ in range(n))


def b64u(raw: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def fresh_jwt():
    return ".".join([b64u(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()), b64u(json.dumps({"sub": rand(12), "iat": 1700000000}).encode()), b64u(secrets.token_bytes(32))])


ignore_bytes = (APP / ".gitleaksignore").read_bytes()
lines = ignore_bytes.decode().splitlines()


def g01():
    pat = re.compile(r"^([0-9a-f]{40}):(qa/pr84/pg84\.spec\.ts|qa/pr84/lib84\.mjs):(jwt|generic-api-key):([0-9]+)$")
    parsed = [pat.match(l) for l in lines]
    same = {}
    for f in [".gitleaks.toml", "infra/scripts/secret-canary.py", "infra/scripts/install-supply-chain-tools.sh"]:
        same[f] = git(APP, "show", f"{BASE}:{f}") == (APP / f).read_text()
    wf_base = [l for l in git(APP, "show", f"{BASE}:.github/workflows/supply-chain.yml").splitlines() if "gitleaks" in l or "fetch-depth" in l or "secret-canary" in l]
    wf_head = [l for l in (APP / ".github/workflows/supply-chain.yml").read_text().splitlines() if "gitleaks" in l or "fetch-depth" in l or "secret-canary" in l]
    pinned = re.findall(r"8\.30\.1", (APP / "infra/scripts/install-supply-chain-tools.sh").read_text())
    other_allow = [p for p in ["**/.gitleaksignore", ".gitleaksignore.d"] if list(APP.glob(p)) and p != "**/.gitleaksignore"]
    nested = [str(p.relative_to(APP)) for p in APP.rglob(".gitleaksignore") if p != APP / ".gitleaksignore" and "node_modules" not in p.parts]
    ok = (hashlib.sha256(ignore_bytes).hexdigest() == EXPECTED_SHA and len(lines) == 6 and all(parsed) and {m.group(1) for m in parsed} == QA_COMMITS
          and len(set(lines)) == 6 and all(same.values()) and wf_base == wf_head and pinned and not nested and not other_allow and ignore_bytes.endswith(b"\n"))
    return ("PASS" if ok else "FAIL"), {"sha256Matches": hashlib.sha256(ignore_bytes).hexdigest() == EXPECTED_SHA, "lines": len(lines), "allExactCommitPathRuleLine": all(parsed),
            "commits": sorted({m.group(1)[:7] for m in parsed if m}), "unchangedFromBase": same, "workflowScanStepsUnchanged": wf_base == wf_head, "pinned8301": bool(pinned), "nestedIgnoreFiles": nested}


history = {}


def g02():
    commits = int(git(APP, "rev-list", "--all", "--count").strip())
    refs = len(git(APP, "for-each-ref", "--format=%(refname)").splitlines())
    qa_refs = [r for r in git(APP, "for-each-ref", "--format=%(refname)").splitlines() if "/qa/" in r]
    code_with, with_ignore = scan(".", APP)
    # Same history WITHOUT the exception file: a no-checkout clone carrying every ref, scanned from an empty directory.
    tmp = Path(tempfile.mkdtemp(prefix="qa84r-noignore-"))
    try:
        git(tmp, "init", "-q")
        git(tmp, "fetch", "-q", "--update-head-ok", str(APP), "+HEAD:refs/qa-scan/head", "+refs/heads/*:refs/heads/*", "+refs/remotes/*:refs/remotes/*", "+refs/tags/*:refs/tags/*")
        empty = Path(tempfile.mkdtemp(prefix="qa84r-empty-"))
        commits_clone = int(git(tmp, "rev-list", "--all", "--count").strip())
        code_without, without = scan(str(tmp), empty, ignore_path=empty)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    without_fps = sorted(fp for fp, _ in without)
    history.update(withIgnore=with_ignore, withoutIgnore=without)
    ok = code_with == 0 and with_ignore == [] and code_without == 1 and without_fps == sorted(lines) and commits_clone == commits
    return ("PASS" if ok else "FAIL"), {"commitsScanned": commits, "refs": refs, "qaRefs": len(qa_refs), "withIgnore": {"exit": code_with, "findings": len(with_ignore)},
                                         "withoutIgnore": {"exit": code_without, "findings": len(without), "rules": sorted({r for _, r in without}), "fingerprintsEqualIgnoreFile": without_fps == sorted(lines)},
                                         "unexpectedFindingsWithoutIgnore": [fp for fp in without_fps if fp not in lines]}


def g03():
    r = subprocess.run([sys.executable, str(APP / "infra/scripts/secret-canary.py")], cwd=APP, capture_output=True, text=True, timeout=300)
    return ("PASS" if r.returncode == 0 else "FAIL"), {"exit": r.returncode, "lastLine": (r.stdout.strip().splitlines() or [""])[-1][:120]}


def g04():
    out = {}
    tmp = Path(tempfile.mkdtemp(prefix="qa84r-controls-"))
    try:
        git(tmp, "init", "-q")
        shutil.copyfile(APP / ".gitleaksignore", tmp / ".gitleaksignore")

        def commit(path, content):
            p = tmp / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            git(tmp, "add", ".")
            git(tmp, "-c", "user.name=QA control", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "disposable control")
            return git(tmp, "rev-parse", "HEAD").strip()

        def last(label):
            code, found = scan(str(tmp), tmp, log_opts="-1 HEAD")
            out[label] = {"exit": code, "rules": sorted({r for _, r in found})}
            return code == 1 and len(found) >= 1

        def at_line(n, text):
            return "\n" * (n - 1) + text + "\n"

        checks = []
        commit("README.md", "control repository\n")
        checks.append(("freshSecretElsewhere", commit("src/app.ts", f'const token = "{fresh_jwt()}";\n') and last("freshSecretElsewhere")))
        checks.append(("freshJwtAtExactQaCoordinates", commit("qa/pr84/pg84.spec.ts", at_line(185, f'    const t = "{fresh_jwt()}";')) and last("freshJwtAtExactQaCoordinates")))
        checks.append(("freshGenericKeyAtExactQaCoordinates", commit("qa/pr84/lib84.mjs", at_line(321, f'  const apiKey = "{rand(40)}";')) and last("freshGenericKeyAtExactQaCoordinates")))
        # Historical synthetic values moved: reproduce the flagged lines from the real history at another path/line in a new commit.
        hist = {}
        for c in sorted(QA_COMMITS):
            for path, ln in (("qa/pr84/pg84.spec.ts", 185), ("qa/pr84/lib84.mjs", 321), ("qa/pr84/lib84.mjs", 326)):
                hist[(c, path, ln)] = git(APP, "show", f"{c}:{path}").splitlines()[ln - 1]
        jwt_line, generic_line = hist[(min(QA_COMMITS), "qa/pr84/pg84.spec.ts", 185)], hist[(min(QA_COMMITS), "qa/pr84/lib84.mjs", 321)]
        checks.append(("historicalValueOtherPath", commit("other/moved.mjs", at_line(185, jwt_line)) and last("historicalValueOtherPath")))
        checks.append(("historicalValueSamePathOtherLine", commit("qa/pr84/pg84.spec.ts", at_line(186, jwt_line)) and last("historicalValueSamePathOtherLine")))
        checks.append(("historicalValueSameCoordinatesNewCommit", commit("qa/pr84/lib84.mjs", at_line(321, generic_line) + "// changed\n") and last("historicalValueSameCoordinatesNewCommit")))
        hist.clear()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    ok = all(v for _, v in checks)
    return ("PASS" if ok else "FAIL"), {"controls": {k: bool(v) for k, v in checks}, "scanDetails": out}


def g05():
    r = subprocess.run([sys.executable, str(APP / "infra/scripts/test-secret-exceptions.py"), "gitleaks"], cwd=APP, capture_output=True, text=True, timeout=600)
    tail = (r.stdout.strip().splitlines() or [""])[-1]
    return ("PASS" if r.returncode == 0 and "SECRET_EXCEPTION_CONTROLS PASS" in r.stdout else "FAIL"), {"exit": r.returncode, "lastLine": tail[:120], "note": "Coding Agent control, supplementary only"}


probe("G01", "Exception inventory: exactly six commit:path:rule:line fingerprints with the authorized hash; scanner config, version pin, canary and workflow scan steps unchanged from base", "sha256 3eddba83…; 6 unique lines in exact form; only the two QA commits; .gitleaks.toml / canary / install script / workflow scan lines identical to base; no nested ignore files", g01)
probe("G02", "Pinned full-history scan across every ref at the product head: 0 findings with the exception; exactly the six fingerprints without it (no new findings from any branch, incl. QA re-QA commits)", "with ignore exit 0 / 0 findings; without ignore exit 1 / findings == the six ignore lines; same commit count", g02)
probe("G03", "Original secret canary still detects", "infra/scripts/secret-canary.py exit 0", g03)
probe("G04", "Independent disposable positive controls: fresh secrets, fresh JWT/generic keys at the exact QA coordinates, and the historical values at moved path/line/commit are all still detected", "every control scan exits 1 with >=1 finding", g04)
probe("G05", "Coding Agent exception-control script (supplementary, not independent evidence)", "SECRET_EXCEPTION_CONTROLS PASS", g05)
path = OUT / "qa84-results.json"
doc = json.loads(path.read_text()) if path.exists() else {"results": []}
doc["results"].extend(results)
doc.setdefault("scanner", version)
path.write_text(json.dumps(doc, indent=2))
print("gitleaks", version)
