/** Source-bound timed captions v1. No language guessing, timing repair or executable styles. */
import { DomainError } from "../../kernel/error.js";
import { uuidV7 } from "../../kernel/id.js";
import { frameTime, type FrameRate } from "../../kernel/time.js";
import { object, list, text, numeric, unique } from "./validation.js";

export interface CaptionWordV1 {
  text: string;
  startUs: string;
  endUs: string;
  confidence: number | null;
}
export interface CaptionStyleV1 {
  color: string;
  background: string;
  highlight: string;
  outline: string;
  outlinePx: number;
  shadowPx: number;
  font: "DejaVu Sans";
  fontSize: number;
  direction: "auto" | "ltr" | "rtl";
  preset: "vertical" | "square" | "landscape";
  marginPermille: number;
}
export const DEFAULT_CAPTION_STYLE: Readonly<CaptionStyleV1> = Object.freeze({
  color: "#ffffff",
  background: "#000000",
  highlight: "#ffff00",
  outline: "#000000",
  outlinePx: 0,
  shadowPx: 1,
  font: "DejaVu Sans",
  fontSize: 28,
  direction: "auto",
  preset: "landscape",
  marginPermille: 0,
});
export interface CaptionBlockV1 {
  startUs: string;
  endUs: string;
  lines: CaptionWordV1[][];
}
export interface CaptionTrackV1 {
  schemaVersion: "1.0.0";
  id: string;
  createdBy: string;
  assetId: string;
  sourceSha256: string;
  sourceDurationUs: string;
  evidence: { kind: "media-analysis" | "human-timed"; documentSha256: string; version: string };
  style: CaptionStyleV1;
  rules: {
    maxCharacters: number;
    maxLines: number;
    maxCharactersPerSecond: number;
    minDurationUs: string;
  };
  blocks: CaptionBlockV1[];
}
const fail = (): never => {
  throw new DomainError("Invalid or unreadable timed captions.");
};
/** Bounded internal cause; never carries caption text, identities or source keys. */
export class CaptionReadabilityError extends DomainError {
  declare readonly cause?: unknown;
  constructor(
    readonly reason:
      | "orientation"
      | "line_limit"
      | "character_limit"
      | "width"
      | "height"
      | "min_duration"
      | "reading_speed",
    cause?: unknown,
  ) {
    super("Invalid or unreadable timed captions.");
    this.name = "CaptionReadabilityError";
    if (cause !== undefined)
      Object.defineProperty(this, "cause", { value: cause, enumerable: false });
  }
}
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
export const captionCharacters = (v: string): number => [...graphemes.segment(v)].length;
const color = (v: unknown): string =>
  typeof v === "string" && v.length === 7 && /^#[0-9a-f]{6}$/.test(v) ? v : fail();
