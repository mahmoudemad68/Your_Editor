export const ASR_DEFAULTS = Object.freeze({
  model: "small",
  device: "cpu",
  compute_type: "int8",
  cpu_fallback: true,
  cpu_threads: 2,
  beam_size: 5,
  timeout_ms: 600000,
  chunk_us: 24000000,
  overlap_us: 2000000,
  speech_threshold: 0.5,
  negative_threshold: 0.35,
  min_silence_ms: 200,
  speech_padding_ms: 100,
  seed: 0,
});
export const VAD_DEFAULTS = Object.freeze({
  speech_threshold: 0.5,
  negative_threshold: 0.35,
  min_speech_us: 100000,
  min_silence_us: 200000,
  padding_us: 100000,
  timeout_ms: 120000,
});
export type AnalysisConfiguration = {
  asr: typeof ASR_DEFAULTS;
  version: "us210-v1";
  audioVersion: "us204-v1";
  vadVersion: "us202-v1";
  schemaVersion: "1.1.0";
  modelRevision: string;
  fasterWhisperVersion: "1.2.1";
  asrAlgorithm: "ct2-contextual-v11";
  vad: typeof VAD_DEFAULTS;
};

function parseSetting(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Operator values may accidentally contain credentials; never echo them.
    throw new Error("Invalid analysis deployment configuration.");
  }
}

/** Deployment values only; no caller may specify paths, modules, URLs or executable code. */
export function analysisConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): AnalysisConfiguration {
  const asr: Record<string, unknown> = { ...ASR_DEFAULTS };
  for (const [key, value] of Object.entries(asr)) {
    const raw = env[`EDITAGENT_ASR_${key.toUpperCase()}`];
    if (raw === undefined) continue;
    asr[key] = typeof value === "string" ? raw : parseSetting(raw);
  }
  if (
    !["tiny", "small"].includes(String(asr["model"])) ||
    !["cpu", "cuda"].includes(String(asr["device"])) ||
    !["int8", "float16", "int8_float16"].includes(String(asr["compute_type"])) ||
    typeof asr["cpu_fallback"] !== "boolean"
  )
    throw new Error("Invalid analysis deployment configuration.");
  for (const [key, lo, hi] of [
    ["cpu_threads", 1, 8],
    ["beam_size", 1, 10],
    ["timeout_ms", 1, 600000],
    ["chunk_us", 5000000, 30000000],
    ["overlap_us", 0, 5000000],
    ["min_silence_ms", 1, 10000],
    ["speech_padding_ms", 0, 1000],
    ["seed", 0, 2147483647],
  ] as const) {
    const value = asr[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < lo || value > hi)
      throw new Error("Invalid analysis deployment configuration.");
  }
  const speech = asr["speech_threshold"],
    negative = asr["negative_threshold"];
  if (
    typeof speech !== "number" ||
    typeof negative !== "number" ||
    !Number.isFinite(speech) ||
    !Number.isFinite(negative) ||
    !(0 < negative && negative < speech && speech < 1) ||
    Number(asr["chunk_us"]) + 2 * Number(asr["overlap_us"]) > 30000000 ||
    Number(asr["overlap_us"]) * 2 >= Number(asr["chunk_us"]) ||
    (asr["device"] === "cpu" && asr["compute_type"] !== "int8")
  )
    throw new Error("Invalid analysis deployment configuration.");
  const vad: Record<string, number> = { ...VAD_DEFAULTS };
  for (const key of Object.keys(vad)) {
    const raw = env[`EDITAGENT_VAD_${key.toUpperCase()}`];
    if (raw !== undefined) vad[key] = parseSetting(raw) as number;
  }
  if (
    !Object.values(vad).every((v) => typeof v === "number" && Number.isFinite(v)) ||
    !(
      0 < vad["negative_threshold"]! &&
      vad["negative_threshold"]! < vad["speech_threshold"]! &&
      vad["speech_threshold"]! < 1
    )
  )
    throw new Error("Invalid analysis deployment configuration.");
  for (const [key, lo, hi] of [
    ["min_speech_us", 1, 1800000000],
    ["min_silence_us", 1, 1800000000],
    ["padding_us", 0, 1000000],
    ["timeout_ms", 1, 600000],
  ] as const)
    if (!Number.isSafeInteger(vad[key]) || vad[key]! < lo || vad[key]! > hi)
      throw new Error("Invalid analysis deployment configuration.");
  return {
    vad: vad as typeof VAD_DEFAULTS,
    schemaVersion: "1.1.0",
    modelRevision:
      asr["model"] === "tiny"
        ? "d90ca5fe260221311c53c58e660288d3deb8d356"
        : "536b0662742c02347bc0e980a01041f333bce120",
    fasterWhisperVersion: "1.2.1",
    asrAlgorithm: "ct2-contextual-v11",
    asr: asr as typeof ASR_DEFAULTS,
    version: "us210-v1",
    audioVersion: "us204-v1",
    vadVersion: "us202-v1",
  };
}
