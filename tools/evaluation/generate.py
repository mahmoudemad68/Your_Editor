"""Offline generated baseline; never describes model output as hand-labelled gold."""

import argparse
import hashlib
import importlib.metadata
import json
import subprocess
import wave
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

SOURCE_IDS = ("commons-28956463", "commons-98650286", "commons-82236797")
MODEL_ID = "Systran/faster-whisper-small"
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
MODEL_SHA256 = "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"
RECIPE = "eval-generated-annotations-v1"
RATE = 16000


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def microseconds(value):
    return int(
        (Decimal(str(value)) * 1000000).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    )


def words_in_source(raw, scope):
    lower, upper = int(scope["startUs"]), int(scope["endUs"])
    words, omitted = [], []
    previous = lower
    for word in raw:
        start = max(lower, lower + microseconds(word["start"]))
        end = min(upper, lower + microseconds(word["end"]))
        if start >= end or not word["text"].strip():
            omitted.append(
                {**word, "reason": "empty_text_or_no_positive_duration_inside_scope"}
            )
            continue
        if start < previous:
            raise ValueError(
                "Model word alignment overlaps; no synthetic boundary repair allowed"
            )
        words.append(
            {"text": word["text"].strip(), "startUs": str(start), "endUs": str(end)}
        )
        previous = end
    if not words:
        raise ValueError("No usable model words")
    return words, omitted


