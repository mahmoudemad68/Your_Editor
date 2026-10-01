import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MediaProbeError } from "@editagent/domain";
import { mapFfprobeDocument } from "./ffprobe-json.js";

const directory = path.resolve(__dirname, "../fixtures/ffprobe");

function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(directory, name), "utf8")) as unknown;
}

function clone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

test("recorded fixtures map to the expected technical metadata", () => {
  const normal = mapFfprobeDocument(load("normal.json"));
  assert.equal(normal.container, "MP4");
  assert.equal(normal.videoCodec, "h264");
  assert.equal(normal.audioCodec, "aac");
  assert.equal(normal.width, 320);
  assert.equal(normal.height, 240);
  assert.equal(normal.displayWidth, 320);
  assert.equal(normal.displayHeight, 240);
  assert.equal(normal.rotation, null);
  assert.deepEqual(normal.frameRate, { numerator: 25n, denominator: 1n });
  assert.equal(normal.frameRateMode, "constant");
  assert.equal(normal.duration, 1_000_000n);
  assert.equal(normal.colorSpace, null);
  assert.equal(normal.audioChannels, 1);
  assert.equal(normal.sampleRate, 48000);
  assert.equal(normal.streams.length, 2);

  const rotated = mapFfprobeDocument(load("rotated.json"));
  assert.equal(rotated.container, "MOV");
  assert.equal(rotated.width, 320);
  assert.equal(rotated.height, 240);
  assert.equal(rotated.displayWidth, 240);
  assert.equal(rotated.displayHeight, 320);
  assert.equal(rotated.rotation, 90);
  assert.equal(rotated.frameRateMode, "constant");
  assert.equal(rotated.duration, 1_000_000n);

  const vfr = mapFfprobeDocument(load("vfr.json"));
  assert.equal(vfr.container, "MP4");
  assert.equal(vfr.videoCodec, "h264");
  assert.equal(vfr.audioCodec, null);
  assert.equal(vfr.width, 160);
  assert.equal(vfr.height, 120);
  assert.deepEqual(vfr.frameRate, { numerator: 125n, denominator: 9n });
  assert.equal(vfr.frameRateMode, "variable");
  assert.equal(vfr.duration, 360_000n);
  assert.equal(vfr.audioChannels, null);
  assert.equal(vfr.sampleRate, null);

  const multi = mapFfprobeDocument(load("multi.json"));
  assert.equal(multi.frameRateMode, "constant");
  assert.deepEqual(multi.frameRate, { numerator: 25n, denominator: 1n });
  assert.equal(multi.audioChannels, 1);
  assert.equal(multi.sampleRate, 48000);
  assert.equal(multi.streams.length, 3);
  assert.equal(multi.streams[1]?.sampleRate, 48000);
  assert.equal(multi.streams[2]?.sampleRate, 44100);
  assert.equal(multi.duration, 1_000_000n);

  const audio = mapFfprobeDocument(load("audio.json"));
  assert.equal(audio.container, "WAV");
  assert.equal(audio.videoCodec, null);
  assert.equal(audio.audioCodec, "pcm_s16le");
  assert.equal(audio.width, null);
  assert.equal(audio.displayWidth, null);
  assert.equal(audio.frameRate, null);
  assert.equal(audio.frameRateMode, "unknown");
  assert.equal(audio.duration, 1_000_000n);
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.audioChannels, 1);

  const image = mapFfprobeDocument(load("image.json"));
  assert.equal(image.container, "PNG");
  assert.equal(image.videoCodec, "png");
  assert.equal(image.audioCodec, null);
  assert.equal(image.width, 64);
  assert.equal(image.height, 48);
  assert.equal(image.displayWidth, 64);
  assert.equal(image.displayHeight, 48);
  assert.equal(image.frameRateMode, "unknown");
  assert.equal(image.duration, null);
  assert.equal(image.colorSpace, "gbr");
  assert.deepEqual(image.frameRate, { numerator: 25n, denominator: 1n });
});

