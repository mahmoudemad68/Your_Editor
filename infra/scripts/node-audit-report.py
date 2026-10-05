"""Print HIGH and CRITICAL pnpm audit findings and fail on critical ones.

The full JSON report is kept by the caller. This script does not drop
advisories and does not read an ignore file.
"""

import json
import sys

SEVERITIES = ("critical", "high", "moderate", "low", "info")


def fail(message):
    raise SystemExit(message)


def advisory_label(advisory):
    name = advisory.get("module_name") or advisory.get("name") or "unknown"
    cves = advisory.get("cves") or []
    identifier = (
        cves[0]
        if cves
        else advisory.get("github_advisory_id") or advisory.get("url") or "advisory"
    )
    title = advisory.get("title") or ""
    return f"{name} {identifier} {title}".strip()


def vulnerability_label(name, item):
    via = item.get("via") or []
    identifier = "advisory"
    title = ""
    for entry in via:
        if isinstance(entry, dict):
            identifier = entry.get("url") or entry.get("name") or identifier
            title = entry.get("title") or title
            break
        if isinstance(entry, str):
            identifier = entry
            break
    return f"{name} {identifier} {title}".strip()


def load_findings(report):
    if not isinstance(report, dict):
        fail("pnpm audit JSON must be an object.")
    findings = []
    advisories = report.get("advisories")
    vulnerabilities = report.get("vulnerabilities")
    if isinstance(advisories, dict) and advisories:
        for advisory in advisories.values():
            if not isinstance(advisory, dict):
                fail("pnpm audit advisory was not an object.")
            severity = str(advisory.get("severity", "")).lower()
            if severity not in SEVERITIES:
                fail(
                    f"pnpm audit advisory has no recognized severity: {severity or 'missing'}"
                )
            findings.append((severity, advisory_label(advisory)))
        return findings
    if isinstance(vulnerabilities, dict) and vulnerabilities:
        for name, item in vulnerabilities.items():
            if not isinstance(item, dict):
                fail("pnpm audit vulnerability was not an object.")
            severity = str(item.get("severity", "")).lower()
            if severity not in SEVERITIES:
                fail(
                    f"pnpm audit vulnerability has no recognized severity: {severity or 'missing'}"
                )
            findings.append((severity, vulnerability_label(name, item)))
        return findings
    metadata = report.get("metadata")
    counts = metadata.get("vulnerabilities") if isinstance(metadata, dict) else None
    if isinstance(counts, dict):
        total = 0
        for severity in SEVERITIES:
            try:
                total += int(counts.get(severity, 0) or 0)
            except (TypeError, ValueError):
                fail(f"pnpm audit metadata count for {severity} is not an integer.")
        if (
            total == 0
            and (advisories == {} or advisories is None)
            and not vulnerabilities
        ):
            return []
        if total > 0:
            fail("pnpm audit JSON reported vulnerabilities without advisory records.")
    if advisories == {} or vulnerabilities == {}:
        return []
    fail("pnpm audit JSON shape was not recognized.")


def main(path):
    try:
        with open(path, encoding="utf-8") as handle:
            report = json.load(handle)
    except json.JSONDecodeError as exc:
        fail(f"Node dependency scan did not return JSON ({exc}).")
    findings = load_findings(report)
    counts = {severity: 0 for severity in SEVERITIES}
    for severity, _label in findings:
        counts[severity] += 1
    print(
        "Node dependency scan: "
        + " ".join(f"{severity}={counts[severity]}" for severity in SEVERITIES)
    )
    for severity in ("critical", "high"):
        matched = [label for found, label in findings if found == severity]
        if not matched:
            continue
        print(f"{severity.upper()} Node vulnerabilities:")
        for label in matched:
            print(f"- {label}")
    if counts["critical"]:
        raise SystemExit(1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: node-audit-report.py <pnpm-audit.json>")
    main(sys.argv[1])
