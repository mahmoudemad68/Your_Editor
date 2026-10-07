import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaAsset, instant, MEDIA_REJECTION_MESSAGES } from "@editagent/domain";
import { MediaRejected, assertValidatedMedia } from "../application/validate-media.js";
import {
  parseValidationPolicy,
  validationPolicySignature,
} from "../application/validation-policy.js";
import {
  SandboxedMediaValidator,
  assertValidationSandbox,
  SANDBOX_PATH,
  validateMetadata,
} from "./media-validator.js";
const policy = parseValidationPolicy({});
const ffmpeg = process.env["FFMPEG_PATH"] ?? "ffmpeg",
  ffprobe = process.env["FFPROBE_PATH"] ?? "ffprobe";
const abort = () => new AbortController().signal;
function rejected(code: string) {
  return (e: unknown) => e instanceof MediaRejected && e.code === code;
}
function fixture(file: string, args: string[] = []) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=128x96:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-c:a",
      "aac",
      ...args,
      file,
    ],
    { timeout: 30000, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
}

test("US-127 security policy configuration is bounded, deterministic and fail closed", () => {
  for (const [key, value] of Object.entries({
    MAX_DURATION_SECONDS: "1801",
    MAX_BYTES: "4294967297",
    MAX_STREAMS: "0",
    MEMORY_BYTES: "unlimited",
    CPU_SECONDS: "0",
    DECODE_TIMEOUT_MS: "999999",
  }))
    assert.throws(() => parseValidationPolicy({ [`MEDIA_VALIDATION_${key}`]: value }));
  assert.equal(
    validationPolicySignature(policy),
    validationPolicySignature(parseValidationPolicy({})),
  );
  assert.notEqual(
    validationPolicySignature(policy),
    validationPolicySignature({ ...policy, maxStreams: 7 }),
  );
  const asset = MediaAsset.create({
    id: "01900000-0000-7000-8000-000000000001" as never,
    projectId: "01900000-0000-7000-8000-000000000002" as never,
    kind: "video",
    createdAt: instant(1n),
  });
  assert.equal(asset.validation.status, "pending");
  assert.throws(() => assertValidatedMedia(asset, validationPolicySignature(policy), abort()));
  assert.throws(() =>
    MediaAsset.restore({
      ...asset.toSnapshot(),
      validation: {
        status: "rejected",
        policySignature: "a".repeat(64),
        sourceSha256: "b".repeat(64),
        checkedAt: 1n,
        rejectionCode: "http://attacker/secret",
      },
    }),
  );
  for (const message of Object.values(MEDIA_REJECTION_MESSAGES))
    assert.doesNotMatch(message, /https?:|\/tmp|ffmpeg|password|token/i);
});

test("US-127 full metadata allowlists and limits reject deterministically before decode", () => {
  const base = {
    format: { format_name: "mov,mp4", duration: "1", bit_rate: "100000" },
    streams: [{ codec_type: "video", codec_name: "h264", width: 128, height: 96 }],
  };
  const cases: [string, unknown, number][] = [
    ["duration_limit_exceeded", { ...base, format: { ...base.format, duration: "1801" } }, 100],
    [
      "resolution_limit_exceeded",
      { ...base, streams: [{ ...base.streams[0], width: 100000 }] },
      100,
    ],
    ["stream_count_limit_exceeded", { ...base, streams: Array(9).fill(base.streams[0]) }, 100],
    ["unsupported_codec", { ...base, streams: [{ ...base.streams[0], codec_name: "mpeg4" }] }, 100],
    [
      "unsupported_codec",
      { ...base, streams: [...base.streams, { codec_type: "audio", codec_name: "mp3" }] },
      100,
    ],
    ["unsupported_container", { ...base, format: { ...base.format, format_name: "avi" } }, 100],
    ["invalid_metadata", { ...base, format: { ...base.format, duration: "NaN" } }, 100],
    ["invalid_metadata", { ...base, streams: [{ ...base.streams[0], width: -1 }] }, 100],
    ["bitrate_limit_exceeded", { ...base, format: { ...base.format, bit_rate: "100000001" } }, 100],
    ["bitrate_limit_exceeded", base, 20000000],
  ];
  for (const [code, document, size] of cases)
    assert.throws(() => validateMetadata(document, size, policy, "mov"), rejected(code), code);
  validateMetadata(base, 100, policy, "mov");
});

