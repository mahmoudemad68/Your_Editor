#!/usr/bin/env python3
"""Classify a pip-audit JSON report.

pip-audit 2.10 emits an object with a dependencies array. Older examples emit
a top-level array. Vulnerability objects do not include severity, so this
script reads CVSS v3 and v4 vectors from OSV. Critical findings fail the gate.
A finding with no severity, or a severity that cannot be scored, also fails.
High findings are printed and do not fail by themselves.
"""

import json
import math
import os
import sys
import urllib.request

from cvss4 import cvss_v4_score

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
    if vector.startswith("CVSS:4.0/"):
        score = cvss_v4_score(vector)
        return None if score is None else severity_from_score(score)
    stripped = vector.strip()
    if stripped and all(character in "0123456789." for character in stripped):
        try:
            score = float(stripped)
        except ValueError:
            return None
        if 0 <= score <= 10:
            return severity_from_score(score)
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


_RANK = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}


def severity_for(vulnerability, cache):
    identifiers = [vulnerability.get("id", "")]
    identifiers.extend(vulnerability.get("aliases") or [])
    documents = []
    for vuln_id in identifiers:
        if not vuln_id:
            continue
        if vuln_id not in cache:
            cache[vuln_id] = osv_document(vuln_id)
        document = cache[vuln_id]
        if isinstance(document, dict):
            documents.append(document)
    if not documents:
        return "UNKNOWN"
    saw_score = False
    unparseable = False
    best = None
    for document in documents:
        severities = document.get("severity") or []
        if not isinstance(severities, list):
            return "UNPARSEABLE"
        for item in severities:
            if not isinstance(item, dict):
                unparseable = True
                continue
            saw_score = True
            found = severity_from_vector(item.get("score"))
            if found is None:
                unparseable = True
                continue
            if best is None or _RANK[found] > _RANK[best]:
                best = found
    if unparseable:
        return "UNPARSEABLE"
    if not saw_score or best is None:
        return "UNKNOWN"
    return best


def classify(report):
    critical = []
    high = []
    other = []
    unknown = []
    unparseable = []
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
            elif severity == "UNKNOWN":
                unknown.append(label)
            elif severity == "UNPARSEABLE":
                unparseable.append(label)
            elif severity:
                other.append(f"{label} {severity}")
            else:
                unknown.append(label)
    return critical, high, other, unknown, unparseable


def main(path, raw_status, reject_high=False):
    try:
        with open(path, encoding="utf-8") as handle:
            report = json.load(handle)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"Python dependency scan did not return JSON ({exc})."
        ) from exc
    critical, high, other, unknown, unparseable = classify(report)
    if critical:
        print("Critical Python vulnerabilities:")
        for item in critical:
            print(f"- {item}")
    if high:
        print("High Python vulnerabilities:")
        for item in high:
            print(f"- {item}")
    if unparseable:
        print("Unparseable Python vulnerability severities:")
        for item in unparseable:
            print(f"- {item}")
    if unknown:
        print("Python vulnerabilities with no severity:")
        for item in unknown:
            print(f"- {item}")
    if critical or unparseable or unknown or (reject_high and high):
        raise SystemExit(1)
    if raw_status not in (0, 1):
        raise SystemExit(f"pip-audit failed with status {raw_status}.")
    if other:
        print(f"Python dependency scan found {len(other)} other findings.")
        for item in other:
            print(f"- {item}")
    if not high and not other:
        print("Python dependency scan found no vulnerabilities.")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or (
        len(sys.argv) == 4 and sys.argv[3] != "--reject-high"
    ):
        raise SystemExit(
            "usage: python_audit_report.py <report.json> <pip-audit-status> [--reject-high]"
        )
    main(sys.argv[1], int(sys.argv[2]), len(sys.argv) == 4)
