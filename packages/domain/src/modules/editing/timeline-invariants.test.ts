import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { createUuidV7, userId, projectId } from "../../kernel/id.js";
import { frameRate, frameTime, snapToFrame, microseconds, frameIndex } from "../../kernel/time.js";
import {
  Clip,
  Effect,
  Timeline,
  Track,
  Caption,
  AudioClip,
  ComponentInstance,
  Transition,
  trackKinds,
  type TrackKind,
} from "./timeline.js";
import { deserializeProject, projectDocument, serializeProject } from "../../project-document.js";
import { Project } from "../../index.js";
// Cross-module test imports are kept at the domain entrypoint by the architecture contract.
export const id = (n: number) => createUuidV7(1700000000000 + n, new Uint8Array(10).fill(n % 256));
export const project = Project.create(projectId(id(1)), "Timeline project", userId(id(2)), 0n);
export function fixture(kind: TrackKind = "video"): Timeline {
  const clip =
    kind === "caption"
      ? new Caption(id(20), id(10), 0n, 1000000n, "مرحباً")
      : kind === "graphics"
        ? new ComponentInstance(id(20), id(10), id(6), 0n, 1000000n)
        : kind === "audio"
          ? new AudioClip(id(20), id(10), id(4), 0n, 1000000n)
          : new Clip(id(20), id(10), 0n, 1000000n, {
              kind,
              sourceId: id(4),
              effects: [new Effect(id(30), id(20))],
            });
  return new Timeline(id(3), project.id, 0n, {
    composition: {
      width: 1920,
      height: 1080,
      frameRate: frameRate(30000n, 1001n),
      durationUs: 10000000n,
    },
    sources: [{ id: id(4), kind: "video", durationUs: 100000000n }],
    tracks: [new Track(id(10), id(3), kind, [clip])],
  });
}
const check = { seed: 214215, numRuns: 300 };
test("empty/minimal project round-trips with canonical Project authorization", () => {
  const timeline = new Timeline(id(3), project.id, 0n);
  const restored = deserializeProject(serializeProject(project, timeline));
  assert.deepEqual(restored.timeline, timeline);
  assert.deepEqual(restored.project, project);
  assert.equal(restored.project.roleOf(userId(id(2))), "owner");
  assert.equal(restored.timeline.composition.durationUs, 0n);
});
for (const kind of trackKinds)
  test(`valid ${kind} track round-trips`, () => {
    const timeline = fixture(kind),
      document = projectDocument(project, timeline);
    assert.deepEqual(deserializeProject(document).timeline, timeline);
    assert.equal(
      serializeProject(project, timeline),
      serializeProject(project, Timeline.restore(timeline.toSnapshot())),
    );
    assert.ok(Object.isFrozen(timeline.tracks));
    assert.ok(Object.isFrozen(timeline.tracks[0]!.clips[0]));
  });
