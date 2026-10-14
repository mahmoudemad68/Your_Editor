import assert from "node:assert/strict";
import { test } from "node:test";
import { Timeline, parseCommand, replay } from "@editagent/domain";
import { ToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import {
  registerEditingTools,
  editingToolManifests,
  validateEditingParameters,
} from "./editing-tools.js";
import { ids, authority, MemoryAudit } from "./test-support.js";
const snapshot = {
  id: ids.timeline,
  projectId: ids.project,
  createdAt: "0",
  composition: {
    width: 64,
    height: 64,
    frameRate: { numerator: "30000", denominator: "1001" },
    durationUs: "2002000",
  },
  sources: [{ id: ids.tool, kind: "video" as const, durationUs: "2002000" }],
  tracks: [
    {
      id: ids.track,
      timelineId: ids.timeline,
      kind: "video" as const,
      transitions: [],
      clips: [
        {
          id: ids.caption,
          trackId: ids.track,
          kind: "video" as const,
          inPoint: "0",
          outPoint: "2002000",
          timelineStartUs: "0",
          sourceId: ids.tool,
          text: null,
          componentId: null,
          opacity: 1,
          volumeDb: 0,
          effects: [],
        },
      ],
    },
  ],
};
test("seven manifests preserve strict SDK registration and function-schema export", () => {
  const registry = registerEditingTools(new ToolRegistry(), authority);
  assert.equal(registry.discover().length, 7);
  assert.equal(registry.exportFunctions().length, 7);
  for (const m of editingToolManifests()) {
    assert.equal(m.version, "1.0.0");
    assert.equal(m.inputSchema.additionalProperties, false);
    assert.equal(m.outputSchema.additionalProperties, false);
  }
  assert.throws(() => editingToolManifests(-1));
});
test("trim and split produce frame-snapped replayable commands without mutating authoritative timeline", async () => {
  const timeline = Timeline.restore(snapshot),
    auth = { ...authority, timeline: async () => timeline };
  const executor = new ToolExecutor(
    registerEditingTools(new ToolRegistry(), auth),
    auth,
    new MemoryAudit(),
  );
  for (const [name, input] of [
    ["trim-video", { clipId: ids.caption, startUs: "300000", endUs: "1600000" }],
    ["split-video", { clipId: ids.caption, atUs: "1000000" }],
  ] as const) {
    const result = await executor.execute({
      name: `editing.${name}`,
      version: "1.0.0",
      callerId: ids.owner,
      projectId: ids.project,
      resource: { kind: "timeline", id: ids.timeline },
      input,
    });
    assert.equal(result.record.outcome, "succeeded");
    assert.equal(result.record.costMicros, 0);
    const cmd = parseCommand(result.commands[0]);
    const output = replay(timeline, { schemaVersion: 1, timelineId: timeline.id, commands: [cmd] });
    assert.deepEqual(timeline.toSnapshot(), snapshot);
    if (cmd.type === "SplitClip") {
      assert.equal(output.tracks[0]!.clips.length, 2);
      assert.equal(cmd.payload.atUs, "1001000");
    } else {
      assert.equal(cmd.type, "TrimClip");
      if (cmd.type !== "TrimClip") throw new Error("Unexpected command");
      assert.equal(cmd.payload.startUs, "300300");
      assert.equal(cmd.payload.endUs, "1601600");
    }
  }
});
test("editing tools reject hostile fields, wrong types, protocols and invalid timing before work", () => {
  for (const value of [
    { assetId: ids.tool, width: 64, height: 64, path: "/etc/passwd" },
    { assetId: "http://metadata", width: 64, height: 64 },
    { assetId: ids.tool, width: NaN, height: 64 },
    { assetId: ids.tool, width: "64", height: 64 },
    { assetId: ids.tool, width: -2, height: 64 },
  ])
    assert.throws(() => validateEditingParameters("resize_video", value));
  assert.throws(() =>
    validateEditingParameters("trim_video", {
      clipId: ids.caption,
      startUs: "1e3",
      endUs: "2000000",
    }),
  );
  assert.throws(() => validateEditingParameters("concat_clips", { clips: [] }));
  for (const time of ["0\n", "300000\r", "01", "-1", "NaN", "Infinity"])
    assert.throws(() =>
      validateEditingParameters("split_video", { clipId: ids.caption, atUs: time }),
    );
  for (const width of [1, 3, 63, 4097])
    assert.throws(() =>
      validateEditingParameters("resize_video", { assetId: ids.tool, width, height: 64 }),
    );
  assert.throws(() =>
    validateEditingParameters("concat_clips", {
      clips: [
        { assetId: ids.tool, startUs: "0", endUs: "1000000" },
        { assetId: ids.tool, startUs: "500000", endUs: "1500000" },
      ],
    }),
  );
  assert.throws(() =>
    validateEditingParameters("normalize_audio", {
      assetId: ids.tool,
      targetLufs: -23,
      truePeakDb: -1,
      loudnessRange: 7,
      filter: "movie=/etc/passwd",
    }),
  );
});
