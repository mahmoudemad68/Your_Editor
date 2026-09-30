# Risk register

Version 0, opened with US-108. Review it when a spike finishes, when a high risk changes, and at each sprint review. Status stays `Open` until the linked mitigation has actually landed. US-114 does not close these risks.

## Scales

| Probability | Meaning                                             |
| ----------- | --------------------------------------------------- |
| Low         | Unlikely in the 24-week plan if current scope holds |
| Medium      | Plausible on the reference hardware or current plan |
| High        | Expected unless a mitigation changes the conditions |

| Impact | Meaning                                           |
| ------ | ------------------------------------------------- |
| Low    | Local rework inside one story                     |
| Medium | A sprint slips or a quality target is missed      |
| High   | The MVP, a safety boundary, or a checkpoint fails |

Severity from probability and impact:

| Probability \ Impact | Low    | Medium | High     |
| -------------------- | ------ | ------ | -------- |
| Low                  | Low    | Medium | Medium   |
| Medium               | Low    | Medium | High     |
| High                 | Medium | High   | Critical |

High and Critical are high risks for US-108 AC1. Each of them has an owner role and a mitigation linked to backlog work.

## Summary

| ID    | Risk               | Probability | Impact | Severity | Owner                                | Status |
| ----- | ------------------ | ----------- | ------ | -------- | ------------------------------------ | ------ |
| R-001 | GPU access         | Medium      | High   | High     | AI / Agent Engineer                  | Open   |
| R-002 | LLM cost           | High        | High   | Critical | AI / Agent Engineer                  | Open   |
| R-003 | Render performance | Medium      | High   | High     | Generative Video / Remotion Engineer | Open   |
| R-004 | Scope creep        | High        | High   | Critical | Product owner (supervisor)           | Open   |
| R-005 | Sandbox complexity | High        | High   | Critical | DevOps & QA (shared)                 | Open   |
| R-006 | Dataset licensing  | Medium      | High   | High     | AI / Agent Engineer                  | Open   |
| R-007 | Supply chain       | Medium      | High   | High     | DevOps & QA (shared)                 | Open   |
| R-008 | Hostile media      | Medium      | High   | High     | Multimedia Engineer                  | Open   |

## R-001 GPU access

| Field       | Value                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description | Perception (Faster-Whisper, face and scene models) needs a GPU to meet throughput. The reference machine may not expose one, and CPU fallback may miss the checkpoint.                                                            |
| Probability | Medium                                                                                                                                                                                                                            |
| Impact      | High                                                                                                                                                                                                                              |
| Severity    | High                                                                                                                                                                                                                              |
| Owner       | AI / Agent Engineer                                                                                                                                                                                                               |
| Trigger     | US-105 or US-201 cannot reach the agreed throughput on available hardware, or the NVIDIA profile starts without a visible device.                                                                                                 |
| Mitigation  | Measure CPU and GPU in US-105, record the GPU test strategy in US-209, and pool inference in US-604. US-114 only adds an optional Compose profile. It does not provision a GPU and it does not install NVIDIA tooling by default. |
| Backlog     | US-105, US-114, US-209, US-604                                                                                                                                                                                                    |
| Status      | Open                                                                                                                                                                                                                              |

## R-002 LLM cost

| Field       | Value                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description | Hosted tool-calling models can make an agent run, and a retry loop, more expensive than the product can sustain.                                                           |
| Probability | High                                                                                                                                                                       |
| Impact      | High                                                                                                                                                                       |
| Severity    | Critical                                                                                                                                                                   |
| Owner       | AI / Agent Engineer                                                                                                                                                        |
| Trigger     | US-107 estimated cost per run exceeds the budget the team accepts, or a later agent loop issues unbounded calls.                                                           |
| Mitigation  | Record cost per run in US-107, budget tokens in US-304, version prompts in US-302, and enforce creativity limits in US-410. Provider secrets stay in worker configuration. |
| Backlog     | US-107, US-302, US-304, US-410                                                                                                                                             |
| Status      | Open                                                                                                                                                                       |

