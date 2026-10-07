import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const dir = path.resolve(import.meta.dirname, "../fixtures/media");
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
test("six LFS media fixtures are real binaries under 5 MB with verified metadata", () => {
  assert.equal(manifest.fixtures.length, 6);
  for (const fixture of manifest.fixtures) {
    const file = path.join(dir, fixture.file),
      bytes = readFileSync(file);
    assert.ok(bytes.length < 5000000);
    assert.equal(bytes.length, fixture.bytes);
    assert.equal(
      bytes.subarray(0, 43).toString().startsWith("version https://git-lfs.github.com/spec/v1"),
      false,
      "LFS objects must be checked out",
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
    if (fixture.expected) {
      const data = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
          { encoding: "utf8" },
        ),
      );
      const v = data.streams.find((s) => s.codec_type === "video");
      assert.equal(v.codec_name, fixture.expected.codec);
      assert.equal(v.width, fixture.expected.width);
      assert.equal(v.height, fixture.expected.height);
      assert.equal(v.avg_frame_rate, fixture.expected.frameRate);
      assert.equal(v.r_frame_rate, fixture.expected.nominalFrameRate);
      assert.equal(
        data.streams.find((s) => s.codec_type === "audio")?.codec_name ?? null,
        fixture.expected.audioCodec,
      );
      assert.equal(
        v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
          Number(v.tags?.rotate ?? 0),
        fixture.expected.rotation,
      );
      assert.equal(Math.round(Number(data.format.duration) * 1000000), fixture.expected.durationUs);
    } else assert.throws(() => execFileSync("ffprobe", ["-v", "quiet", file], { stdio: "pipe" }));
  }
});