test("arbitrary valid generated timelines survive project.json as equal values", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          kind: fc.constantFrom(...trackKinds),
          lengths: fc.array(fc.integer({ min: 1, max: 1000000 }), { maxLength: 8 }),
          gap: fc.integer({ min: 0, max: 100000 }),
        }),
        { maxLength: 8 },
      ),
      (specs) => {
        const tracks = specs.map((spec, t) => {
          let position = 0n;
          const tid = id(100 + t);
          const clips = spec.lengths.map((length, c) => {
            const start = position;
            position += BigInt(length + spec.gap);
            return new Clip(id(1000 + t * 10 + c), tid, 0n, BigInt(length), {
              kind: spec.kind,
              timelineStartUs: start,
              sourceId: spec.kind === "caption" || spec.kind === "graphics" ? null : id(4),
              text: spec.kind === "caption" ? "Word،" : null,
              componentId: spec.kind === "graphics" ? id(6) : null,
            });
          });
          return new Track(tid, id(3), spec.kind, clips);
        });
        const timeline = new Timeline(id(3), project.id, 0n, {
          composition: {
            width: 1080,
            height: 1920,
            frameRate: frameRate(24000n, 1001n),
            durationUs: 100000000n,
          },
          sources: [{ id: id(4), kind: "video", durationUs: 100000000n }],
          tracks,
        });
        assert.deepEqual(
          deserializeProject(serializeProject(project, timeline)).timeline,
          timeline,
        );
      },
    ),
    check,
  );
}, 20000);
test("touching boundaries are legal; same-track overlap is rejected and cross-track overlap is legal", () => {
  const a = new Clip(id(20), id(10), 0n, 100n, { sourceId: id(4) }),
    b = new Clip(id(21), id(10), 100n, 200n, { timelineStartUs: 100n, sourceId: id(4) });
  const transition = new Transition(id(31), a.id, b.id, "dissolve", 50n);
  const track = new Track(id(10), id(3), "video", [b, a], [transition]);
  assert.equal(track.clips[0]!.id, a.id);
  assert.deepEqual(Track.restore(track.toSnapshot()), track);
  assert.throws(
    () =>
      new Track(id(10), id(3), "video", [
        a,
        new Clip(id(21), id(10), 0n, 100n, { timelineStartUs: 99n }),
      ]),
  );
  const s = fixture().toSnapshot();
  s.tracks.push({
    ...s.tracks[0]!,
    id: id(11),
    clips: [{ ...s.tracks[0]!.clips[0]!, id: id(22), trackId: id(11), effects: [] }],
  });
  assert.equal(Timeline.restore(s).tracks.length, 2);
});
const invalids: Record<string, (s: ReturnType<Timeline["toSnapshot"]>) => void> = {
  "zero clip duration": (s) => (s.tracks[0]!.clips[0]!.outPoint = "0"),
  "negative duration": (s) => (s.composition.durationUs = "-1"),
  "fractional microseconds": (s) => (s.tracks[0]!.clips[0]!.inPoint = "0.5"),
  "numeric microseconds": (s) => Object.assign(s.tracks[0]!.clips[0]!, { outPoint: 100 }),
  "unsafe microseconds": (s) =>
    Object.assign(s.composition, { durationUs: Number.MAX_SAFE_INTEGER + 1 }),
  "out of asset": (s) => (s.tracks[0]!.clips[0]!.outPoint = "100000001"),
  "out of timeline": (s) => (s.composition.durationUs = "1"),
  "unknown kind": (s) => Object.assign(s.tracks[0]!, { kind: "unknown" }),
  "wrong source kind": (s) => (s.sources[0]!.kind = "audio"),
  "missing source": (s) => (s.sources = []),
  "wrong track": (s) => (s.tracks[0]!.clips[0]!.trackId = id(11)),
  "wrong timeline": (s) => (s.tracks[0]!.timelineId = id(99)),
  "duplicate track": (s) => s.tracks.push(s.tracks[0]!),
  "duplicate source": (s) => s.sources.push(s.sources[0]!),
  "zero source": (s) => (s.sources[0]!.durationUs = "0"),
  "unknown source kind": (s) => Object.assign(s.sources[0]!, { kind: "executable" }),
  "invalid id": (s) => (s.id = "bad"),
  "unsupported fps": (s) => (s.composition.frameRate.numerator = "60061"),
  "zero fps": (s) => (s.composition.frameRate.numerator = "0"),
  "fractional dimension": (s) => (s.composition.width = 1.5),
  "nonfinite property": (s) => (s.tracks[0]!.clips[0]!.opacity = NaN),
  "unsafe property": (s) => (s.tracks[0]!.clips[0]!.volumeDb = Infinity),
  "unknown field": (s) => Object.assign(s, { payload: "unknown" }),
  "prototype pollution": (s) =>
    Object.defineProperty(s.tracks[0]!.clips[0]!, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    }),
};
for (const [name, mutate] of Object.entries(invalids))
  test(`invariants reject ${name}`, () => {
    const snapshot = fixture().toSnapshot();
    mutate(snapshot);
    assert.throws(() => Timeline.restore(snapshot));
  });
