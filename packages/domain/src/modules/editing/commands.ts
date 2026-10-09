import { DomainError } from "../../kernel/error.js";
import { uuidV7 } from "../../kernel/id.js";
import { microseconds } from "../../kernel/time.js";
import { Caption, Clip, Timeline, type ClipSnapshot, type TimelineSnapshot } from "./timeline.js";
import { object, list, text, numeric, unique } from "./validation.js";

interface Base {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly timelineId: string;
}
export interface FragmentIds {
  clipId: string;
  rightClipId: string;
  rightEffectIds: string[];
}
export type EditCommand = Base &
  (
    | {
        readonly type: "TrimClip";
        readonly payload: { clipId: string; startUs: string; endUs: string };
      }
    | {
        readonly type: "SplitClip";
        readonly payload: {
          clipId: string;
          atUs: string;
          rightClipId: string;
          rightEffectIds: string[];
        };
      }
    | {
        readonly type: "MoveClip";
        readonly payload: { clipId: string; trackId: string; startUs: string };
      }
    | {
        readonly type: "DeleteRange";
        readonly payload: { startUs: string; endUs: string; fragments: FragmentIds[] };
      }
    | { readonly type: "InsertClip"; readonly payload: { clip: ClipSnapshot } }
    | {
        readonly type: "SetProperty";
        readonly payload: {
          clipId: string;
          key: "opacity" | "volumeDb" | "text";
          value: number | string;
        };
      }
    | {
        readonly type: "AddCaption";
        readonly payload: {
          captionId: string;
          trackId: string;
          startUs: string;
          endUs: string;
          text: string;
        };
      }
  );
export interface InverseCommand {
  schemaVersion: 1;
  type: "RestoreTimeline";
  expected: TimelineSnapshot;
  restore: TimelineSnapshot;
}
export interface AppliedEdit {
  readonly timeline: Timeline;
  readonly inverse: InverseCommand;
  readonly command: EditCommand;
}
export interface CommandLog {
  schemaVersion: 1;
  timelineId: string;
  commands: EditCommand[];
}
export interface HistoryEntry {
  command: EditCommand;
  inverse: InverseCommand;
}
export interface CommandHistory {
  schemaVersion: 1;
  snapshot: TimelineSnapshot;
  entries: HistoryEntry[];
  cursor: number;
  maxEntries: number;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}