def silence_in_source(speech, scope, samples):
    lower, upper = int(scope["startUs"]), int(scope["endUs"])
    if samples * 1000000 != (upper - lower) * RATE:
        raise ValueError("Audio duration differs from declared scope")
    silence, cursor = [], 0
    for interval in speech:
        start, end = int(interval["start"]), int(interval["end"])
        if start < cursor or start >= end or end > samples:
            raise ValueError("Invalid model speech intervals")
        if cursor < start:
            silence.append(
                {
                    "startUs": str(lower + cursor * 1000000 // RATE),
                    "endUs": str(lower + start * 1000000 // RATE),
                }
            )
        cursor = end
    if cursor < samples:
        silence.append(
            {"startUs": str(lower + cursor * 1000000 // RATE), "endUs": str(upper)}
        )
    return silence


def write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # Optional dependencies are isolated from production workers and offline CI.
    import numpy as np
    from faster_whisper import WhisperModel
    from faster_whisper.utils import get_assets_path
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    if importlib.metadata.version("faster-whisper") != "1.2.1":
        raise ValueError("Install the pinned evaluation generation environment")
    if digest(args.model / "model.bin") != MODEL_SHA256:
        raise ValueError("Model weight identity differs from pinned recipe")
    repo = Path(__file__).resolve().parents[2]
    manifest = json.loads((repo / "docs/evaluation/manifest.json").read_text())
    if manifest["release"]["status"] != "unreleased":
        raise ValueError("Published dataset is immutable")
    args.output.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        str(args.model.resolve()),
        device="cpu",
        compute_type="int8",
        cpu_threads=2,
        num_workers=1,
        local_files_only=True,
    )
    versions = {
        p: importlib.metadata.version(p)
        for p in (
            "faster-whisper",
            "ctranslate2",
            "onnxruntime",
            "numpy",
            "av",
            "tokenizers",
        )
    }
    vad_options = {
        "threshold": 0.5,
        "neg_threshold": 0.35,
        "min_speech_duration_ms": 250,
        "min_silence_duration_ms": 100,
        "speech_pad_ms": 30,
    }
    vad_hash = digest(Path(get_assets_path()) / "silero_vad_v6.onnx")
    for source_id in SOURCE_IDS:
        source = next(s for s in manifest["sources"] if s["id"] == source_id)
        artifacts = {a["type"]: a for a in source["referenceArtifacts"]}
        word_doc = json.loads(
            (repo / artifacts["word_alignment"]["metadataPath"]).read_text()
        )
        silence_doc = json.loads(
            (repo / artifacts["silence_labels"]["metadataPath"]).read_text()
        )
        scope = word_doc["scope"]
        if scope != silence_doc["scope"]:
            raise ValueError("Word and silence scope must agree for paired generation")
        start, end = int(scope["startUs"]), int(scope["endUs"])
        if not 0 <= start < end <= int(source["durationUs"]):
            raise ValueError("Scope outside source")
        path = args.root / f"{source_id}.{source['extension']}"
        if (
            path.is_symlink()
            or digest(path) != source["sha256"]
            or path.stat().st_size != int(source["sizeBytes"])
        ):
            raise ValueError("Source identity differs")
        audio_path = args.output / f"{source_id}.wav"
        # Local-only decoder inputs; argument array, never remote URLs or shell interpolation.
        result = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                "matroska,webm,ogg,mov,mp4",
                "-i",
                str(path.resolve()),
                "-af",
                (
                    f"atrim=start={start // 1000000}.{start % 1000000:06d}:"
                    f"end={end // 1000000}.{end % 1000000:06d},asetpts=PTS-STARTPTS"
                ),
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(RATE),
                "-c:a",
                "pcm_s16le",
                "-map_metadata",
                "-1",
                "-y",
                str(audio_path.resolve()),
            ],
            capture_output=True,
            timeout=180,
            shell=False,
            check=False,
        )
        if result.returncode:
            raise ValueError("Local audio extraction failed; decoder output withheld")
        with wave.open(str(audio_path), "rb") as audio_file:
            if (
                audio_file.getframerate(),
                audio_file.getnchannels(),
                audio_file.getsampwidth(),
            ) != (RATE, 1, 2):
                raise ValueError("Unexpected scoped PCM format")
            audio = (
                np.frombuffer(
                    audio_file.readframes(audio_file.getnframes()), dtype="<i2"
                ).astype(np.float32)
                / 32768.0
            )
        speech = get_speech_timestamps(
            audio, VadOptions(**vad_options), sampling_rate=RATE
        )
        silence = silence_in_source(speech, scope, len(audio))
        segments, _ = model.transcribe(
            audio,
            language=source["language"],
            task="transcribe",
            word_timestamps=True,
            without_timestamps=False,
            vad_filter=False,
            beam_size=5,
            temperature=0.0,
            condition_on_previous_text=True,
        )
        raw_words = [
            {"text": w.word, "start": w.start, "end": w.end}
            for segment in segments
            for w in segment.words or []
        ]
        words, omitted = words_in_source(raw_words, scope)
        raw = {"words": raw_words, "speechSamples": speech, "omittedWords": omitted}
        raw_path = args.output / f"{source_id}-raw.json"
        write_json(raw_path, raw)
        common = {
            "recipeVersion": RECIPE,
            "generatorSha256": digest(Path(__file__)),
            "inputAudioSha256": digest(audio_path),
            "rawOutputSha256": digest(raw_path),
            "sampleRateHz": RATE,
            "toolVersions": versions,
            "ffmpegVersion": subprocess.run(
                ["ffmpeg", "-version"], check=True, capture_output=True, text=True
            ).stdout.splitlines()[0],
            "timestampPolicy": "source_us_round_half_up_bounded_v1",
        }
        result = {
            "sourceId": source_id,
            "sourceSha256": source["sha256"],
            "language": source["language"],
            "scope": scope,
            "words": words,
            "intervals": silence,
            "wordGeneration": {
                **common,
                "method": "faster_whisper_word_timestamps",
                "modelId": MODEL_ID,
                "modelRevision": MODEL_REVISION,
                "modelSha256": MODEL_SHA256,
                "parameters": {
                    "device": "cpu",
                    "computeType": "int8",
                    "cpuThreads": 2,
                    "beamSize": 5,
                    "temperature": 0,
                    "vadFilter": False,
                },
            },
            "silenceGeneration": {
                **common,
                "method": "silero_vad_silence_complement",
                "modelId": "silero_vad_v6.onnx",
                "modelRevision": vad_hash,
                "modelSha256": vad_hash,
                "parameters": vad_options,
            },
        }
        write_json(args.output / f"{source_id}-generated.json", result)
        print(
            "GENERATED",
            source_id,
            "words",
            len(words),
            "silence",
            len(silence),
            "omitted_degenerate_words",
            len(omitted),
            flush=True,
        )


if __name__ == "__main__":
    main()
