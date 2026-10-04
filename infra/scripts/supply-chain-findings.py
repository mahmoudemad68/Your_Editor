"""Print HIGH and CRITICAL Trivy findings from retained JSON reports.

This command does not decide the gate. A missing report is printed and
returns success so the security gate can reject the missing scan itself.
"""

import json
import sys
from pathlib import Path


def vulnerabilities(document):
    if not isinstance(document, dict):
        return []
    found = []
    for result in document.get("Results") or []:
        if not isinstance(result, dict):
            continue
        target = result.get("Target") or result.get("Class") or "image"
        for vulnerability in result.get("Vulnerabilities") or []:
            if not isinstance(vulnerability, dict):
                continue
            severity = str(vulnerability.get("Severity", "")).upper()
            if severity not in {"HIGH", "CRITICAL"}:
                continue
            found.append(
                (
                    severity,
                    vulnerability.get("VulnerabilityID", "unknown"),
                    vulnerability.get("PkgName", "unknown"),
                    vulnerability.get("InstalledVersion", "unknown"),
                    vulnerability.get("FixedVersion") or "none",
                    target,
                )
            )
    return found


def main(directory):
    root = Path(directory)
    reports = sorted(root.glob("trivy-*.json"))
    if not reports:
        print("No Trivy JSON reports were downloaded.")
        return
    critical = 0
    high = 0
    for report in reports:
        service = report.name.removeprefix("trivy-").removesuffix(".json")
        try:
            document = json.loads(report.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"{service}: Trivy report is not JSON ({exc}).")
            continue
        rows = vulnerabilities(document)
        print(
            f"{service}: {sum(1 for row in rows if row[0] == 'CRITICAL')} critical, {sum(1 for row in rows if row[0] == 'HIGH')} high"
        )
        for severity, vuln_id, package, installed, fixed, target in rows:
            if severity == "CRITICAL":
                critical += 1
            else:
                high += 1
            print(
                f"- {severity} {service} {vuln_id} {package} {installed} fixed={fixed} target={target}"
            )
    print(f"Trivy totals: critical={critical} high={high}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: supply-chain-findings.py <report-directory>")
    main(sys.argv[1])