export function captionTime(v: unknown): bigint {
  if (
    typeof v !== "string" ||
    /^(0|[1-9][0-9]{0,9})$/.exec(v)?.[0] !== v ||
    BigInt(v) > 3600000000n
  )
    fail();
  return BigInt(v as string);
}
export function captionHash(v: unknown): string {
  return typeof v === "string" && v.length === 64 && /^[a-f0-9]{64}$/.test(v) ? v : fail();
}
export function captionStyle(value: unknown): CaptionStyleV1 {
  const d = object(value, Object.keys(DEFAULT_CAPTION_STYLE));
  if (
    d.font !== "DejaVu Sans" ||
    typeof d.direction !== "string" ||
    !["auto", "ltr", "rtl"].includes(d.direction) ||
    typeof d.preset !== "string" ||
    !["vertical", "square", "landscape"].includes(d.preset)
  )
    fail();
  const colors = {
    color: color(d.color),
    background: color(d.background),
    highlight: color(d.highlight),
  };
  if (
    colors.color === colors.background ||
    colors.highlight === colors.background ||
    colors.highlight === colors.color
  )
    fail();
  return Object.freeze({
    ...colors,
    outline: color(d.outline),
    outlinePx: numeric(d.outlinePx, 0, 2, true),
    shadowPx: numeric(d.shadowPx, 0, 4, true),
    font: "DejaVu Sans",
    fontSize: numeric(d.fontSize, 8, 96, true),
    direction: d.direction as CaptionStyleV1["direction"],
    preset: d.preset as CaptionStyleV1["preset"],
    marginPermille: numeric(d.marginPermille, 0, 100, true),
  });
}
export function captionWords(value: unknown, duration: string): CaptionWordV1[] {
  const input = list(value);
  if (!input.length || input.length > 36000) fail();
  let previous = 0n;
  return input.map((v) => {
    const d = object(v, ["text", "startUs", "endUs", "confidence"]);
    const content = text(d.text);
    // Reject controls/overrides, not Arabic, diacritics, emoji ZWJ or ordinary punctuation.
    if (
      content.length > 256 ||
      /\p{Cc}|[\u202a-\u202e\u2066-\u2069]/u.test(content) ||
      /[\r\n]/u.test(content)
    )
      fail();
    for (const { segment } of graphemes.segment(content))
      if (segment.length > 32 || [...segment.matchAll(/\p{M}/gu)].length > 4) fail();
    const a = captionTime(d.startUs),
      b = captionTime(d.endUs);
    if (a < previous || a >= b || b > captionTime(duration)) fail();
    previous = b;
    return Object.freeze({
      text: content,
      startUs: String(a),
      endUs: String(b),
      confidence: d.confidence === null ? null : numeric(d.confidence, 0, 1),
    });
  });
}
export function safeCaptionZone(width: number, height: number, style: CaptionStyleV1) {
  // Conservative fixed platform UI exclusions, not qualified face/speaker tracking.
  const p =
    style.preset === "vertical"
      ? { left: 80, right: 180, top: 120, bottom: 220 }
      : style.preset === "square"
        ? { left: 80, right: 80, top: 80, bottom: 160 }
        : { left: 60, right: 60, top: 80, bottom: 140 };
  const m = style.marginPermille;
  return {
    x: Math.ceil((width * (p.left + m)) / 1000),
    y: Math.ceil((height * (p.top + m)) / 1000),
    width: Math.floor((width * (1000 - p.left - p.right - 2 * m)) / 1000),
    height: Math.floor((height * (1000 - p.top - p.bottom - 2 * m)) / 1000),
  };
}
export function validateCaptionReadability(
  track: CaptionTrackV1,
  width: number,
  height: number,
): void {
  if (
    (track.style.preset === "vertical" && height <= width) ||
    (track.style.preset === "square" && width !== height) ||
    (track.style.preset === "landscape" && width <= height)
  )
    throw new CaptionReadabilityError("orientation");
  const zone = safeCaptionZone(width, height, track.style),
    pad = 8 + track.style.outlinePx + track.style.shadowPx;
  for (const b of track.blocks) {
    const lengths = b.lines.map((line) =>
      captionCharacters(line.map((w) => w.text.trim()).join(" ")),
    );
    const count = lengths.reduce((a, b) => a + b, 0);
    if (b.lines.length > track.rules.maxLines) throw new CaptionReadabilityError("line_limit");
    if (lengths.some((n) => n > track.rules.maxCharacters))
      throw new CaptionReadabilityError("character_limit");
    if (Math.max(...lengths) * track.style.fontSize * 1.2 + 2 * pad > zone.width)
      throw new CaptionReadabilityError("width");
    if (b.lines.length * track.style.fontSize * 1.5 + 2 * pad > zone.height)
      throw new CaptionReadabilityError("height");
    if (BigInt(b.endUs) - BigInt(b.startUs) < BigInt(track.rules.minDurationUs))
      throw new CaptionReadabilityError("min_duration");
    if (
      count * 1000000 >
      Number(BigInt(b.endUs) - BigInt(b.startUs)) * track.rules.maxCharactersPerSecond
    )
      throw new CaptionReadabilityError("reading_speed");
  }
}
export function segmentCaptionWords(
  words: CaptionWordV1[],
  duration: string,
  rules: CaptionTrackV1["rules"],
  /** Render-only retained source window. Container padding may extend left into
   * retained silence; native word intervals and persisted blocks never move. */
  projectionStartUs?: string,
): CaptionBlockV1[] {
  const maxCharacters = numeric(rules.maxCharacters, 8, 42, true),
    maxLines = numeric(rules.maxLines, 1, 2, true),
    cps = numeric(rules.maxCharactersPerSecond, 8, 30, true),
    minimum = captionTime(rules.minDurationUs);
  if (minimum < 500000n || minimum > 2000000n) fail();
  words = captionWords(words, duration);
  const floor = projectionStartUs === undefined ? undefined : captionTime(projectionStartUs);
  if (floor !== undefined && floor > BigInt(words[0]!.startUs)) fail();
  const lengths = words.map((w) => captionCharacters(w.text.trim())),
    starts = words.map((w) => BigInt(w.startUs)),
    ends = words.map((w) => BigInt(w.endUs));
  if (lengths.some((n) => n > maxCharacters)) fail();
  const count = new Array<number>(words.length + 1).fill(Infinity);
  const choice = new Array<{ last: number; split: number; start: bigint; end: bigint } | undefined>(
    words.length,
  );
  count[words.length] = 0;
  // Bounded suffix dynamic programming avoids a greedy unreadable final word.
  // Each start examines at most maxCharacters*maxLines whole words; no text or
  // lexical timestamp changes, threshold relaxation or unbounded search.
  for (let i = words.length - 1; i >= 0; i--) {
    let lineChars = 0,
      totalChars = 0,
      lines = 1,
      split = -1;
    for (let j = i; j < words.length && j < i + maxCharacters * maxLines; j++) {
      if (ends[j]! - starts[i]! > 6000000n) break;
      const added = lengths[j]! + (lineChars ? 1 : 0);
      if (lineChars + added > maxCharacters) {
        if (lines >= maxLines) break;
        lines++;
        split = j;
        lineChars = lengths[j]!;
        totalChars += lengths[j]!;
      } else {
        lineChars += added;
        totalChars += added;
      }
      const readable = BigInt(Math.ceil((totalChars * 1000000) / cps));
      const span = readable > minimum ? readable : minimum;
      let start = starts[i]!,
        end = ends[j]! > start + span ? ends[j]! : start + span;
      const limit =
        floor === undefined
          ? (starts[j + 1] ?? BigInt(duration))
          : (choice[j + 1]?.start ?? starts[j + 1] ?? BigInt(duration));
      if (floor !== undefined && end > limit) {
        end = limit;
        start = end - span;
      }
      const blocks = 1 + count[j + 1]!;
      if (
        start <= starts[i]! &&
        start >=
          (floor === undefined
            ? starts[i]!
            : ends[i - 1] === undefined || ends[i - 1]! < floor
              ? floor
              : ends[i - 1]!) &&
        ends[j]! <= end &&
        end <= limit &&
        end - start <= 6000000n &&
        Number.isFinite(blocks) &&
        blocks <= count[i]!
      ) {
        count[i] = blocks;
        choice[i] = { last: j, split, start, end };
      }
    }
  }
  if (!choice[0] || count[0]! > 2000) fail();
  const blocks: CaptionBlockV1[] = [];
  for (let i = 0; i < words.length;) {
    const c = choice[i];
    if (!c) fail();
    const stop = c!.last + 1;
    const lines =
      c!.split < 0
        ? [words.slice(i, stop)]
        : [words.slice(i, c!.split), words.slice(c!.split, stop)];
    blocks.push({ startUs: String(c!.start), endUs: String(c!.end), lines });
    i = stop;
  }
  return blocks;
}
export function restoreCaptionTrack(value: unknown): CaptionTrackV1 {
  const d = object(value, [
    "schemaVersion",
    "id",
    "createdBy",
    "assetId",
    "sourceSha256",
    "sourceDurationUs",
    "evidence",
    "style",
    "rules",
    "blocks",
  ]);
  if (d.schemaVersion !== "1.0.0" || captionTime(d.sourceDurationUs) === 0n) fail();
  const e = object(d.evidence, ["kind", "documentSha256", "version"]);
  if (
    typeof e.kind !== "string" ||
    !["media-analysis", "human-timed"].includes(e.kind) ||
    typeof e.version !== "string" ||
    /^[0-9]+\.[0-9]+\.[0-9]+$/.exec(e.version)?.[0] !== e.version
  )
    fail();
  const r = object(d.rules, [
    "maxCharacters",
    "maxLines",
    "maxCharactersPerSecond",
    "minDurationUs",
  ]);
  const rules = {
    maxCharacters: numeric(r.maxCharacters, 8, 42, true),
    maxLines: numeric(r.maxLines, 1, 2, true),
    maxCharactersPerSecond: numeric(r.maxCharactersPerSecond, 8, 30, true),
    minDurationUs: String(captionTime(r.minDurationUs)),
  };
  if (BigInt(rules.minDurationUs) < 500000n || BigInt(rules.minDurationUs) > 2000000n) fail();
  const blocks = list(d.blocks);
  if (!blocks.length || blocks.length > 2000) fail();
  let end = 0n;
  const parsed = blocks.map((value) => {
    const b = object(value, ["startUs", "endUs", "lines"]),
      a = captionTime(b.startUs),
      z = captionTime(b.endUs);
    if (a < end || a >= z || z > captionTime(d.sourceDurationUs) || z - a > 6000000n) fail();
    end = z;
    const lines = list(b.lines).map((line) => captionWords(line, String(d.sourceDurationUs)));
    const words = captionWords(lines.flat(), String(d.sourceDurationUs));
    if (
      !lines.length ||
      lines.length > rules.maxLines ||
      BigInt(words[0]!.startUs) < a ||
      BigInt(words.at(-1)!.endUs) > z
    )
      fail();
    return { startUs: String(a), endUs: String(z), lines };
  });
  const result: CaptionTrackV1 = {
    schemaVersion: "1.0.0",
    id: uuidV7(text(d.id)),
    createdBy: uuidV7(text(d.createdBy)),
    assetId: uuidV7(text(d.assetId)),
    sourceSha256: captionHash(d.sourceSha256),
    sourceDurationUs: String(captionTime(d.sourceDurationUs)),
    evidence: {
      kind: e.kind as "media-analysis" | "human-timed",
      documentSha256: captionHash(e.documentSha256),
      version: e.version as string,
    },
    style: captionStyle(d.style),
    rules,
    blocks: parsed,
  };
  return result;
}
export function validateCaptionTracks(values: readonly unknown[]): CaptionTrackV1[] {
  if (values.length > 16) fail();
  const tracks = values.map(restoreCaptionTrack);
  unique(tracks.map((t) => t.id));
  unique(tracks.map((t) => t.assetId));
  return tracks;
}
/** Exact half-open frame membership using the same rounded rational clock as Timeline. */
export function captionWordAtFrame(
  words: readonly CaptionWordV1[],
  frame: bigint,
  rate: FrameRate,
): number {
  const t = frameTime(frame, rate);
  return words.findIndex((w) => BigInt(w.startUs) <= t && t < BigInt(w.endUs));
}
export interface ProjectedCaptionV1 {
  captionId: string;
  sourceClipId: string;
  /** Complete clip ownership when a native word crosses a non-destructive split. */
  sourceClipIds?: string[];
  startUs: string;
  endUs: string;
  style: CaptionStyleV1;
  lines: CaptionWordV1[][];
}
/** Re-project persisted SOURCE coordinates through continuous retained 1:1 runs.
 * A non-destructive split is not a new acoustic boundary. Source AND composition
 * adjacency are required, within the same track; gaps/reorders never bridge.
 * A clipped lexical item is omitted from the display rather than assigned invented
 * partial word timings. The persisted original words are never changed/deleted.
 */