export function serializeCommand(value: EditCommand): string {
  return JSON.stringify(canonical(parseCommand(value)));
}
const id = (value: unknown) => uuidV7(text(value));
const time = (value: unknown) => String(microseconds(text(value)));
function range(start: string, end: string): void {
  if (BigInt(end) <= BigInt(start)) throw new DomainError("Command range must be positive.");
}
const ids = (value: unknown) => list(value).map(id);
export function parseCommand(value: unknown): EditCommand {
  const d = object(typeof value === "string" ? JSON.parse(value) : value, [
    "schemaVersion",
    "id",
    "timelineId",
    "type",
    "payload",
  ]);
  if (d.schemaVersion !== 1) throw new DomainError("Unsupported command schema version.");
  const base = { schemaVersion: 1 as const, id: id(d.id), timelineId: id(d.timelineId) };
  let command: EditCommand;
  switch (d.type) {
    case "TrimClip": {
      const p = object(d.payload, ["clipId", "startUs", "endUs"]);
      const startUs = time(p.startUs),
        endUs = time(p.endUs);
      range(startUs, endUs);
      command = { ...base, type: d.type, payload: { clipId: id(p.clipId), startUs, endUs } };
      break;
    }
    case "SplitClip": {
      const p = object(d.payload, ["clipId", "atUs", "rightClipId", "rightEffectIds"]);
      command = {
        ...base,
        type: d.type,
        payload: {
          clipId: id(p.clipId),
          atUs: time(p.atUs),
          rightClipId: id(p.rightClipId),
          rightEffectIds: ids(p.rightEffectIds),
        },
      };
      break;
    }
    case "MoveClip": {
      const p = object(d.payload, ["clipId", "trackId", "startUs"]);
      command = {
        ...base,
        type: d.type,
        payload: { clipId: id(p.clipId), trackId: id(p.trackId), startUs: time(p.startUs) },
      };
      break;
    }
    case "DeleteRange": {
      const p = object(d.payload, ["startUs", "endUs", "fragments"]);
      const startUs = time(p.startUs),
        endUs = time(p.endUs);
      range(startUs, endUs);
      const fragments = list(p.fragments).map((item) => {
        const f = object(item, ["clipId", "rightClipId", "rightEffectIds"]);
        return {
          clipId: id(f.clipId),
          rightClipId: id(f.rightClipId),
          rightEffectIds: ids(f.rightEffectIds),
        };
      });
      unique(fragments.map((f) => f.clipId));
      command = { ...base, type: d.type, payload: { startUs, endUs, fragments } };
      break;
    }
    case "InsertClip": {
      const p = object(d.payload, ["clip"]);
      command = { ...base, type: d.type, payload: { clip: Clip.restore(p.clip).toSnapshot() } };
      break;
    }
    case "SetProperty": {
      const p = object(d.payload, ["clipId", "key", "value"]);
      if (!["opacity", "volumeDb", "text"].includes(p.key as string))
        throw new DomainError("Unsupported property key.");
      const key = p.key as "opacity" | "volumeDb" | "text",
        value =
          key === "text"
            ? text(p.value)
            : numeric(p.value, key === "opacity" ? 0 : -60, key === "opacity" ? 1 : 12);
      command = { ...base, type: d.type, payload: { clipId: id(p.clipId), key, value } };
      break;
    }
    case "AddCaption": {
      const p = object(d.payload, ["captionId", "trackId", "startUs", "endUs", "text"]);
      const startUs = time(p.startUs),
        endUs = time(p.endUs);
      range(startUs, endUs);
      command = {
        ...base,
        type: d.type,
        payload: {
          captionId: id(p.captionId),
          trackId: id(p.trackId),
          startUs,
          endUs,
          text: text(p.text),
        },
      };
      break;
    }
    default:
      throw new DomainError("Unknown edit command type.");
  }
  return freeze(command);
}
type Payload<K extends EditCommand["type"]> = Extract<EditCommand, { type: K }>["payload"];
function make<K extends EditCommand["type"]>(
  type: K,
  commandId: string,
  timelineId: string,
  payload: Payload<K>,
): EditCommand {
  return parseCommand({ schemaVersion: 1, id: commandId, timelineId, type, payload });
}
export const TrimClip = (id: string, timeline: string, payload: Payload<"TrimClip">) =>
  make("TrimClip", id, timeline, payload);
export const SplitClip = (id: string, timeline: string, payload: Payload<"SplitClip">) =>
  make("SplitClip", id, timeline, payload);
export const MoveClip = (id: string, timeline: string, payload: Payload<"MoveClip">) =>
  make("MoveClip", id, timeline, payload);
export const DeleteRange = (id: string, timeline: string, payload: Payload<"DeleteRange">) =>
  make("DeleteRange", id, timeline, payload);
export const InsertClip = (id: string, timeline: string, payload: Payload<"InsertClip">) =>
  make("InsertClip", id, timeline, payload);
export const SetProperty = (id: string, timeline: string, payload: Payload<"SetProperty">) =>
  make("SetProperty", id, timeline, payload);
export const AddCaption = (id: string, timeline: string, payload: Payload<"AddCaption">) =>
  make("AddCaption", id, timeline, payload);