test("strict objects, arrays and caption/component/effect/transition variants reject malformed input", () => {
  for (const value of [null, [], new Date(), Object.create({ polluted: true })])
    assert.throws(() => Timeline.restore(value));
  assert.throws(() =>
    Track.restore({ id: id(10), timelineId: id(3), kind: "video", clips: 1, transitions: [] }),
  );
  assert.throws(() => new Caption(id(20), id(10), 5n, 5n, "word"));
  assert.throws(() => new Caption(id(20), id(10), 0n, 1n, " "));
  assert.throws(() => new Clip(id(20), id(10), 0n, 1n, { kind: "graphics" }));
  assert.throws(() => new Clip(id(20), id(10), 0n, 1n, { text: "bad" }));
  assert.throws(() => new Clip(id(20), id(10), 1n, 2n, { kind: "caption", text: "word" }));
  assert.throws(
    () => new Clip(id(20), id(10), 0n, 1n, { kind: "caption", text: "word", componentId: id(6) }),
  );
  assert.throws(() => new Clip(id(20), id(10), 0n, 1n, { componentId: id(6) }));
  assert.throws(() => new Clip(id(20), id(10), 0n, 1n, { effects: [new Effect(id(30), id(21))] }));
  assert.throws(() => new Effect(id(30), id(20), "unknown" as "gain"));
  assert.throws(() => new Effect(id(30), id(20), "gain", 13));
  assert.equal(new Effect(id(30), id(20), "gain", -6).value, -6);
  assert.throws(() => new Transition(id(30), id(20), id(20), "cut", 0n));
  assert.throws(() => new Transition(id(30), id(20), id(21), "cut", 1n));
  assert.throws(() => new Transition(id(30), id(20), id(21), "dissolve", 0n));
  const clip = new Clip(id(20), id(10), 0n, 100n);
  assert.throws(
    () =>
      new Track(
        id(10),
        id(3),
        "video",
        [clip],
        [new Transition(id(30), id(20), id(21), "cut", 0n)],
      ),
  );
  assert.throws(() => new Track(id(10), id(3), "video", [clip], [{} as Transition]));
  assert.throws(() => new Track(id(10), id(3), "video", [{} as Clip]));
  assert.throws(() => new Timeline(id(3), project.id, 0n, { tracks: [{} as Track] }));
});
test("project schema/version, Project invariants and project identity cannot be bypassed", () => {
  const doc = projectDocument(project, fixture());
  assert.throws(() => deserializeProject({ ...doc, schemaVersion: 2 }));
  assert.throws(() => deserializeProject({ ...doc, project: { ...doc.project, memberships: [] } }));
  assert.throws(() =>
    deserializeProject({ ...doc, timeline: { ...doc.timeline, projectId: id(9) } }),
  );
  assert.throws(() => serializeProject(project, new Timeline(id(3), id(9), 0n)));
  assert.throws(() => deserializeProject('{"__proto__":{"polluted":true}}'));
  assert.throws(() => deserializeProject("not-json"));
  const deleted = project.deleteProject(userId(id(2)), 1n);
  assert.deepEqual(deserializeProject(serializeProject(deleted, fixture())).project, deleted);
});
test("frame snapping uses rational absolute arithmetic, half ties go forward, very large times remain exact", () => {
  assert.equal(snapToFrame(250000n, frameRate(2n, 1n)), 500000n);
  assert.equal(snapToFrame(249999n, frameRate(2n, 1n)), 0n);
  assert.equal(frameTime(30000n, frameRate(30000n, 1001n)), 1001000000n);
  const huge = 900719925474099312345n;
  assert.equal(microseconds(String(huge)), huge);
  const s = fixture().toSnapshot();
  s.composition.durationUs = String(huge);
  s.sources[0]!.durationUs = String(huge);
  s.tracks[0]!.clips[0]!.outPoint = String(huge);
  assert.deepEqual(Timeline.restore(s).toSnapshot(), s);
  for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => microseconds(bad as unknown as string));
    assert.throws(() => frameIndex(bad as unknown as bigint));
    assert.throws(() => frameRate(bad as unknown as bigint, 1n));
  }
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10000000000000000n }),
      fc.constantFrom(frameRate(30n, 1n), frameRate(30000n, 1001n), frameRate(24000n, 1001n)),
      (us, fps) => {
        const snapped = snapToFrame(us, fps);
        assert.equal(snapToFrame(snapped, fps), snapped);
        assert.ok(
          (snapped > us ? snapped - us : us - snapped) * fps.numerator <=
            500000n * fps.denominator + fps.numerator,
        );
      },
    ),
    check,
  );
});

test("strict serialized optional values cannot acquire constructor defaults", () => {
  for (const field of ["opacity", "volumeDb", "timelineStartUs"]) {
    const s = fixture().toSnapshot();
    Object.assign(s.tracks[0]!.clips[0]!, { [field]: null });
    assert.throws(() => Timeline.restore(s));
  }
  const s = fixture().toSnapshot();
  Object.assign(s, { createdAt: 0 });
  assert.throws(() => Timeline.restore(s));
  assert.equal(
    Effect.create(new Effect(id(30), id(20)).id, new Clip(id(20), id(10), 0n, 1n).id).value,
    1,
  );
  assert.throws(() => new Transition(id(30), id(20), id(20).toUpperCase(), "cut", 0n));
  assert.ok(Object.isFrozen(trackKinds));
});
test("global graph IDs cannot collide across separate tracks and references are normalized", () => {
  const s = fixture().toSnapshot(),
    c = s.tracks[0]!.clips[0]!;
  s.tracks.push({ ...s.tracks[0]!, id: id(11), clips: [{ ...c, trackId: id(11), effects: [] }] });
  assert.throws(() => Timeline.restore(s));
  const t = fixture().toSnapshot();
  t.tracks[0]!.clips[0]!.effects.push({ ...t.tracks[0]!.clips[0]!.effects[0]! });
  assert.throws(() => Timeline.restore(t));
});
