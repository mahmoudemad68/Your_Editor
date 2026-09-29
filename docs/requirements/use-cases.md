# Use cases

Catalogue for US-102. Diagram source: [docs/architecture/use-case-diagram.md](../architecture/use-case-diagram.md).

Functional requirements in the [SRS](srs.md) trace to the identifiers below. Journeys for evaluation scenarios A–G are in [user-journeys.md](user-journeys.md).

## Actors

| Actor                    | Kind            | Who it is                                                                                                                                                                        |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creator                  | Primary person  | A person with the Owner or Editor role who uploads footage and asks for an edit.                                                                                                 |
| Viewer                   | Primary person  | A person with the Viewer role. Included so the role in the SRS has a use case. The required diagram actors are still Creator, Admin, the AI Agent, and External Asset Providers. |
| Admin                    | Primary person  | The operator role. Administers accounts and the deployment. Does not own Project content by default.                                                                             |
| AI Agent                 | Secondary       | The observe-plan-act loop inside EditAgent (ADR-006). It is not a user account and cannot call a shell.                                                                          |
| External Asset Providers | External system | Stock, music, and package sources outside the application trust zone. Downloads are untrusted until quarantine (ADR-001).                                                        |

## UC-01 Sign in

A Creator, Viewer, or Admin registers or signs in and receives a session. Passwords are stored only as argon2id hashes. Tokens expire.

**Modules:** Identity. **Scope:** MVP.

## UC-02 Manage membership and roles

An Owner, or an Admin where policy allows, grants Owner, Editor, or Viewer on a Project. A principal who is not a member receives HTTP 404 for that Project and its media, without a body that reveals whether the identifier exists.

**Modules:** Identity, Projects. **Scope:** MVP.

## UC-03 Create and configure a Project

A Creator creates a Project, sets a platform preset and an optional target duration, and later archives it. The preset is one of the named presets in the SRS or another preset added only as configuration.

**Modules:** Projects. **Scope:** MVP.

## UC-04 Upload and validate a MediaAsset

A Creator uploads bytes with a time-limited presigned URL. The API does not proxy the body. EditAgent accepts the object only when the container, codecs, duration, and size satisfy the SRS media rules. Hostile names and malformed containers are rejected. Accepted media is stored under a server-generated key.

**Modules:** Media, Jobs. **Scope:** MVP.

## UC-05 Inspect media and play a proxy

A Creator or Viewer opens a MediaAsset, sees technical metadata, and plays a proxy. The Viewer cannot start an upload, an edit, or an AgentRun.

**Modules:** Media. **Scope:** MVP.

## UC-06 Analyse a MediaAsset

The system, when asked by a Creator or by the AI Agent, produces a versioned MediaAnalysis: transcript, speech segments, silence and loudness, and, when those analyzers have run, shots and faces. A repeated request for the same fingerprint and analyzer version returns the stored result.

**Modules:** Analysis, Jobs. **Scope:** MVP.

## UC-07 Edit the Timeline

A Creator, or a Tool invoked for the Creator, changes a Timeline by EditCommands. Commands undo, redo, and replay. Positions are integer microseconds. One-click silence removal is this use case with silence ranges supplied by Analysis.

**Modules:** Editing, Tools. **Scope:** MVP.

## UC-08 Produce a short-form edit

A Creator names a preset and a prompt, for example a 45-second Reel. The AI Agent plans schema-valid tool calls, cleans the Timeline, reframes, captions inside the safe zone, and balances loudness. The agent has no shell permission.

**Modules:** Agent, Tools, Editing, Components. **Scope:** MVP.

## UC-09 Render and download

A Creator or Viewer downloads a preview or final render. The MVP final file is H.264/AAC MP4 at or below 1080p, matching the active preset. Progress is visible as a Job.

**Modules:** Rendering, Jobs. **Scope:** MVP.

## UC-10 Review and refine

Deterministic checks score a render. The MVP performs one automatic refinement pass when caption overflow, loudness, or black frames fail. The Advanced form repeats critique and render until the checks pass or the iteration cap is reached.

**Modules:** Critic, Agent, Rendering. **Scope:** one pass is MVP (US-419, US-421). The iterative loop is Advanced (US-513).

## UC-11 Revise in natural language

A Creator asks to change an existing edit. The AI Agent applies EditCommands to the current Timeline and stores a new version. It does not rebuild the Project from an empty Timeline unless the instruction says to.

**Modules:** Agent, Editing. **Scope:** MVP (US-415).

## UC-12 Insert a local asset

The AI Agent, or a Creator, searches the local asset registry and places B-roll, music, or a font on the Timeline. Placement is an EditCommand. The asset bytes stay in object storage.

**Modules:** Assets, Editing. **Scope:** MVP for the local registry (US-411 to US-414).

## UC-13 Acquire an external resource

The AI Agent searches an External Asset Provider, downloads into quarantine, and does not place the bytes on a Timeline until validation passes. The same shape applies to a missing Component package.

**Modules:** Assets, Components, Agent. **Scope:** Advanced (US-507, US-510).

## UC-14 Generate a Component

The AI Agent generates a Component that is not in the registry, compiles it, and test-renders it inside the sandbox before the Timeline may use it. Generated code does not run on the host.

**Modules:** Components, Agent. **Scope:** Advanced (US-501, US-503).

## UC-15 Administer the deployment

An Admin inspects health, users, and operational status. Admin does not receive Project media by holding the Admin role alone.

**Modules:** Identity, Jobs. **Scope:** MVP for account administration required by the role. Deployment automation itself is US-114 and remains a platform story, not a Creator feature.

## UC-16 Apply a BrandKit

A Creator saves a BrandKit on a Project. The AI Agent applies its colors, fonts, and logo references during a later edit. Saving the record and applying it are Advanced.

**Modules:** Projects, Agent. **Scope:** Advanced (US-521). The name BrandKit is still a canonical glossary term.
