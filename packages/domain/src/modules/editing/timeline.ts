/** Canonical Editing values. Half-open, exclusive tracks; source playback is 1:1. */
import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import {
  clipId,
  effectId,
  mediaAssetId,
  projectId,
  timelineId,
  trackId,
  uuidV7,
  componentId,
  type ClipId,
  type EffectId,
  type ProjectId,
  type TimelineId,
  type TrackId,
  type UuidV7,
  type MediaAssetId,
  type ComponentId,
} from "../../kernel/id.js";
import { microseconds, frameRate, type Microseconds, type FrameRate } from "../../kernel/time.js";
import { object, list, numeric, text, unique } from "./validation.js";

export const trackKinds = Object.freeze([
  "video",
  "overlay",
  "graphics",
  "caption",
  "audio",
] as const);
export type TrackKind = (typeof trackKinds)[number];
export function trackKind(value: unknown): TrackKind {
  if (!trackKinds.includes(value as TrackKind)) throw new DomainError("Unsupported track kind.");
  return value as TrackKind;
}
export interface Composition {
  readonly width: number;
  readonly height: number;
  readonly frameRate: FrameRate;
  readonly durationUs: Microseconds;
}
export interface TimelineSource {
  readonly id: string;
  readonly kind: "video" | "audio" | "image";
  readonly durationUs: bigint | string;
}
export interface SourceSnapshot {
  id: string;
  kind: "video" | "audio" | "image";
  durationUs: string;
}
export interface EffectSnapshot {
  id: string;
  clipId: string;
  kind: "opacity" | "gain";
  value: number;
}
export interface TransitionSnapshot {
  id: string;
  fromClipId: string;
  toClipId: string;
  kind: "cut" | "dissolve";
  durationUs: string;
}
export interface ClipSnapshot {
  id: string;
  trackId: string;
  kind: TrackKind;
  inPoint: string;
  outPoint: string;
  timelineStartUs: string;
  sourceId: string | null;
  text: string | null;
  componentId: string | null;
  opacity: number;
  volumeDb: number;
  effects: EffectSnapshot[];
}
export interface TrackSnapshot {
  id: string;
  timelineId: string;
  kind: TrackKind;
  clips: ClipSnapshot[];
  transitions: TransitionSnapshot[];
}
export interface TimelineSnapshot {
  id: string;
  projectId: string;
  createdAt: string;
  composition: {
    width: number;
    height: number;
    frameRate: { numerator: string; denominator: string };
    durationUs: string;
  };
  sources: SourceSnapshot[];
  tracks: TrackSnapshot[];
}

export class Effect {
  readonly id: EffectId;
  readonly clipId: ClipId;
  readonly kind: "opacity" | "gain";
  readonly value: number;
  constructor(id: string, clip: string, kind: "opacity" | "gain" = "opacity", value = 1) {
    this.id = effectId(id);
    this.clipId = clipId(clip);
    if (kind !== "opacity" && kind !== "gain") throw new DomainError("Unsupported effect kind.");
    this.kind = kind;
    this.value = kind === "opacity" ? numeric(value, 0, 1) : numeric(value, -60, 12);
    Object.freeze(this);
  }
  static create(id: EffectId, clip: ClipId): Effect {
    return new Effect(id, clip);
  }
  toSnapshot(): EffectSnapshot {
    return { id: this.id, clipId: this.clipId, kind: this.kind, value: this.value };
  }
  static restore(value: unknown): Effect {
    const d = object(value, ["id", "clipId", "kind", "value"]);
    if (d.kind !== "opacity" && d.kind !== "gain")
      throw new DomainError("Unsupported effect kind.");
    return new Effect(text(d.id), text(d.clipId), d.kind, numeric(d.value, -60, 12));
  }
}

