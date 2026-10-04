#!/usr/bin/env python3
"""Classify a pip-audit JSON report and fail only on critical severity.

pip-audit 2.10 emits an object with a dependencies array. Older examples emit
a top-level array. Vulnerability objects do not include severity, so this
script reads CVSS from OSV instead of treating every finding as critical.
"""

import json
import math
import os
import sys
import urllib.request

AV = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}
AC = {"L": 0.77, "H": 0.44}
UI = {"N": 0.85, "R": 0.62}
CIA = {"N": 0.0, "L": 0.22, "H": 0.56}


def load_dependencies(report):
    if isinstance(report, list):
        return report
    if isinstance(report, dict) and isinstance(report.get("dependencies"), list):
        return report["dependencies"]
    raise SystemExit(
        "pip-audit JSON must be a dependency list or an object with dependencies."
    )


def roundup(value):
    return math.ceil(value * 10.0 - 1e-10) / 10.0


def cvss_v3_base(vector):
    metrics = {}
    for part in vector.split("/")[1:]:
        if ":" not in part:
            continue
        key, raw = part.split(":", 1)
        metrics[key] = raw
    required = ("AV", "AC", "PR", "UI", "S", "C", "I", "A")
    if any(key not in metrics for key in required):
        return None
    scope_changed = metrics["S"] == "C"
    if metrics["PR"] == "N":
        privileges = 0.85
    elif metrics["PR"] == "L":
        privileges = 0.68 if scope_changed else 0.62
    elif metrics["PR"] == "H":
        privileges = 0.5 if scope_changed else 0.27
    else:
        return None
    try:
        access = AV[metrics["AV"]]
        complexity = AC[metrics["AC"]]
        interaction = UI[metrics["UI"]]
        confidentiality = CIA[metrics["C"]]
        integrity = CIA[metrics["I"]]
        availability = CIA[metrics["A"]]
    except KeyError:
        return None
    impact_subscore = 1 - (1 - confidentiality) * (1 - integrity) * (1 - availability)
    if scope_changed:
        impact = 7.52 * (impact_subscore - 0.029) - 3.25 * pow(
            impact_subscore - 0.02, 15
        )
    else:
        impact = 6.42 * impact_subscore
    exploitability = 8.22 * access * complexity * privileges * interaction
    if impact <= 0:
        return 0.0
    if scope_changed:
        return roundup(min(1.08 * (impact + exploitability), 10))
    return roundup(min(impact + exploitability, 10))


def severity_from_score(score):
    if score >= 9.0:
        return "CRITICAL"
    if score >= 7.0:
        return "HIGH"
    if score >= 4.0:
        return "MEDIUM"
    if score > 0:
        return "LOW"
    return "NONE"


def severity_from_vector(vector):
    if not isinstance(vector, str):
        return None
    if vector.startswith("CVSS:3."):
        score = cvss_v3_base(vector)
        return None if score is None else severity_from_score(score)
    return None


def osv_document(vuln_id):
    fixture = os.environ.get("PYTHON_AUDIT_OSV_FIXTURE")
    if fixture:
        path = os.path.join(fixture, f"{vuln_id}.json")
        if not os.path.isfile(path):
            return None
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    request = urllib.request.Request(
        f"https://api.osv.dev/v1/vulns/{urllib.request.quote(vuln_id)}",
        headers={"User-Agent": "editagent-python-audit"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except Exception as exc:
        raise SystemExit(f"could not read OSV severity for {vuln_id}: {exc}") from exc


def severity_for(vulnerability, cache):
    identifiers = [vulnerability.get("id", "")]
    identifiers.extend(vulnerability.get("aliases") or [])
    for vuln_id in identifiers:
        if not vuln_id:
            continue
        if vuln_id not in cache:
            cache[vuln_id] = osv_document(vuln_id)
        document = cache[vuln_id]
        if not isinstance(document, dict):
            continue
        for item in document.get("severity") or []:
            if not isinstance(item, dict):
                continue
            found = severity_from_vector(item.get("score"))
            if found:
                return found
    return None


def classify(report):
    critical = []
    high = []
    other = []
    unknown = []
    cache = {}
    for dependency in load_dependencies(report):
        name = dependency.get("name", "unknown")
        version = dependency.get("version", "unknown")
        for vulnerability in dependency.get("vulns") or []:
            label = f"{name}=={version} {vulnerability.get('id', 'unknown')}"
            severity = severity_for(vulnerability, cache)
            if severity == "CRITICAL":
                critical.append(label)
            elif severity == "HIGH":
                high.append(label)
            elif severity:
                other.append(f"{label} {severity}")
            else:
                unknown.append(label)
    return critical, high, other, unknown


def main(path, raw_status):
    try:
        with open(path, encoding="utf-8") as handle:
            report = json.load(handle)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"Python dependency scan did not return JSON ({exc})."
        ) from exc
    critical, high, other, unknown = classify(report)
    if critical:
        print("Critical Python vulnerabilities:")
        for item in critical:
            print(f"- {item}")
    if high:
        print("High Python vulnerabilities:")
        for item in high:
            print(f"- {item}")
    if critical:
        raise SystemExit(1)
    if raw_status not in (0, 1):
        raise SystemExit(f"pip-audit failed with status {raw_status}.")
    if other:
        print(f"Python dependency scan found {len(other)} other findings.")
        for item in other:
            print(f"- {item}")
    if unknown:
        print(
            f"Python dependency scan found {len(unknown)} findings with no CVSS vector."
        )
        for item in unknown:
            print(f"- {item}")
    if not critical and not high and not other and not unknown:
        print("Python dependency scan found no vulnerabilities.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: python_audit_report.py <report.json> <pip-audit-status>"
        )
    main(sys.argv[1], int(sys.argv[2]))