test(
  "US-127 real hostile bytes, supported/disguised containers and zero outbound canary",
  { timeout: 120000 },
  async (t) => {
    assertValidationSandbox();
    const dir = await mkdtemp(path.join(tmpdir(), "us127-fixtures-"));
    const validator = new SandboxedMediaValidator(policy, ffmpeg, ffprobe);
    let requests = 0;
    const canary = createServer((_req, res) => {
      requests++;
      res.end("unexpected");
    });
    await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
    const address = canary.address();
    assert.ok(address && typeof address !== "string");
    try {
      await fetch(`http://127.0.0.1:${address.port}/control`);
      assert.equal(requests, 1);
      requests = 0;
      const normal = path.join(dir, "normal.mp4");
      fixture(normal);
      console.log(
        "US127_RUNTIME",
        spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0],
      );
      for (const [name, opts] of [
        ["normal.mp4", []],
        ["disguised.exe", ["-f", "mp4"]],
        ["valid.mov", ["-f", "mov"]],
        ["valid.mkv", ["-f", "matroska"]],
        ["valid.webm", ["-c:v", "libvpx-vp9", "-c:a", "libopus", "-f", "webm"]],
      ] as [string, string[]][]) {
        await t.test(`accepted bytes ${name}`, async () => {
          const f = path.join(dir, name);
          if (name !== "normal.mp4") fixture(f, opts);
          assert.equal(
            (await validator.validate(f, abort())).streams[0]?.codecName,
            name.endsWith("webm") ? "vp9" : "h264",
          );
        });
      }
      const bytes = await readFile(normal);
      for (const [name, data, code] of [
        ["empty.mp4", Buffer.alloc(0), "empty_media"],
        ["truncated.mp4", bytes.subarray(0, bytes.length - 128), "corrupt_media"],
        ["random.mp4", Buffer.from("this is not media"), "invalid_signature"],
        ["unsupported.avi", Buffer.from("RIFFxxxxxxxxAVI "), "unsupported_container"],
        [
          "remote.mp4",
          Buffer.from(
            `#EXTM3U\n#EXT-X-TARGETDURATION:1\nhttp://127.0.0.1:${address.port}/private.ts\n`,
          ),
          "unsafe_external_reference",
        ],
        [
          "https.mp4",
          Buffer.from("#EXTM3U\nhttps://evil.example/internal\n"),
          "unsafe_external_reference",
        ],
        [
          "concat.mp4",
          Buffer.from(`ffconcat version 1.0\nfile '/etc/passwd'\n`),
          "unsafe_external_reference",
        ],
      ] as [string, Buffer, string][]) {
        await t.test(name, async () => {
          const f = path.join(dir, name);
          await writeFile(f, data);
          await assert.rejects(validator.validate(f, abort()), rejected(code));
        });
      }
      const external = Buffer.from(bytes);
      const dref = external.indexOf(Buffer.from("dref"));
      assert.ok(dref > 0);
      external.writeUInt32BE(0, dref + 20);
      await writeFile(path.join(dir, "external.mov"), external);
      await assert.rejects(
        validator.validate(path.join(dir, "external.mov"), abort()),
        rejected("unsafe_external_reference"),
      );
      const unsupportedVideo = path.join(dir, "unsupported-video.mp4");
      fixture(unsupportedVideo, ["-c:v", "mpeg4"]);
      await assert.rejects(
        validator.validate(unsupportedVideo, abort()),
        rejected("unsupported_codec"),
      );
      const unsupportedAudio = path.join(dir, "unsupported-audio.mp4");
      fixture(unsupportedAudio, ["-c:a", "libmp3lame"]);
      await assert.rejects(
        validator.validate(unsupportedAudio, abort()),
        rejected("unsupported_codec"),
      );
      const huge = path.join(dir, "huge-width.mp4");
      const encoded = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=8192x16:rate=1:duration=1",
          "-c:v",
          "libx264",
          "-threads",
          "2",
          huge,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(encoded.status, 0, encoded.stderr);
      await assert.rejects(
        validator.validate(huge, abort()),
        rejected("resolution_limit_exceeded"),
      );
      const long = path.join(dir, "long-timeline.mp4");
      const stretched = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=128x96:rate=1:duration=2",
          "-vf",
          "setpts=PTS*1801",
          "-fps_mode",
          "vfr",
          "-c:v",
          "libx264",
          "-threads",
          "2",
          long,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(stretched.status, 0, stretched.stderr);
      await assert.rejects(validator.validate(long, abort()), rejected("duration_limit_exceeded"));
      const many = path.join(dir, "many-streams.mp4");
      const multiple = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-i",
          normal,
          ...Array.from({ length: 9 }, () => ["-map", "0:v:0"]).flat(),
          "-c",
          "copy",
          many,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(multiple.status, 0, multiple.stderr);
      await assert.rejects(
        validator.validate(many, abort()),
        rejected("stream_count_limit_exceeded"),
      );
      const tiny = new SandboxedMediaValidator(
        { ...policy, maxBytes: bytes.length - 1 },
        ffmpeg,
        ffprobe,
      );
      await assert.rejects(tiny.validate(normal, abort()), rejected("file_size_limit_exceeded"));
      const short = new SandboxedMediaValidator(
        { ...policy, maxDurationSeconds: 0.1 },
        ffmpeg,
        ffprobe,
      );
      await assert.rejects(short.validate(normal, abort()), rejected("duration_limit_exceeded"));
      const small = new SandboxedMediaValidator({ ...policy, maxPixels: 100 }, ffmpeg, ffprobe);
      await assert.rejects(small.validate(normal, abort()), rejected("resolution_limit_exceeded"));
      const streams = new SandboxedMediaValidator({ ...policy, maxStreams: 1 }, ffmpeg, ffprobe);
      await assert.rejects(
        streams.validate(normal, abort()),
        rejected("stream_count_limit_exceeded"),
      );
      const rate = new SandboxedMediaValidator({ ...policy, maxBitrate: 1000 }, ffmpeg, ffprobe);
      await assert.rejects(rate.validate(normal, abort()), rejected("bitrate_limit_exceeded"));
      assert.equal(requests, 0);
      console.log("REMOTE_HLS_CANARY_REQUESTS", requests);
      assert.equal(
        (await readdir(dir)).filter((x) => x.startsWith("editagent-validation-")).length,
        0,
      );
    } finally {
      await new Promise<void>((r, j) => canary.close((e) => (e ? j(e) : r())));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "US-127 kernel sandbox enforces filesystem/network/CPU/memory limits and reaps child",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "us127-boundaries-"));
    try {
      const c = path.join(dir, "test.c"),
        exe = path.join(dir, "test"),
        input = path.join(dir, "input");
      await writeFile(input, "trusted staged bytes");
      await writeFile(
        c,
        `#include <stdlib.h>\n#include <stdio.h>\n#include <fcntl.h>\n#include <unistd.h>\n#include <sys/socket.h>\n#include <errno.h>\nint main(int c,char**v){if(c==2&&v[1][0]=='c'){printf("%d\\n",getpid());fflush(stdout);volatile unsigned long x=0;for(;;)x++;}if(c==2&&v[1][0]=='m'){return malloc(512UL*1024*1024)==NULL?0:8;}int a=open(v[1],O_RDONLY),b=open("/etc/passwd",O_RDONLY),s=socket(AF_INET,SOCK_STREAM,0);return a>=0&&b<0&&s<0?0:9;}\n`,
      );
      const compiled = spawnSync("cc", [c, "-O2", "-o", exe], { encoding: "utf8" });
      assert.equal(compiled.status, 0, compiled.stderr);
      const run = (args: string[]) =>
        spawnSync(
          SANDBOX_PATH,
          ["1", "134217728", "1048576", input, "-", exe, "--", exe, ...args],
          { timeout: 10000, encoding: "utf8" },
        );
      assert.equal(run([input]).status, 0);
      assert.equal(run(["memory"]).status, 0);
      const cpu = run(["cpu"]);
      assert.ok(cpu.status === 152 || cpu.status === 137, JSON.stringify(cpu));
      assert.equal(cpu.error, undefined);
      const pid = Number(cpu.stdout.trim());
      assert.ok(pid > 0);
      assert.throws(() => process.kill(pid, 0));
      const active = spawn(
        SANDBOX_PATH,
        ["10", "134217728", "1048576", input, "-", exe, "--", exe, "cpu"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const started = await new Promise<number>((resolve, reject) => {
        active.stdout.once("data", (b) => resolve(Number(b.toString().trim())));
        active.once("error", reject);
      });
      const exited = new Promise<void>((resolve) => active.once("close", () => resolve()));
      active.kill("SIGTERM");
      await exited;
      assert.throws(() => process.kill(started, 0));
      const busySource = path.join(dir, "busy.c"),
        busy = path.join(dir, "busy");
      await writeFile(busySource, "int main(void){volatile unsigned long x=0;for(;;)x++;}\n");
      assert.equal(spawnSync("cc", [busySource, "-O2", "-o", busy]).status, 0);
      const mp4 = path.join(dir, "timeout.mp4");
      fixture(mp4);
      await assert.rejects(
        new SandboxedMediaValidator({ ...policy, probeTimeoutMs: 100 }, ffmpeg, busy).validate(
          mp4,
          abort(),
        ),
        rejected("resource_limit_exceeded"),
      );
      const cancelling = new AbortController();
      const timer = setTimeout(() => cancelling.abort(new Error("test cancellation")), 100);
      try {
        await assert.rejects(
          new SandboxedMediaValidator(policy, ffmpeg, busy).validate(mp4, cancelling.signal),
          /test cancellation/,
        );
      } finally {
        clearTimeout(timer);
      }
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        new SandboxedMediaValidator(policy, ffmpeg, ffprobe).validate(input, cancelled.signal),
      );
      assertValidationSandbox();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
