# Security baseline attribution

This repair does not change dependency locks, production code, Dockerfiles or image bases.
The earlier 342-row and later 343-row HIGH baselines are **numerically different**.

| Snapshot                                                        | Supply Chain run                                                                     | Gate time (UTC)     | Container HIGH rows | Unique HIGH CVEs |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------- | ------------------: | ---------------: |
| Accepted PR #35 scan                                            | [37798086065](https://github.com/mahmoudemad68/Your_Editor/actions/runs/37798086065) | 2026-10-08 15:10:00 |                 342 |               23 |
| US-110 base `eb5c7b127a79f2c9a3a78a83d8669521477be71f`          | [37824058427](https://github.com/mahmoudemad68/Your_Editor/actions/runs/37824058427) | 2026-10-08 18:28:04 |                 343 |               24 |
| Previous PR #36 head `e8d0075eb91c6a939049b3d0e9d7a04fe3513531` | [37831254097](https://github.com/mahmoudemad68/Your_Editor/actions/runs/37831254097) | 2026-10-08 19:25:39 |                 343 |               24 |

The exact additional normalized row is:

```text
HIGH web CVE-2026-94483 next 16.3.7 fixed=16.3.8 target=Node.js
```

Next 16.3.7 was already installed in both snapshots. Trivy 0.75.0 fetched the mutable
`mirror.gcr.io/aquasec/trivy-db:2` database at 15:08:10 UTC (119.53 MiB) for the PR #35 web scan,
and at 18:25:40 UTC (120.19 MiB) for the main web scan. The job logs do not expose an immutable
DB digest or its internal UpdatedAt timestamp; these are observed download dates/sizes, not invented
DB identities. The new advisory appears after the database download changed, without an installed
Next version change. This is scanner/advisory database drift, not a US-110-introduced dependency.

Comparison strips log timestamps and revision tags from image target names, then compares full
severity/service/CVE/package/installed-version/fixed-version/target rows. The main and previous
PR #36 finding sets are identical: **PR-attributable new HIGH rows = 0**, new CRITICAL rows = 0.
Do not describe the PR #35 and PR #36 absolute totals as unchanged. A fresh repair-head workflow
may have another database snapshot; compare any resulting changes against installed package
versions and the baseline separately. No unrelated baseline vulnerability is repaired by US-110.
