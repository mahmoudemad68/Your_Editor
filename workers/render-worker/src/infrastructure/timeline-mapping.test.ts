import assert from "node:assert/strict";
import { test } from "node:test";
import { frameTime, frameRate } from "@editagent/domain";
import { firstFrameAt, mapTimeline } from "../application/timeline-mapping.js";
import type { TimelineInput } from "../application/ports.js";
import { parseRenderInput } from "./contract.js";
const id = (n: number) => `018fe277-6ec0-7000-8000-${String(n).padStart(12, "0")}`;
export function timelineFixture(): TimelineInput {
  const clip = (
    n: number,
    start: string,
    end: string,
    kind: "video" | "caption" | "graphics" = "video",
  ) => ({
    id: id(n),
    trackId: id(3),
    kind,
    inPoint: "0",
    outPoint: end,
    timelineStartUs: start,
    sourceId: kind === "video" ? id(4) : null,
    text: kind === "caption" ? "مرحبا 👋" : null,
    componentId: kind === "graphics" ? id(9) : null,
    opacity: 1,
    volumeDb: 0,
    effects: [],
  });
  return {
    schemaVersion: 1,
    renderVersion: "a".repeat(64),
    compositionId: "TimelineV1",
    correlationId: "timeline-test",
    props: {
      background: "#000000",
      captionStyle: { color: "#ffffff", background: "#000000", fontSize: 24, direction: "auto" },
      components: [],
      timeline: {
        id: id(1),
        projectId: id(2),
        createdAt: "0",
        composition: {
          width: 320,
          height: 180,
          frameRate: { numerator: "30", denominator: "1" },
          durationUs: "2000000",
        },
        sources: [{ id: id(4), kind: "video", durationUs: "3000000" }],
        tracks: [
          {
            id: id(3),
            timelineId: id(1),
            kind: "video",
            clips: [clip(5, "0", "1000000"), clip(6, "1000000", "1000000")],
            transitions: [
              { id: id(7), fromClipId: id(5), toClipId: id(6), kind: "cut", durationUs: "0" },
            ],
          },
        ],
      },
    },
  };
}
test("absolute rounded clock inverts domain frame timestamps at integer and fractional rates without drift", () => {
  for (const r of [frameRate(30n, 1n), frameRate(24n, 1n), frameRate(30000n, 1001n)])
    for (let n = 0n; n <= 100000n; n += 137n) {
      const t = frameTime(n, r);
      assert.equal(firstFrameAt(t, r), Number(n));
      if (t > 0n) assert.equal(firstFrameAt(t - 1n, r), Number(n));
      assert.equal(firstFrameAt(t + 1n, r), Number(n + 1n));
    }
  assert.equal(firstFrameAt(66667n, frameRate(30n, 1n)), 2);
});
test("cut maps half-open touching clips and source offsets exactly", () => {
  const p = timelineFixture();
  assert.deepEqual(parseRenderInput(p), p);
  p.props.timeline.tracks[0]!.clips[1]!.inPoint = "1000000";
  p.props.timeline.tracks[0]!.clips[1]!.outPoint = "2000000";
  const mapped = mapTimeline(p);
  assert.equal(mapped.timing.durationInFrames, 60);
  assert.deepEqual(
    mapped.clips.map((c) => [c.from, c.durationInFrames, c.sourceOffsetFrames]),
    [
      [0, 30, 0],
      [30, 30, 30],
    ],
  );
});
test("dissolve holds outgoing visual only and fades incoming without shifting source timing", () => {
  const p = timelineFixture();
  const t = p.props.timeline.tracks[0]!.transitions[0]!;
  t.kind = "dissolve";
  t.durationUs = "200000";
  const m = mapTimeline(p);
  assert.equal(m.clips[0]!.holdFrames, 6);
  assert.equal(m.clips[1]!.fadeInFrames, 6);
  assert.equal(m.clips[1]!.from, 30);
});
test("strict factory rejects unknown/missing/duplicate executable graphics and invalid captions before browser", () => {
  const p = timelineFixture(),
    track = p.props.timeline.tracks[0]!;
  track.transitions = [];
  track.kind = "graphics";
  track.clips = [{ ...track.clips[0]!, kind: "graphics", sourceId: null, componentId: id(9) }];
  assert.throws(() => parseRenderInput(p));
  p.props.components = [{ componentId: id(9), type: "solid-v1", props: { color: "#ffffff" } }];
  assert.doesNotThrow(() => parseRenderInput(p));
  for (const type of ["evil", "../../code", "file:///etc/passwd"])
    assert.throws(() =>
      parseRenderInput({
        ...p,
        props: { ...p.props, components: [{ ...p.props.components[0], type }] },
      }),
    );
  assert.throws(() =>
    parseRenderInput({
      ...p,
      props: { ...p.props, components: [...p.props.components, ...p.props.components] },
    }),
  );
  track.kind = "caption";
  track.clips[0] = { ...track.clips[0]!, kind: "caption", componentId: null, text: "مرحبا 👋" };
  assert.doesNotThrow(() => parseRenderInput(p));
  for (const text of ["\ud800", " ", "\udfff"])
    assert.throws(() =>
      parseRenderInput({
        ...p,
        props: {
          ...p.props,
          timeline: {
            ...p.props.timeline,
            tracks: [{ ...track, clips: [{ ...track.clips[0], text }] }],
          },
        },
      }),
    );
});
test("renderer rejects collapsed frames, illegal timelines, excessive assets and unsupported timing", () => {
  for (const mutate of [
    (p: TimelineInput) => {
      p.props.timeline.tracks[0]!.clips[0]!.outPoint = "1";
    },
    (p: TimelineInput) => {
      p.props.timeline.tracks[0]!.clips[1]!.timelineStartUs = "999999";
    },
    (p: TimelineInput) => {
      p.props.timeline.composition.frameRate = {
        numerator: "6000000000000",
        denominator: "200000000000",
      };
    },
    (p: TimelineInput) => {
      p.props.timeline.composition.width = 4098;
    },
  ]) {
    const p = timelineFixture();
    mutate(p);
    assert.throws(() => parseRenderInput(p));
  }
});
test("all canonical track kinds map independently with stable layer order and bounded gain/opacity", () => {
  const p = timelineFixture(),
    base = p.props.timeline.tracks[0]!.clips[0]!;
  p.props.components = [{ componentId: id(9), type: "solid-v1", props: { color: "#ffffff" } }];
  p.props.timeline.tracks = (["video", "overlay", "graphics", "caption", "audio"] as const).map(
    (kind, i) => ({
      id: id(10 + i),
      timelineId: p.props.timeline.id,
      kind,
      transitions: [],
      clips: [
        {
          ...base,
          id: id(20 + i),
          trackId: id(10 + i),
          kind,
          sourceId: ["video", "overlay", "audio"].includes(kind) ? base.sourceId : null,
          text: kind === "caption" ? "مرحبا" : null,
          componentId: kind === "graphics" ? id(9) : null,
          opacity: 0.5,
          volumeDb: 12,
          effects: [{ id: id(30 + i), clipId: id(20 + i), kind: "gain", value: 12 }],
        },
      ],
    }),
  );
  assert.doesNotThrow(() => parseRenderInput(p));
  const mapped = mapTimeline(p);
  assert.deepEqual(
    mapped.clips.map((c) => c.layer),
    [0, 1, 2, 3, 4],
  );
  assert.ok(mapped.clips.every((c) => c.opacity === 0.5 && c.volume === Math.pow(10, 12 / 20)));
});
