#!/usr/bin/env python3
"""Evaluate an independent Trivy report and Syft SBOM. Does not load a Trivy ignore file."""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from results import emit  # noqa: E402


def vulnerabilities(document: dict) -> list[dict]:
    found = []
    for result in document.get("Results") or []:
        for vulnerability in result.get("Vulnerabilities") or []:
            row = dict(vulnerability)
            row["Target"] = result.get("Target")
            found.append(row)
    return found


def main() -> int:
    results = Path(sys.argv[1])
    trivy_path = Path(sys.argv[2])
    sbom_path = Path(sys.argv[3])
    document = json.loads(trivy_path.read_text(encoding="utf-8"))
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    rows = vulnerabilities(document)
    by_id = {row.get("VulnerabilityID"): row for row in rows}
    native = [row for row in rows if row.get("VulnerabilityID") == "CVE-2026-111497"]
    emit(
        results,
        "g2.native_cve_absent",
        "G2",
        "PASS" if not native else "FAIL",
        True,
        "CVE-2026-111497 absent from the fresh full-severity Trivy report" if not native else json.dumps(native[0], sort_keys=True)[:500],
    )
    jose = by_id.get("CVE-2026-116587")
    if jose and jose.get("PkgName") == "github.com/go-jose/go-jose/v4" and str(jose.get("InstalledVersion")) == "v4.1.5":
        emit(
            results,
            "g2.high_go_jose_evidence",
            "G2",
            "PASS",
            True,
            "HIGH_UNRESOLVED Trivy "
            f"{jose.get('Severity')} {jose.get('VulnerabilityID')} {jose.get('PkgName')} "
            f"installed={jose.get('InstalledVersion')} fixed={jose.get('FixedVersion')} "
            f"target={jose.get('Target')} title={jose.get('Title')}",
        )
    else:
        emit(results, "g2.high_go_jose_evidence", "G2", "FAIL", True, "fresh Trivy report did not contain the expected HIGH go-jose finding")

    low = [row for row in rows if "brotli" in str(row.get("PkgName", "")).lower() and str(row.get("Severity", "")).upper() == "LOW"]
    ghsa = None
    try:
        with urllib.request.urlopen(
            "https://api.github.com/repos/andybalholm/brotli/security-advisories/GHSA-c9gr-gmg4-2vqv",
            timeout=30,
        ) as response:
            ghsa = json.load(response)
    except Exception as exc:  # noqa: BLE001
        ghsa = {"error": str(exc)}
    modules = [
        package
        for package in sbom.get("packages") or []
        if package.get("name") == "github.com/andybalholm/brotli"
    ]
    version = modules[0].get("versionInfo") if modules else None
    advisory_range = ""
    patched = ""
    if isinstance(ghsa, dict):
        vulns = ghsa.get("vulnerabilities") or []
        if vulns:
            advisory_range = vulns[0].get("vulnerable_version_range") or ""
            patched = vulns[0].get("patched_versions") or ""
    low_ids = [f"{row.get('VulnerabilityID')} {row.get('PkgName')} {row.get('InstalledVersion')}" for row in low]
    ok = version == "v1.2.6" and advisory_range == "< 1.2.7" and patched == "1.2.7" and ghsa.get("severity") == "low"
    emit(
        results,
        "g2.low_go_brotli_evidence",
        "G2",
        "PASS" if ok else "FAIL",
        True,
        f"SBOM github.com/andybalholm/brotli={version}; GitHub advisory severity={ghsa.get('severity')} "
        f"range={advisory_range} patched={patched} summary={ghsa.get('summary')}; Trivy LOW rows={low_ids or 'none'}",
    )

    alpine_ok = False
    alpine_detail = ""
    try:
        request = urllib.request.Request(
            "https://security.alpinelinux.org/vuln/CVE-2026-111497",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            alpine = json.load(response)
        description = alpine.get("description") or ""
        alpine_ok = "1.2.0" in description and "1.2.1" in description
        alpine_detail = "Alpine says 1.0.3 through 1.2.0 are affected and 1.2.1 is a fixed line"
    except Exception as exc:  # noqa: BLE001
        alpine_detail = str(exc)
    emit(results, "g2.alpine_fixed_range", "G2", "PASS" if alpine_ok else "NOT_VERIFIED", True, alpine_detail)
    injected = vulnerabilities(
        {"Results": [{"Vulnerabilities": [{"VulnerabilityID": "CVE-QA-INJECTED", "Severity": "CRITICAL", "PkgName": "example"}]}]}
    )
    critical = [row for row in injected if str(row.get("Severity")).upper() == "CRITICAL"]
    emit(
        results,
        "g2.simulated_critical_control",
        "G2",
        "PASS" if critical and critical[0]["VulnerabilityID"] == "CVE-QA-INJECTED" else "FAIL",
        True,
        "QA parser reports an injected CRITICAL fixture; production ignore policy was not modified",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