test("stream tags rotate a portrait display when side data is absent", () => {
  const document = clone(load("normal.json"));
  const streams = document["streams"] as Record<string, unknown>[];
  const video = streams[0];
  assert.ok(video);
  video["tags"] = { rotate: "90" };
  delete video["side_data_list"];
  const mapped = mapFfprobeDocument(document);
  assert.equal(mapped.rotation, 90);
  assert.equal(mapped.width, 320);
  assert.equal(mapped.height, 240);
  assert.equal(mapped.displayWidth, 240);
  assert.equal(mapped.displayHeight, 320);
});

test("a negative display-matrix rotation normalizes to 270 and wins over a tag", () => {
  const document = clone(load("normal.json"));
  const streams = document["streams"] as Record<string, unknown>[];
  const video = streams[0];
  assert.ok(video);
  video["tags"] = { rotate: "0" };
  video["side_data_list"] = [{ side_data_type: "Display Matrix", rotation: -90 }];
  const mapped = mapFfprobeDocument(document);
  assert.equal(mapped.rotation, 270);
  assert.equal(mapped.displayWidth, 240);
  assert.equal(mapped.displayHeight, 320);
});

test("variable frame rate uses timestamp deltas, not avg_frame_rate versus r_frame_rate", () => {
  const varied = clone(load("vfr.json"));
  const variedStreams = varied["streams"] as Record<string, unknown>[];
  const variedVideo = variedStreams[0];
  assert.ok(variedVideo);
  variedVideo["avg_frame_rate"] = "25/1";
  variedVideo["r_frame_rate"] = "25/1";
  assert.equal(mapFfprobeDocument(varied).frameRateMode, "variable");
  assert.deepEqual(mapFfprobeDocument(varied).frameRate, { numerator: 25n, denominator: 1n });

  const steady = clone(load("normal.json"));
  const steadyStreams = steady["streams"] as Record<string, unknown>[];
  const steadyVideo = steadyStreams[0];
  assert.ok(steadyVideo);
  steadyVideo["r_frame_rate"] = "30000/1001";
  const mapped = mapFfprobeDocument(steady);
  assert.equal(mapped.frameRateMode, "constant");
  assert.deepEqual(mapped.frameRate, { numerator: 25n, denominator: 1n });
});

test("optional metadata stays null instead of a fabricated codec, rate, or duration", () => {
  const unknown = clone(load("normal.json"));
  const streams = unknown["streams"] as Record<string, unknown>[];
  const video = streams[0];
  assert.ok(video);
  video["codec_name"] = "unknown";
  const format = unknown["format"] as Record<string, unknown>;
  delete format["duration"];
  const mapped = mapFfprobeDocument(unknown);
  assert.equal(mapped.videoCodec, null);
  assert.equal(mapped.duration, null);
  assert.equal(mapped.audioCodec, "aac");
});

test("malformed probe documents fail without a partial success", () => {
  assert.throws(
    () => mapFfprobeDocument(load("corrupt.json")),
    (error: unknown) => {
      return error instanceof MediaProbeError && error.code === "invalid_result";
    },
  );
  const denominator = clone(load("normal.json"));
  const streams = denominator["streams"] as Record<string, unknown>[];
  const video = streams[0];
  assert.ok(video);
  video["avg_frame_rate"] = "30000/0";
  assert.throws(
    () => mapFfprobeDocument(denominator),
    (error: unknown) => {
      return error instanceof MediaProbeError && error.code === "invalid_result";
    },
  );
  const rotation = clone(load("rotated.json"));
  const rotatedStreams = rotation["streams"] as Record<string, unknown>[];
  const rotatedVideo = rotatedStreams[0];
  assert.ok(rotatedVideo);
  rotatedVideo["side_data_list"] = [{ side_data_type: "Display Matrix", rotation: 45 }];
  assert.throws(
    () => mapFfprobeDocument(rotation),
    (error: unknown) => {
      return error instanceof MediaProbeError && error.code === "invalid_result";
    },
  );
});
