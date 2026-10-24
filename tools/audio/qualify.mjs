/** Bounded diagnostics; never selects new production thresholds or rewrites gold. */
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import {
  FFmpegAudioAnalyzer,
  DEFAULT_AUDIO_ANALYSIS_CONFIG,
} from "../../packages/media-core/dist/index.js";
import { evaluateAudio } from "./evaluate.mjs";
import { acousticAcceptance } from "./acceptance.mjs";

export async function qualifyAudio(root, executable = "ffmpeg") {
  const analyzer = new FFmpegAudioAnalyzer(DEFAULT_AUDIO_ANALYSIS_CONFIG, executable);
  const original = await evaluateAudio(root, analyzer);
  const acoustic = await acousticAcceptance(analyzer);
  const sweep = [];
  // Fixed, finite sensitivity experiment. NON_SPEECH scores cannot choose an acoustic threshold.
  for (const silenceNoiseDb of [-70, -60, -50, -40])
    for (const minimumSilenceUs of [100000n, 200000n]) {
      const result =
        silenceNoiseDb === -60 && minimumSilenceUs === 200000n
          ? original
          : await evaluateAudio(
              root,
              new FFmpegAudioAnalyzer(
                { ...DEFAULT_AUDIO_ANALYSIS_CONFIG, silenceNoiseDb, minimumSilenceUs },
                executable,
              ),
            );
      sweep.push({
        configuration: result.configuration,
        tpUs: result.tpUs,
        fpUs: result.fpUs,
        fnUs: result.fnUs,
        precision: result.precision,
        recall: result.recall,
        f1: result.f1,
        clips: result.clips.map((c) => ({
          sourceId: c.sourceId,
          ...c.scores,
          provenance: c.analysis.provenance,
        })),
      });
    }
  return {
    reportVersion: 1,
    role: "US204_CP2_CLASS_SEMANTICS_DIAGNOSTIC",
    labelClasses: {
      acoustic:
        "Known constructed zero-PCM gaps, minimum 200000us; not human-labelled natural audio",
      original:
        "Immutable Silero NON_SPEECH complement; may contain audible music/noise/quiet speech",
    },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    productionDefaultsChanged: false,
    CP2_STATUS: "NOT_MET",
    AUTOMATED_REMOVAL_QUALIFIED: false,
    original,
    acoustic,
    sweep,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--root")
      throw new Error("Usage: pnpm audio:qualify --root VERIFIED_DATASET_DIRECTORY");
    console.log(JSON.stringify(await qualifyAudio(process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