## R-003 Render performance

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description | A 1080p social render through Remotion or FFmpeg may miss the processing-time target on the reference machine.                                                    |
| Probability | Medium                                                                                                                                                            |
| Impact      | High                                                                                                                                                              |
| Severity    | High                                                                                                                                                              |
| Owner       | Generative Video / Remotion Engineer                                                                                                                              |
| Trigger     | US-106 measures render time per output second above the SRS target, or a later profile cannot hold that rate.                                                     |
| Mitigation  | Compare FFmpeg and Remotion in US-106, keep an FFmpeg strategy in US-218, split preview and final profiles in US-315, then budget and cache in US-606 and US-607. |
| Backlog     | US-106, US-218, US-315, US-606, US-607                                                                                                                            |
| Status      | Open                                                                                                                                                              |

## R-004 Scope creep

| Field       | Value                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description | Graduation scope expands past the MVP boundary (talking-head, podcast, educational footage) and pushes later safety work out of the calendar.               |
| Probability | High                                                                                                                                                        |
| Impact      | High                                                                                                                                                        |
| Severity    | Critical                                                                                                                                                    |
| Owner       | Product owner (supervisor). The Whole team lane enforces the boundary in planning.                                                                          |
| Trigger     | A proposed feature cannot be classified as MVP, advanced, or out of scope, or a sprint accepts work that the SRS marks out of scope.                        |
| Mitigation  | Publish the measurable MVP boundary in US-101 and the working agreements in US-109. New work is classified against that boundary before it enters a sprint. |
| Backlog     | US-101, US-109                                                                                                                                              |
| Status      | Open                                                                                                                                                        |

## R-005 Sandbox complexity

| Field       | Value                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description | Running untrusted generated code without a host shell, host network, or host filesystem is a large runtime, and it is easy to ship a sandbox that only looks isolated.            |
| Probability | High                                                                                                                                                                              |
| Impact      | High                                                                                                                                                                              |
| Severity    | Critical                                                                                                                                                                          |
| Owner       | DevOps & QA (shared)                                                                                                                                                              |
| Trigger     | US-501 escape tests fail, or generated code is executed in the worker itself because the sandbox is late.                                                                         |
| Mitigation  | Resource-limit worker containers in US-422, then the rootless gVisor sandbox in US-501, static checks in US-503, and the red-team in US-603. No sandbox is implemented in US-114. |
| Backlog     | US-422, US-501, US-503, US-603                                                                                                                                                    |
| Status      | Open                                                                                                                                                                              |

## R-006 Dataset licensing

| Field       | Value                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Description | Evaluation footage without a compatible license or written consent cannot be stored, shared, or used to claim a metric.                  |
| Probability | Medium                                                                                                                                   |
| Impact      | High                                                                                                                                     |
| Severity    | High                                                                                                                                     |
| Owner       | AI / Agent Engineer                                                                                                                      |
| Trigger     | A candidate clip has no license record, or a metric is reported on media that is not in the manifest.                                    |
| Mitigation  | Collect a licensed set and a manifest in US-110. Validate license and provenance for acquired assets in US-508. Media stays outside git. |
| Backlog     | US-110, US-508                                                                                                                           |
| Status      | Open                                                                                                                                     |

## R-007 Supply chain

| Field       | Value                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Description | A compromised package, image, or workflow can enter the build before application controls exist.                                               |
| Probability | Medium                                                                                                                                         |
| Impact      | High                                                                                                                                           |
| Severity    | High                                                                                                                                           |
| Owner       | DevOps & QA (shared)                                                                                                                           |
| Trigger     | A critical advisory lands on a direct dependency, or an image is published without a scan and an SBOM.                                         |
| Mitigation  | Secret scanning, dependency and image scanning, SBOMs, and update automation in US-113. Sandbox installs go through a pinned mirror in US-502. |
| Backlog     | US-113, US-502                                                                                                                                 |
| Status      | Open                                                                                                                                           |

## R-008 Hostile media

| Field       | Value                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Description | Uploaded files can crash or pivot a worker through malformed containers, playlist SSRF, or extreme dimensions.                                               |
| Probability | Medium                                                                                                                                                       |
| Impact      | High                                                                                                                                                         |
| Severity    | High                                                                                                                                                         |
| Owner       | Multimedia Engineer                                                                                                                                          |
| Trigger     | A fixture in the hostile suite reaches FFmpeg or a worker without a rejection reason.                                                                        |
| Mitigation  | Allow-list by magic bytes and protocol in US-127, argument-array FFmpeg in US-220, and package or media validation in US-509. US-114 does not inspect media. |
| Backlog     | US-127, US-220, US-509                                                                                                                                       |
| Status      | Open                                                                                                                                                         |
