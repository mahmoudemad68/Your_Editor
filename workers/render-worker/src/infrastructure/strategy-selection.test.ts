import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEngine, SelectingRenderStrategy } from "../application/strategy-selection.js";
import { timelineFixture } from "./timeline-mapping.test.js";
test("automatic selector restores canonical state and only admits supported frame-grid cuts", () => {
  const fixture = timelineFixture();
  assert.equal(renderEngine(fixture), "ffmpeg");
  for (const property of [
    "caption",
    "graphics",
    "effect",
    "dissolve",
    "off-grid",
    "off-grid-end",
    "many-clips",
  ]) {
    const p = structuredClone(fixture),
      t = p.props.timeline.tracks[0]!;
    if (property === "caption" || property === "graphics") {
      t.kind = property;
      t.transitions = [];
      t.clips = t.clips.slice(0, 1);
      const c = t.clips[0]!;
      c.kind = property;
      c.sourceId = null;
      if (property === "caption") c.text = "مرحبا";
      else c.componentId = "018fe277-6ec0-7000-8000-000000000009";
    }
    if (property === "effect")
      t.clips[0]!.effects = [
        {
          id: "018fe277-6ec0-7000-8000-000000000099",
          clipId: t.clips[0]!.id,
          kind: "opacity",
          value: 0.5,
        },
      ];
    if (property === "dissolve") {
      t.transitions[0]!.kind = "dissolve";
      t.transitions[0]!.durationUs = "200000";
    }
    if (property === "off-grid") {
      t.transitions = [];
      t.clips[1]!.timelineStartUs = "1000001";
      p.props.timeline.composition.durationUs = "2000001";
    }
    if (property === "many-clips") {
      t.transitions = [];
      t.clips = Array.from({ length: 9 }, (_, i) => ({
        ...t.clips[0]!,
        id: `018fe277-6ec0-7000-8000-${String(100 + i).padStart(12, "0")}`,
        timelineStartUs: String(i * 1000000),
      }));
      p.props.timeline.composition.durationUs = "9000000";
    }
    if (property === "off-grid-end") {
      t.transitions = [];
      t.clips = t.clips.slice(0, 1);
      Object.assign(t.clips[0]!, {
        inPoint: "333333",
        outPoint: "666667",
        timelineStartUs: "100000",
      });
    }
    assert.equal(renderEngine(p), "remotion", property);
  }
  const bad = structuredClone(fixture);
  bad.props.timeline.tracks[0]!.clips[0]!.outPoint = "0";
  assert.throws(() => renderEngine(bad));
});
test("selector delegates validated cuts and retains shared discard/ownership contract", async () => {
  const called: string[] = [];
  const adapter = (name: string) => ({
    render: async () => {
      called.push(name);
      return {
        objectKey: "owned",
        sha256: "a".repeat(64),
        byteSize: 1,
        renderVersion: "b".repeat(64),
        inputSha256: "c".repeat(64),
      };
    },
    discard: async () => {
      called.push(`discard-${name}`);
    },
  });
  const s = new SelectingRenderStrategy(adapter("ffmpeg"), adapter("remotion")),
    p = timelineFixture();
  const result = await s.render(
    p,
    p.props.timeline.projectId,
    "unused",
    new AbortController().signal,
    () => {},
  );
  await s.discard(result);
  assert.deepEqual(called, ["ffmpeg", "discard-remotion"]);
});
