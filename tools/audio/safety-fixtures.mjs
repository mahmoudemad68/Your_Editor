/** Signal controls and licensed speech adaptations; no natural acoustic gold is invented. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function wav(rate, channels, samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(samples[i], 44 + i * 2);
  return {
    bytes,
    sha256: digest(bytes),
    durationUs: (BigInt(samples.length / channels) * 1000000n) / BigInt(rate),
  };
}
export function safetyFixtures() {
  const result = [];
  for (const id of [
    "music-chord",
    "ambient-noise",
    "antiphase-stereo-music",
    "subthreshold-music",
  ]) {
    const channels = id === "antiphase-stereo-music" ? 2 : 1;
    const samples = new Int16Array(48000 * 2 * channels);
    let seed = 1;
    for (let n = 0; n < 48000 * 2; n++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const chord = [220, 275, 330].reduce(
        (s, hz) => s + Math.sin((2 * Math.PI * hz * n) / 48000),
        0,
      );
      const value =
        id === "ambient-noise"
          ? (seed & 1 ? 1 : -1) * (128 + ((seed >>> 16) % 2048))
          : Math.round(chord * (id === "subthreshold-music" ? 8 : 1024));
      samples[n * channels] = value;
      if (channels === 2) samples[n * channels + 1] = -value;
    }
    result.push({
      id,
      role: "CONSTRUCTED_SIGNAL_CONTROL",
      ...wav(48000, channels, samples),
      expectsWholeClipAcousticSilence: id === "subthreshold-music",
    });
  }
  const root = new URL("../../tests/fixtures/asr/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  for (const name of ["en.wav", "ar.wav"]) {
    const parent = manifest.fixtures.find((f) => f.file === name);
    const original = readFileSync(fileURLToPath(new URL(name, root)));
    if (!parent || digest(original) !== parent.sha256)
      throw new Error("Licensed speech fixture identity changed.");
    let data, rate, channels, width;
    if (original.toString("ascii", 0, 4) !== "RIFF" || original.toString("ascii", 8, 12) !== "WAVE")
      throw new Error("Invalid PCM fixture.");
    for (let at = 12; at + 8 <= original.length;) {
      const length = original.readUInt32LE(at + 4),
        tag = original.toString("ascii", at, at + 4);
      if (at + 8 + length > original.length) throw new Error("Truncated PCM fixture.");
      if (tag === "fmt ") {
        if (length < 16 || original.readUInt16LE(at + 8) !== 1) throw new Error("PCM16 required.");
        channels = original.readUInt16LE(at + 10);
        rate = original.readUInt32LE(at + 12);
        width = original.readUInt16LE(at + 22);
      }
      if (tag === "data") data = original.subarray(at + 8, at + 8 + length);
      at += 8 + length + (length % 2);
    }
    if (
      !data ||
      channels !== 1 ||
      rate !== 16000 ||
      width !== 16 ||
      data.length > rate * 10 * 2 ||
      data.length % 2
    )
      throw new Error("Unexpected speech fixture format.");
    const samples = new Int16Array(data.length / 2);
    let peak = 0;
    for (let n = 0; n < samples.length; n++)
      peak = Math.max(peak, Math.abs(data.readInt16LE(n * 2)));
    if (!peak) throw new Error("Speech fixture is empty.");
    for (let n = 0; n < samples.length; n++)
      samples[n] = Math.round((data.readInt16LE(n * 2) * 16) / peak);
    result.push({
      id: `subthreshold-${parent.language}-speech`,
      role: "ATTENUATED_LICENSED_SPEECH_RISK_PROBE",
      parentSha256: parent.sha256,
      sourceId: parent.sourceId,
      adaptation:
        "Peak scaled to 16 PCM16 units; no words/times or natural acoustic labels inferred",
      expectsWholeClipAcousticSilence: true,
      ...wav(rate, channels, samples),
    });
  }
  return result;
}
