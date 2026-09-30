# User journeys

Evaluation scenarios A–G, as named by US-615. Each scenario has one journey, at least one use case, and at least one roadmap epic. Epics are the future work areas US-102 AC1 asks for. This document does not script fixtures or nightly runs; that is US-615.

| Scenario | Name in US-615                 | Scope class                                             | Primary use cases          | Epic                                                                                                                 |
| -------- | ------------------------------ | ------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A        | Podcast to a 45-second Reel    | MVP                                                     | UC-04, UC-06, UC-08, UC-09 | [EP-14](../roadmap/phases/phase-3-agent-mvp-alpha.md), [EP-15](../roadmap/phases/phase-3-agent-mvp-alpha.md)         |
| B        | Educational footage to a Short | MVP                                                     | UC-04, UC-06, UC-08, UC-09 | [EP-09](../roadmap/phases/phase-2-perception-editing-core.md), [EP-14](../roadmap/phases/phase-3-agent-mvp-alpha.md) |
| C        | Custom animation               | Advanced                                                | UC-14, UC-09               | [EP-25](../roadmap/phases/phase-5-advanced-autonomy.md)                                                              |
| D        | Missing component acquisition  | Advanced                                                | UC-13, UC-09               | [EP-26](../roadmap/phases/phase-5-advanced-autonomy.md)                                                              |
| E        | Self-generated capability      | Advanced                                                | UC-14                      | [EP-25](../roadmap/phases/phase-5-advanced-autonomy.md)                                                              |
| F        | Self-detected fix              | Advanced for the iterative loop; the single pass is MVP | UC-10                      | [EP-27](../roadmap/phases/phase-5-advanced-autonomy.md), [EP-22](../roadmap/phases/phase-4-mvp-complete.md)          |
| G        | Natural-language modification  | MVP                                                     | UC-11, UC-07               | [EP-21](../roadmap/phases/phase-4-mvp-complete.md)                                                                   |

Scope classes use the rules in the [SRS](srs.md). A scenario can demonstrate an Advanced capability at graduation without pulling that capability into the MVP.

## A — Podcast to a 45-second Reel

1. The Creator signs in (UC-01) and creates a Project with the Instagram Reels preset and a target of 45 seconds (UC-03).
2. The Creator uploads a podcast recording that is within the MVP input limits (UC-04).
3. EditAgent analyses speech, silence, and loudness (UC-06).
4. The Creator asks for a 45-second Reel. The AI Agent selects highlights, removes dead air, reframes to 1080×1920, captions inside the Reels safe zone, and sets integrated loudness to the preset target (UC-08).
5. The Creator downloads an H.264/AAC MP4 (UC-09). Duration is within 10 percent of 45 seconds. Frame size is 1080×1920.

The footage class is podcast, which is inside the MVP footage list.

## B — Educational footage to a Short

1. The Creator creates a Project with the YouTube Shorts preset (UC-03).
2. The Creator uploads educational footage within the MVP limits (UC-04).
3. Analysis produces a transcript aligned to the spoken lesson (UC-06).
4. The Creator asks for a 45-second YouTube Short. The AI Agent reframes to 1080×1920 and captions inside the Shorts safe zone (UC-08).
5. The Creator downloads the MP4 (UC-09). The rendered duration is 40.5 to 49.5 seconds, which is within 10 percent of 45 seconds and below the Shorts cap of 60 seconds.

The footage class is educational, which is inside the MVP footage list.

## C — Custom animation

1. The Creator asks for a title treatment that is not in the component registry, in the sense of the Sprint 9 demonstration ("a holographic glitch title").
2. The AI Agent generates a Component, compiles it, and test-renders it inside the sandbox (UC-14). It does not install packages on the host.
3. After the test render succeeds, the Component is available to the Timeline and a render can include it (UC-09).

This journey is Advanced. It is not required for milestone M4.

## D — Missing component acquisition

1. The edit needs a Component or stock asset that is not in the local registry.
2. The AI Agent queries an External Asset Provider (UC-13).
3. The download is quarantined. It is not inserted into the Timeline until license and safety checks pass.
4. Only a promoted object may appear in a later render (UC-09).

This is the Scenario D flow named on US-510 and US-507. It is Advanced.

## E — Self-generated capability

1. During UC-08 or UC-11 the AI Agent needs an operation the registry cannot satisfy.
2. Instead of calling a shell or inventing an unregistered Tool, it generates a Component through UC-14 and uses that Component only after the sandbox test render.
3. The new capability is the generated Component, not a host-installed binary.

US-506 (generated FFmpeg filter chains) is stretch and is not this scenario's required path. The committed epic is EP-25.

## F — Self-detected fix

1. A render completes (UC-09).
2. Deterministic checks look for caption overflow, loudness outside the preset tolerance, and black or frozen frames (UC-10).
3. The MVP behavior is one automatic refinement pass (US-421), then a stop.
4. The graduation scenario continues: the critic requests another render until the checks pass or the configured iteration cap is reached (US-513). That continuation is Advanced.

The journey always includes UC-10. The epic for the graduation form is EP-27. The MVP subset is EP-22.

## G — Natural-language modification

1. The Creator already has a Timeline produced by UC-08 or UC-07.
2. The Creator types a change, such as a shorter hook or a different caption phrasing (UC-11).
3. The AI Agent applies EditCommands to that Timeline (UC-07) and stores a new version. Prior versions remain addressable.

This is MVP (US-415, US-417). It is not direct manipulation of the Timeline with a mouse, which is stretch (US-528) and is not this scenario.
