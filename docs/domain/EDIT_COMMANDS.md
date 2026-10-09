# Edit commands and replay (US-215)

US-214 is the prerequisite value layer. Commands reuse `Timeline.restore` after every edit;
there is no second set of temporal, source, track or identity rules. Every operation works on
detached snapshots and publishes a complete immutable value only after validation. No API,
database implementation, rendering, filesystem, network or framework is introduced.

`EditCommand` is strict plain JSON data: schemaVersion 1, UUIDv7 command ID, Timeline ID, known
type and explicit payload. Time fields are canonical integer microsecond strings. Consumers
supply identities through the existing UUIDv7 mechanism; split fragments and copied effects
have explicit IDs, so replay does not generate random identities. A malformed discriminator,
version, extra field, property path, ID or time fails closed. `parseCommand` and
`packages/schemas/src/edit-command.schema.json` define the boundary; cross-reference and range
constraints additionally require domain application. JSON Schema contains offline references
to the project schema. There is no executable payload or arbitrary property traversal.

| Command     | Semantics                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TrimClip    | Keep the requested absolute timeline window inside the clip, updating source offsets 1:1. No implicit ripple; the composition duration stays fixed.                                          |
| SplitClip   | Split strictly inside the clip. Left keeps its ID; right and copied effects use payload IDs. Exact timeline/source continuity is preserved; outgoing transitions link to the right fragment. |
| MoveClip    | Set an absolute placement and compatible destination track. Source timing stays unchanged. Invalid overlaps or transition joins reject.                                                      |
| DeleteRange | Delete a positive absolute composition window and ripple **all** tracks left by exactly that duration, preserving synchronization.                                                           |
| InsertClip  | Insert a complete validated canonical Clip snapshot into its existing track.                                                                                                                 |
| SetProperty | Whitelist only clip opacity, volumeDb and caption text; enforce existing bounds and Unicode text rules.                                                                                      |
| AddCaption  | Construct a canonical Caption with explicit ID, caption track, absolute start/end and preserved Unicode text.                                                                                |

Move, Insert and AddCaption extend the composition to fit the new end if necessary; other
operations preserve duration except DeleteRange. Commands do not implicitly frame-snap or
alter source speed. Call the explicit snapping helper when a caller needs frame-grid editing.

The SRS does not define a more detailed ripple policy. This batch adopts a single global ripple
window across all tracks, using the exclusive half-open placement policy from TIMELINE.md.
Clips wholly inside the window disappear; intersecting edges trim; later clips shift. A clip
spanning both boundaries becomes two adjacent clips with a source gap equal to the removed
content. Every such split requires an explicit fragment ID and copied effect IDs. Caption and
graphics intrinsic durations trim/split with the same placements. Transitions at a removed
join or with a deleted endpoint disappear; other joins are remapped to surviving endpoints.
If a retained transition no longer fits its clips, the whole edit rejects. No automatic
transition duration change or source retiming occurs. Deletion touching composition start,
end or the entire composition is supported. Unused fragment identities reject.

Each application returns a reversible `RestoreTimeline` data command containing explicit
validated before/after Timeline snapshots. Undo checks its exact expected post-state and
restores the prior value, including source catalog, effects, transitions, IDs, ordering and
composition duration. These snapshots are serializable values, not mutable object references.
The MVP favors exact reversibility over compact deltas; history storage is correspondingly
larger. RestoreTimeline is an inverse-only type, not an accepted forward edit discriminator.

`CommandBus` is instance-local. Empty undo/redo are no-ops. Successful apply records one ordered
entry; failures leave Timeline, history, cursor and redo unchanged. Undo/redo validate their
preconditions. Applying after undo drops the redo suffix. IDs must be unique across retained
applied history; an ID from an evicted or discarded branch is no longer reserved. A default
100-entry undo limit (explicitly configurable 1–1000) bounds memory. Eviction advances the
baseline to the evicted entry's post-state, preserving replay of the retained log. This is a
bounded undo window, not an unbounded audit archive; durable append-only audit policy belongs
to a later persistence adapter.

`serializeHistory` persists the baseline, complete entries including redo, cursor and limit.
`CommandBus.restoreHistory` replays and validates **all** entries and inverse snapshots before
returning a bus, including entries beyond the active cursor. The exported applied-only
`commandLog()` plus `snapshot()` reproduces the current Timeline. Log and history versions are
explicitly 1. Logs are bounded to 1000 commands. Replay never skips failures: malformed or
impossible commands report a zero-based index and a safe fixed message, without echoing
payloads. Duplicate IDs and mismatched Timeline identities reject. Ordering is the log's
explicit array order; serialization sorts object keys, not semantic arrays.

Focused tests cover all seven commands, atomic rejection, persisted inverses/redo, history
bounds, ripple edge cases, malicious input and schema/domain agreement. Seeded fast-check
properties generate mixed valid edit sequences and assert exact undo-all, replay equality,
redo equality, redo invalidation and failed-command atomicity. Tests need no services or media.