function locate(snapshot: TimelineSnapshot, clipId: string) {
  for (const track of snapshot.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, index, clip: track.clips[index]! };
  }
  throw new DomainError("Command refers to a missing clip.");
}
function end(clip: ClipSnapshot): bigint {
  return BigInt(clip.timelineStartUs) + BigInt(clip.outPoint) - BigInt(clip.inPoint);
}
function crop(
  clip: ClipSnapshot,
  start: bigint,
  stop: bigint,
  newId = clip.id,
  effectIds = clip.effects.map((e) => e.id),
): ClipSnapshot {
  const oldStart = BigInt(clip.timelineStartUs),
    intrinsic = clip.kind === "caption" || clip.kind === "graphics";
  if (start < oldStart || stop > end(clip) || start >= stop)
    throw new DomainError("Trim/split range exceeds clip.");
  if (effectIds.length !== clip.effects.length)
    throw new DomainError("Every copied effect needs an explicit ID.");
  return {
    ...clip,
    id: newId,
    timelineStartUs: String(start),
    inPoint: intrinsic ? "0" : String(BigInt(clip.inPoint) + start - oldStart),
    outPoint: intrinsic ? String(stop - start) : String(BigInt(clip.inPoint) + stop - oldStart),
    effects: clip.effects.map((effect, i) => ({ ...effect, id: effectIds[i]!, clipId: newId })),
  };
}
function extend(snapshot: TimelineSnapshot, clip: ClipSnapshot): void {
  if (end(clip) > BigInt(snapshot.composition.durationUs))
    snapshot.composition.durationUs = String(end(clip));
}
export function applyCommand(timeline: Timeline, value: unknown): AppliedEdit {
  const command = parseCommand(value);
  if (command.timelineId !== timeline.id)
    throw new DomainError("Command timeline identity differs.");
  const before = timeline.toSnapshot(),
    s = timeline.toSnapshot();
  switch (command.type) {
    case "TrimClip": {
      const p = command.payload,
        { track, index, clip } = locate(s, p.clipId);
      track.clips[index] = crop(clip, BigInt(p.startUs), BigInt(p.endUs));
      break;
    }
    case "SplitClip": {
      const p = command.payload,
        { track, index, clip } = locate(s, p.clipId),
        at = BigInt(p.atUs);
      const left = crop(clip, BigInt(clip.timelineStartUs), at),
        right = crop(clip, at, end(clip), p.rightClipId, p.rightEffectIds);
      track.clips.splice(index, 1, left, right);
      track.transitions = track.transitions.map((t) => ({
        ...t,
        fromClipId: t.fromClipId === clip.id ? right.id : t.fromClipId,
      }));
      break;
    }
    case "MoveClip": {
      const p = command.payload,
        { track, index, clip } = locate(s, p.clipId),
        target = s.tracks.find((t) => t.id === p.trackId);
      if (!target) throw new DomainError("Command refers to a missing track.");
      const moved = { ...clip, trackId: target.id, timelineStartUs: p.startUs };
      track.clips.splice(index, 1);
      target.clips.push(moved);
      extend(s, moved);
      break;
    }
    case "InsertClip": {
      const clip = command.payload.clip,
        target = s.tracks.find((t) => t.id === clip.trackId);
      if (!target) throw new DomainError("Command refers to a missing track.");
      target.clips.push(clip);
      extend(s, clip);
      break;
    }
    case "SetProperty": {
      const p = command.payload,
        { track, index, clip } = locate(s, p.clipId);
      if (p.key === "text" && clip.kind !== "caption")
        throw new DomainError("Text edits require a caption.");
      track.clips[index] = { ...clip, [p.key]: p.value };
      break;
    }
    case "AddCaption": {
      const p = command.payload,
        target = s.tracks.find((t) => t.id === p.trackId);
      if (!target) throw new DomainError("Command refers to a missing track.");
      const caption = new Caption(p.captionId, p.trackId, p.startUs, p.endUs, p.text).toSnapshot();
      target.clips.push(caption);
      extend(s, caption);
      break;
    }
    case "DeleteRange": {
      const p = command.payload,
        a = BigInt(p.startUs),
        b = BigInt(p.endUs),
        width = b - a,
        used = new Set<string>();
      if (b > BigInt(s.composition.durationUs))
        throw new DomainError("Delete range exceeds composition.");
      for (const track of s.tracks) {
        const original = track.clips,
          first = new Map<string, string>(),
          last = new Map<string, string>();
        track.clips = [];
        for (const clip of original) {
          const start = BigInt(clip.timelineStartUs),
            stop = end(clip);
          let pieces: ClipSnapshot[] = [];
          if (stop <= a) pieces = [clip];
          else if (start >= b) pieces = [{ ...clip, timelineStartUs: String(start - width) }];
          else if (start < a && stop > b) {
            const fragment = p.fragments.find((f) => f.clipId === clip.id);
            if (!fragment)
              throw new DomainError("Ripple split needs explicit fragment/effect IDs.");
            used.add(clip.id);
            const left = crop(clip, start, a),
              right = crop(clip, b, stop, fragment.rightClipId, fragment.rightEffectIds);
            right.timelineStartUs = String(a);
            pieces = [left, right];
          } else if (start < a) pieces = [crop(clip, start, a)];
          else if (stop > b) {
            const right = crop(clip, b, stop);
            right.timelineStartUs = String(a);
            pieces = [right];
          }
          if (pieces.length) {
            first.set(clip.id, pieces[0]!.id);
            last.set(clip.id, pieces[pieces.length - 1]!.id);
            track.clips.push(...pieces);
          }
        }
        track.transitions = track.transitions.flatMap((t) => {
          const from = original.find((c) => c.id === t.fromClipId)!,
            join = end(from);
          if ((join >= a && join <= b) || !last.has(t.fromClipId) || !first.has(t.toClipId))
            return [];
          return [{ ...t, fromClipId: last.get(t.fromClipId)!, toClipId: first.get(t.toClipId)! }];
        });
      }
      if (used.size !== p.fragments.length)
        throw new DomainError("Unused ripple fragment identities.");
      s.composition.durationUs = String(BigInt(s.composition.durationUs) - width);
      break;
    }
  }
  // Construct everything before returning or updating a bus: failures cannot publish partial state.
  const result = Timeline.restore(s);
  return Object.freeze({
    timeline: result,
    command,
    inverse: freeze({
      schemaVersion: 1 as const,
      type: "RestoreTimeline" as const,
      expected: result.toSnapshot(),
      restore: before,
    }),
  });
}
export function applyInverse(timeline: Timeline, value: unknown): Timeline {
  const d = object(value, ["schemaVersion", "type", "expected", "restore"]);
  if (d.schemaVersion !== 1 || d.type !== "RestoreTimeline")
    throw new DomainError("Unsupported inverse command.");
  const expected = Timeline.restore(d.expected),
    restore = Timeline.restore(d.restore);
  if (
    restore.id !== timeline.id ||
    restore.projectId !== timeline.projectId ||
    JSON.stringify(expected.toSnapshot()) !== JSON.stringify(timeline.toSnapshot())
  )
    throw new DomainError("Inverse state precondition differs.");
  return restore;
}
export function parseCommandLog(value: unknown): CommandLog {
  const d = object(typeof value === "string" ? JSON.parse(value) : value, [
    "schemaVersion",
    "timelineId",
    "commands",
  ]);
  if (d.schemaVersion !== 1) throw new DomainError("Unsupported log schema version.");
  const commands = list(d.commands);
  if (commands.length > 1000) throw new DomainError("Command log exceeds its explicit bound.");
  const parsed = commands.map((command, index) => {
    try {
      return parseCommand(command);
    } catch {
      throw new DomainError(`Replay failed at command index ${index}: malformed command.`);
    }
  });
  const timelineId = id(d.timelineId),
    seen = new Set<string>();
  parsed.forEach((command, index) => {
    if (seen.has(command.id) || command.timelineId !== timelineId)
      throw new DomainError(`Replay failed at command index ${index}: command identity differs.`);
    seen.add(command.id);
  });
  return freeze({ schemaVersion: 1, timelineId, commands: parsed });
}
export function replay(snapshot: Timeline | TimelineSnapshot, log: unknown): Timeline {
  let current = snapshot instanceof Timeline ? snapshot : Timeline.restore(snapshot);
  const data = parseCommandLog(log);
  if (data.timelineId !== current.id) throw new DomainError("Log snapshot identity differs.");
  for (let index = 0; index < data.commands.length; index++) {
    try {
      current = applyCommand(current, data.commands[index]).timeline;
    } catch {
      throw new DomainError(`Replay failed at command index ${index}: invalid edit.`);
    }
  }
  return current;
}
export class CommandBus {
  private current: Timeline;
  private baseline: TimelineSnapshot;
  private entries: readonly HistoryEntry[] = [];
  private cursor = 0;
  readonly maxEntries: number;
  constructor(snapshot: Timeline, maxEntries = 100) {
    this.current = Timeline.restore(snapshot.toSnapshot());
    this.baseline = this.current.toSnapshot();
    this.maxEntries = numeric(maxEntries, 1, 1000, true);
  }
  get timeline(): Timeline {
    return this.current;
  }
  get history(): readonly HistoryEntry[] {
    return Object.freeze(this.entries.slice(0, this.cursor));
  }
  get canUndo(): boolean {
    return this.cursor > 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }
  apply(value: unknown): Timeline {
    const applied = applyCommand(this.current, value);
    const next = this.entries.slice(0, this.cursor);
    if (next.some((e) => e.command.id === applied.command.id))
      throw new DomainError("Duplicate command ID.");
    next.push(freeze({ command: applied.command, inverse: applied.inverse }));
    let baseline = this.baseline;
    if (next.length > this.maxEntries) baseline = next.shift()!.inverse.expected;
    this.entries = Object.freeze(next);
    this.baseline = baseline;
    this.cursor = next.length;
    this.current = applied.timeline;
    return this.current;
  }
  undo(): Timeline {
    if (!this.canUndo) return this.current;
    const restored = applyInverse(this.current, this.entries[this.cursor - 1]!.inverse);
    this.current = restored;
    this.cursor--;
    return restored;
  }
  redo(): Timeline {
    if (!this.canRedo) return this.current;
    const entry = this.entries[this.cursor]!,
      applied = applyCommand(this.current, entry.command);
    if (JSON.stringify(applied.inverse) !== JSON.stringify(entry.inverse))
      throw new DomainError("Redo history differs.");
    this.current = applied.timeline;
    this.cursor++;
    return this.current;
  }
  commandLog(): CommandLog {
    return freeze({
      schemaVersion: 1,
      timelineId: this.current.id,
      commands: this.entries.slice(0, this.cursor).map((e) => e.command),
    });
  }
  snapshot(): TimelineSnapshot {
    return Timeline.restore(this.baseline).toSnapshot();
  }
  serializeHistory(): string {
    return JSON.stringify(
      canonical({
        schemaVersion: 1,
        snapshot: this.baseline,
        entries: this.entries,
        cursor: this.cursor,
        maxEntries: this.maxEntries,
      }),
    );
  }
  static restoreHistory(value: unknown): CommandBus {
    const d = object(typeof value === "string" ? JSON.parse(value) : value, [
      "schemaVersion",
      "snapshot",
      "entries",
      "cursor",
      "maxEntries",
    ]);
    if (d.schemaVersion !== 1) throw new DomainError("Unsupported history schema version.");
    const bus = new CommandBus(Timeline.restore(d.snapshot), numeric(d.maxEntries, 1, 1000, true)),
      entries = list(d.entries);
    if (entries.length > bus.maxEntries)
      throw new DomainError("History exceeds its explicit bound.");
    const cursor = numeric(d.cursor, 0, entries.length, true);
    let current = bus.current;
    const checked: HistoryEntry[] = [];
    for (let index = 0; index < entries.length; index++) {
      try {
        const e = object(entries[index], ["command", "inverse"]),
          applied = applyCommand(current, e.command);
        const before = applyInverse(applied.timeline, e.inverse);
        if (JSON.stringify(before.toSnapshot()) !== JSON.stringify(current.toSnapshot()))
          throw new DomainError("History inverse differs.");
        if (JSON.stringify(canonical(e.inverse)) !== JSON.stringify(canonical(applied.inverse)))
          throw new DomainError("History inverse differs.");
        unique([...checked.map((entry) => entry.command.id), applied.command.id]);
        checked.push(freeze({ command: applied.command, inverse: applied.inverse }));
        current = applied.timeline;
      } catch {
        throw new DomainError(`History failed at command index ${index}.`);
      }
    }
    bus.entries = Object.freeze(checked);
    bus.cursor = cursor;
    bus.current =
      cursor === 0
        ? Timeline.restore(bus.baseline)
        : Timeline.restore(checked[cursor - 1]!.inverse.expected);
    return bus;
  }
}
