# US-113 high findings

Trivy `0.75.0`, vulnerability database updated `2026-10-03T14:28:08Z`, scanned on `2026-10-04` with `--skip-db-update --severity HIGH`. Every final release image was rebuilt from the Dockerfiles in this change and scanned with that same database. SeaweedFS was not rebuilt. It was scanned at the approved digest `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`.

An instance is one CVE on one package. A distinct CVE is the identifier, counted once even when several packages carry it. The independent QA count for Object Ingress was 59 instances and 21 distinct CVEs. Those are not interchangeable, and this document does not reuse that total for the rebuilt images.

The critical publish gate is unchanged and still does not fail on high findings. Nothing here is a Trivy exception. The security definition of done stays open while any high finding remains. These eight CVEs still need an explicit human security decision. This review did not accept them.

Staging Postgres is no longer the upstream `gosu` binary built with Go 1.24.6. `infra/postgres/Dockerfile` recompiles that helper with Go 1.25.14 so CVE-2025-68121 is absent from the image Trivy scans. That is a rebuild, not an ignore rule. Redis `7.4-alpine` had no critical findings in this database and is now part of the same critical gate.

## Final inventory

| Image          | High instances | Distinct CVEs |
| -------------- | -------------: | ------------: |
| object-ingress |             43 |             8 |
| api            |             43 |             8 |
| web            |             43 |             8 |
| agent-worker   |             43 |             8 |
| render-worker  |             43 |             8 |
| ai-worker      |             44 |             8 |
| media-worker   |              0 |             0 |
| seaweedfs      |              0 |             0 |

The eight remaining CVEs are the same on every Debian image. The AI worker has one extra ncurses package instance (`libncursesw6`), so its instance count is 44. Across all images that is 259 instances of those 8 CVEs. Media worker includes `ffmpeg` `8.0.1-r1` and its libraries. This database reports no high finding for those Alpine packages.

## Remediated in this change

Object Ingress moved from the QA baseline of 59 instances and 21 CVEs to 54 instances and 18 CVEs after the Debian pin, then to 43 instances and 8 CVEs after the runtime npm removal below. The same pin and removal apply to the other Debian and Node images.

| CVE                                                                              | Package                                 | What changed                                                            | Owner                |
| -------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| CVE-2026-103111                                                                  | `libpcre2-8-0`                          | Pinned `10.46-1~deb13u3` in the trixie runtime stages                   | image Dockerfiles    |
| CVE-2026-75804, CVE-2026-84782                                                   | `libssl3t64`, `openssl-provider-legacy` | Pinned `3.5.7-1~deb13u3`                                                | image Dockerfiles    |
| CVE-2026-102276, CVE-2026-102278, CVE-2026-13149, CVE-2026-14257, CVE-2026-69152 | `brace-expansion`                       | Removed with the unused runtime npm CLI                                 | image Dockerfiles    |
| CVE-2026-33671                                                                   | `picomatch`                             | Same npm removal                                                        | image Dockerfiles    |
| CVE-2026-48815                                                                   | `sigstore`                              | Same npm removal                                                        | image Dockerfiles    |
| CVE-2026-69192                                                                   | `ip-address`                            | Same npm removal                                                        | image Dockerfiles    |
| CVE-2026-9496                                                                    | `pacote`                                | Same npm removal                                                        | image Dockerfiles    |
| CVE-2026-93748                                                                   | `http-cache-semantics`                  | Same npm removal. Trivy had no fixed version                            | image Dockerfiles    |
| CVE-2026-23949                                                                   | `jaraco.context`                        | Removed with unused system `setuptools` in the AI worker                | AI worker Dockerfile |
| CVE-2026-24049                                                                   | `wheel`                                 | Same `setuptools` removal. The package lived under `setuptools/_vendor` | AI worker Dockerfile |

The Node findings were under `/usr/local/lib/node_modules/npm`. The runtime commands are `node`, not `npm`. The Python findings were the base image's `setuptools`, not the AI worker virtualenv. Application lockfiles were not given a blanket ignore.

## No fixed version in this database

These remain in the Debian runtime images. Trivy reports no fixed version. They are not accepted and they are not ignored. A human security decision has to name each CVE before the security definition of done can be closed. This document does not make that decision.

| CVE            | Packages                                                                                                                              | Instances on one Node image | Owner             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------: | ----------------- |
| CVE-2025-69720 | `ncurses-base`, `ncurses-bin`, `libtinfo6`                                                                                            |                           3 | Debian image base |
| CVE-2026-16742 | `libsystemd0`, `libudev1`                                                                                                             |                           2 | Debian image base |
| CVE-2026-54369 | `libacl1`                                                                                                                             |                           1 | Debian image base |
| CVE-2026-76642 | `util-linux` and its libraries (`bsdutils`, `libblkid1`, `liblastlog2-2`, `libmount1`, `libsmartcols1`, `libuuid1`, `login`, `mount`) |                           9 | Debian image base |
| CVE-2026-78408 | same util-linux set                                                                                                                   |                           9 | Debian image base |
| CVE-2026-78409 | same util-linux set                                                                                                                   |                           9 | Debian image base |
| CVE-2026-78410 | same util-linux set                                                                                                                   |                           9 | Debian image base |
| CVE-2026-9538  | `perl-base`                                                                                                                           |                           1 | Debian image base |

The AI worker adds `libncursesw6` to CVE-2025-69720, which is the extra instance.