export function projectTimedCaptions(snapshot: {
  captionsV1?: readonly CaptionTrackV1[];
  composition: { width: number; height: number };
  tracks: readonly {
    clips: readonly {
      kind: string;
      sourceId: string | null;
      inPoint: string;
      outPoint: string;
      timelineStartUs: string;
      id: string;
    }[];
  }[];
}): ProjectedCaptionV1[] {
  const result: ProjectedCaptionV1[] = [];
  for (const caption of snapshot.captionsV1 ?? []) {
    for (const track of snapshot.tracks) {
      const runs: {
        a: bigint;
        b: bigint;
        offset: bigint;
        clips: { a: bigint; b: bigint; id: string }[];
      }[] = [];
      for (const clip of track.clips.filter(
        (c) => c.kind === "video" && c.sourceId === caption.assetId,
      )) {
        const a = BigInt(clip.inPoint),
          b = BigInt(clip.outPoint),
          offset = BigInt(clip.timelineStartUs) - a,
          previous = runs.at(-1);
        if (previous && previous.b === a && previous.offset === offset) {
          previous.b = b;
          previous.clips.push({ a, b, id: clip.id });
        } else runs.push({ a, b, offset, clips: [{ a, b, id: clip.id }] });
      }
      for (const { a, b, offset, clips } of runs) {
        let blocks: CaptionBlockV1[] = [];
        for (const block of caption.blocks) {
          const lines = block.lines
            .map((l) => l.filter((w) => BigInt(w.startUs) >= a && BigInt(w.endUs) <= b))
            .filter((l) => l.length);
          if (!lines.length) continue;
          const first = BigInt(lines[0]![0]!.startUs),
            last = BigInt(lines.at(-1)!.at(-1)!.endUs);
          const start = BigInt(block.startUs) > a ? BigInt(block.startUs) : a;
          const end = BigInt(block.endUs) < b ? BigInt(block.endUs) : b;
          if (first < start || last > end) fail();
          blocks.push({ startUs: String(start), endUs: String(end), lines });
        }
        try {
          validateCaptionReadability(
            { ...caption, blocks },
            snapshot.composition.width,
            snapshot.composition.height,
          );
        } catch (error) {
          if (
            !(error instanceof CaptionReadabilityError) ||
            !["min_duration", "reading_speed"].includes(error.reason)
          )
            throw error;
          // Reflow whole retained words under the SAME readability and source
          // bounds. Only display containers may borrow retained silence. Failure
          // remains explicit if no defensible, non-overlapping layout exists.
          try {
            blocks = segmentCaptionWords(
              blocks.flatMap((block) => block.lines.flat()),
              String(b),
              caption.rules,
              String(a),
            );
          } catch (cause) {
            throw new CaptionReadabilityError(error.reason, cause);
          }
          validateCaptionReadability(
            { ...caption, blocks },
            snapshot.composition.width,
            snapshot.composition.height,
          );
        }
        for (const block of blocks) {
          const owners = clips
            .filter((clip) => clip.a < BigInt(block.endUs) && clip.b > BigInt(block.startUs))
            .map((clip) => clip.id);
          result.push({
            captionId: caption.id,
            sourceClipId: owners[0]!,
            sourceClipIds: owners,
            startUs: String(BigInt(block.startUs) + offset),
            endUs: String(BigInt(block.endUs) + offset),
            style: caption.style,
            lines: block.lines.map((l) =>
              l.map((w) => ({
                ...w,
                startUs: String(BigInt(w.startUs) + offset),
                endUs: String(BigInt(w.endUs) + offset),
              })),
            ),
          });
        }
      }
    }
  }
  result.sort((a, b) =>
    BigInt(a.startUs) < BigInt(b.startUs)
      ? -1
      : BigInt(a.startUs) > BigInt(b.startUs)
        ? 1
        : a.captionId.localeCompare(b.captionId),
  );
  // Simultaneously competing speech sources need an explicit future layout policy.
  for (let i = 1; i < result.length; i++)
    if (BigInt(result[i]!.startUs) < BigInt(result[i - 1]!.endUs)) fail();
  return result;
}