export interface ClipOptions {
  kind?: TrackKind;
  timelineStartUs?: bigint | string;
  sourceId?: string | null;
  text?: string | null;
  componentId?: string | null;
  opacity?: number;
  volumeDb?: number;
  effects?: readonly Effect[];
}
export class Clip {
  readonly id: ClipId;
  readonly trackId: TrackId;
  readonly inPoint: Microseconds;
  readonly outPoint: Microseconds;
  readonly kind: TrackKind;
  readonly timelineStartUs: Microseconds;
  readonly sourceId: MediaAssetId | null;
  readonly text: string | null;
  readonly componentId: ComponentId | null;
  readonly opacity: number;
  readonly volumeDb: number;
  readonly effects: readonly Effect[];
  constructor(
    id: string,
    track: string,
    inPoint: bigint | string,
    outPoint: bigint | string,
    options: ClipOptions = {},
  ) {
    object(
      options,
      [],
      [
        "kind",
        "timelineStartUs",
        "sourceId",
        "text",
        "componentId",
        "opacity",
        "volumeDb",
        "effects",
      ],
    );
    this.id = clipId(id);
    this.trackId = trackId(track);
    this.inPoint = microseconds(inPoint);
    this.outPoint = microseconds(outPoint);
    if (this.outPoint <= this.inPoint) throw new DomainError("Clip duration must be positive.");
    this.kind = trackKind(options.kind === undefined ? "video" : options.kind);
    this.timelineStartUs = microseconds(
      options.timelineStartUs === undefined ? 0n : options.timelineStartUs,
    );
    this.sourceId = options.sourceId == null ? null : mediaAssetId(options.sourceId);
    this.text = options.text == null ? null : text(options.text);
    this.componentId = options.componentId == null ? null : componentId(options.componentId);
    if (
      this.kind === "caption" ? this.text === null || this.componentId !== null : this.text !== null
    )
      throw new DomainError("Caption text is required only on caption clips.");
    if (this.kind === "graphics" ? this.componentId === null : this.componentId !== null)
      throw new DomainError("Graphics require a canonical Component reference.");
    if (
      ["caption", "graphics"].includes(this.kind) &&
      (this.sourceId !== null || this.inPoint !== 0n)
    )
      throw new DomainError("Caption/graphics ranges are intrinsic, not media source ranges.");
    this.opacity = numeric(options.opacity === undefined ? 1 : options.opacity, 0, 1);
    this.volumeDb = numeric(options.volumeDb === undefined ? 0 : options.volumeDb, -60, 12);
    this.effects = Object.freeze(
      (options.effects === undefined ? [] : options.effects).map((effect) => {
        if (!(effect instanceof Effect) || effect.clipId !== this.id)
          throw new DomainError("Invalid clip effect relation.");
        return new Effect(effect.id, effect.clipId, effect.kind, effect.value);
      }),
    );
    unique(this.effects.map((effect) => effect.id));
    Object.freeze(this);
  }
  get durationUs(): Microseconds {
    return this.outPoint - this.inPoint;
  }
  get timelineEndUs(): Microseconds {
    return this.timelineStartUs + this.durationUs;
  }
  static create(
    id: ClipId,
    track: TrackId,
    start: bigint | string,
    end: bigint | string,
    options: ClipOptions = {},
  ): Clip {
    return new Clip(id, track, start, end, options);
  }
  toSnapshot(): ClipSnapshot {
    return {
      id: this.id,
      trackId: this.trackId,
      kind: this.kind,
      inPoint: String(this.inPoint),
      outPoint: String(this.outPoint),
      timelineStartUs: String(this.timelineStartUs),
      sourceId: this.sourceId,
      text: this.text,
      componentId: this.componentId,
      opacity: this.opacity,
      volumeDb: this.volumeDb,
      effects: this.effects.map((e) => e.toSnapshot()),
    };
  }
  static restore(value: unknown): Clip {
    const d = object(value, [
      "id",
      "trackId",
      "kind",
      "inPoint",
      "outPoint",
      "timelineStartUs",
      "sourceId",
      "text",
      "componentId",
      "opacity",
      "volumeDb",
      "effects",
    ]);
    for (const key of ["sourceId", "text", "componentId"]) if (d[key] !== null) text(d[key]);
    return new Clip(text(d.id), text(d.trackId), d.inPoint as string, d.outPoint as string, {
      kind: trackKind(d.kind),
      timelineStartUs: d.timelineStartUs as string,
      sourceId: d.sourceId as string | null,
      text: d.text as string | null,
      componentId: d.componentId as string | null,
      opacity: numeric(d.opacity, 0, 1),
      volumeDb: numeric(d.volumeDb, -60, 12),
      effects: list(d.effects).map(Effect.restore),
    });
  }
}
export class AudioClip extends Clip {
  constructor(
    id: string,
    track: string,
    source: string,
    start: bigint | string,
    end: bigint | string,
    placement: bigint | string = 0n,
  ) {
    super(id, track, start, end, { kind: "audio", sourceId: source, timelineStartUs: placement });
  }
}
export class Caption extends Clip {
  constructor(
    id: string,
    track: string,
    start: bigint | string,
    end: bigint | string,
    content: string,
  ) {
    const a = microseconds(start),
      b = microseconds(end);
    super(id, track, 0n, b - a, { kind: "caption", text: content, timelineStartUs: a });
  }
}
export class ComponentInstance extends Clip {
  constructor(
    id: string,
    track: string,
    component: string,
    start: bigint | string,
    end: bigint | string,
  ) {
    const a = microseconds(start),
      b = microseconds(end);
    super(id, track, 0n, b - a, { kind: "graphics", componentId: component, timelineStartUs: a });
  }
}
export class Transition {
  readonly id: UuidV7;
  readonly fromClipId: ClipId;
  readonly toClipId: ClipId;
  readonly kind: "cut" | "dissolve";
  readonly durationUs: Microseconds;
  constructor(
    id: string,
    from: string,
    to: string,
    kind: "cut" | "dissolve",
    duration: bigint | string,
  ) {
    this.id = uuidV7(id);
    this.fromClipId = clipId(from);
    this.toClipId = clipId(to);
    this.durationUs = microseconds(duration);
    if (
      this.fromClipId === this.toClipId ||
      !["cut", "dissolve"].includes(kind) ||
      (kind === "cut" ? this.durationUs !== 0n : this.durationUs === 0n)
    )
      throw new DomainError("Invalid transition kind, pair or duration.");
    this.kind = kind;
    Object.freeze(this);
  }
  toSnapshot(): TransitionSnapshot {
    return {
      id: this.id,
      fromClipId: this.fromClipId,
      toClipId: this.toClipId,
      kind: this.kind,
      durationUs: String(this.durationUs),
    };
  }
  static restore(value: unknown): Transition {
    const d = object(value, ["id", "fromClipId", "toClipId", "kind", "durationUs"]);
    return new Transition(
      text(d.id),
      text(d.fromClipId),
      text(d.toClipId),
      d.kind as "cut" | "dissolve",
      d.durationUs as string,
    );
  }
}
export class Track {
  readonly id: TrackId;
  readonly timelineId: TimelineId;
  readonly kind: TrackKind;
  readonly clips: readonly Clip[];
  readonly transitions: readonly Transition[];
  constructor(
    id: string,
    timeline: string,
    kind: TrackKind = "video",
    clips: readonly Clip[] = [],
    transitions: readonly Transition[] = [],
  ) {
    this.id = trackId(id);
    this.timelineId = timelineId(timeline);
    this.kind = trackKind(kind);
    this.clips = Object.freeze(
      clips
        .map((clip) => {
          if (!(clip instanceof Clip) || clip.trackId !== this.id || clip.kind !== this.kind)
            throw new DomainError("Invalid clip/track relation.");
          return Clip.restore(clip.toSnapshot());
        })
        .sort((a, b) =>
          a.timelineStartUs < b.timelineStartUs
            ? -1
            : a.timelineStartUs > b.timelineStartUs
              ? 1
              : a.id.localeCompare(b.id),
        ),
    );
    unique(this.clips.map((clip) => clip.id));
    for (let i = 1; i < this.clips.length; i++)
      if (this.clips[i]!.timelineStartUs < this.clips[i - 1]!.timelineEndUs)
        throw new DomainError("Same-track overlap is illegal; use separate tracks.");
    this.transitions = Object.freeze(
      transitions.map((transition) => {
        if (!(transition instanceof Transition)) throw new DomainError("Invalid transition.");
        const from = this.clips.findIndex((clip) => clip.id === transition.fromClipId),
          to = this.clips[from + 1];
        if (
          from < 0 ||
          !to ||
          to.id !== transition.toClipId ||
          this.clips[from]!.timelineEndUs !== to.timelineStartUs ||
          transition.durationUs > this.clips[from]!.durationUs ||
          transition.durationUs > to.durationUs ||
          !["video", "overlay"].includes(this.kind)
        )
          throw new DomainError(
            "Transitions require adjacent touching visual clips and bounded duration.",
          );
        return Transition.restore(transition.toSnapshot());
      }),
    );
    unique(this.transitions.map((transition) => transition.id));
    // UUID spellings are canonical, so this ordered join key is unambiguous.
    unique(this.transitions.map((transition) => `${transition.fromClipId}/${transition.toClipId}`));
    Object.freeze(this);
  }
  static create(
    id: TrackId,
    timeline: TimelineId,
    kind: TrackKind = "video",
    clips: readonly Clip[] = [],
    transitions: readonly Transition[] = [],
  ): Track {
    return new Track(id, timeline, kind, clips, transitions);
  }
  toSnapshot(): TrackSnapshot {
    return {
      id: this.id,
      timelineId: this.timelineId,
      kind: this.kind,
      clips: this.clips.map((c) => c.toSnapshot()),
      transitions: this.transitions.map((t) => t.toSnapshot()),
    };
  }
  static restore(value: unknown): Track {
    const d = object(value, ["id", "timelineId", "kind", "clips", "transitions"]);
    return new Track(
      text(d.id),
      text(d.timelineId),
      trackKind(d.kind),
      list(d.clips).map(Clip.restore),
      list(d.transitions).map(Transition.restore),
    );
  }
}
export interface TimelineOptions {
  composition?: Composition;
  sources?: readonly TimelineSource[];
  tracks?: readonly Track[];
}
export class Timeline {
  readonly id: TimelineId;
  readonly projectId: ProjectId;
  readonly createdAt: Instant;
  readonly composition: Composition;
  readonly sources: readonly Readonly<{
    id: MediaAssetId;
    kind: "video" | "audio" | "image";
    durationUs: Microseconds;
  }>[];
  readonly tracks: readonly Track[];
  constructor(
    id: string,
    project: string,
    createdAt: Instant | string,
    options: TimelineOptions = {},
  ) {
    object(options, [], ["composition", "sources", "tracks"]);
    this.id = timelineId(id);
    this.projectId = projectId(project);
    this.createdAt = instant(createdAt);
    const comp =
      options.composition === undefined
        ? {
            width: 1920,
            height: 1080,
            frameRate: frameRate(30n, 1n),
            durationUs: 0n,
          }
        : options.composition;
    object(comp, ["width", "height", "frameRate", "durationUs"]);
    object(comp.frameRate, ["numerator", "denominator"]);
    const rate = frameRate(comp.frameRate.numerator, comp.frameRate.denominator);
    if (rate.numerator > 60n * rate.denominator)
      throw new DomainError("Composition rate exceeds 60fps.");
    this.composition = Object.freeze({
      width: numeric(comp.width, 1, 16384, true),
      height: numeric(comp.height, 1, 16384, true),
      frameRate: rate,
      durationUs: microseconds(comp.durationUs),
    });
    this.sources = Object.freeze(
      (options.sources === undefined ? [] : options.sources)
        .map((source) => {
          object(source, ["id", "kind", "durationUs"]);
          const duration = microseconds(source.durationUs);
          if (duration === 0n || !["video", "audio", "image"].includes(source.kind))
            throw new DomainError("Invalid source kind or duration.");
          return Object.freeze({
            id: mediaAssetId(source.id),
            kind: source.kind,
            durationUs: duration,
          });
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    unique(this.sources.map((source) => source.id));
    this.tracks = Object.freeze(
      (options.tracks === undefined ? [] : options.tracks).map((track) => {
        if (!(track instanceof Track) || track.timelineId !== this.id)
          throw new DomainError("Invalid track/timeline relation.");
        return Track.restore(track.toSnapshot());
      }),
    );
    const ids: string[] = [this.id];
    for (const track of this.tracks) {
      ids.push(track.id);
      for (const transition of track.transitions) ids.push(transition.id);
      for (const clip of track.clips) {
        ids.push(clip.id, ...clip.effects.map((effect) => effect.id));
        if (clip.timelineEndUs > this.composition.durationUs)
          throw new DomainError("Clip exceeds composition duration.");
        if (["video", "overlay", "audio"].includes(clip.kind)) {
          const source = this.sources.find((asset) => asset.id === clip.sourceId);
          if (
            !source ||
            clip.outPoint > source.durationUs ||
            (clip.kind === "audio"
              ? !["video", "audio"].includes(source.kind)
              : !["video", "image"].includes(source.kind))
          )
            throw new DomainError("Invalid media source range or kind.");
        }
      }
    }
    unique(ids);
    Object.freeze(this);
  }
  static create(
    id: TimelineId,
    project: ProjectId,
    createdAt: Instant,
    options: TimelineOptions = {},
  ): Timeline {
    return new Timeline(id, project, createdAt, options);
  }
  toSnapshot(): TimelineSnapshot {
    return {
      id: this.id,
      projectId: this.projectId,
      createdAt: String(this.createdAt),
      composition: {
        width: this.composition.width,
        height: this.composition.height,
        frameRate: {
          numerator: String(this.composition.frameRate.numerator),
          denominator: String(this.composition.frameRate.denominator),
        },
        durationUs: String(this.composition.durationUs),
      },
      sources: this.sources.map((s) => ({
        id: s.id,
        kind: s.kind,
        durationUs: String(s.durationUs),
      })),
      tracks: this.tracks.map((t) => t.toSnapshot()),
    };
  }
  static restore(value: unknown): Timeline {
    const d = object(value, ["id", "projectId", "createdAt", "composition", "sources", "tracks"]),
      c = object(d.composition, ["width", "height", "frameRate", "durationUs"]),
      f = object(c.frameRate, ["numerator", "denominator"]);
    return new Timeline(text(d.id), text(d.projectId), text(d.createdAt), {
      composition: {
        width: c.width as number,
        height: c.height as number,
        frameRate: frameRate(
          microseconds(f.numerator as string),
          microseconds(f.denominator as string),
        ),
        durationUs: microseconds(c.durationUs as string),
      },
      sources: list(d.sources).map((s) => {
        const v = object(s, ["id", "kind", "durationUs"]);
        return {
          id: text(v.id),
          kind: v.kind as "video" | "audio" | "image",
          durationUs: microseconds(v.durationUs as string),
        };
      }),
      tracks: list(d.tracks).map(Track.restore),
    });
  }
}
