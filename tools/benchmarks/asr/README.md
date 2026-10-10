# US-105 ASR and VAD feasibility spike

This directory is a Kaggle benchmark for Faster-Whisper and Silero VAD. It does not change the production AI worker, and it does not choose a production model. Measurements stay empty until the owner runs the notebook and brings the export back.

GitHub Actions runs the unit tests in `tests/`. It does not download weights or run the GPU matrix.

## What the owner runs

1. Create a Kaggle notebook with the GPU accelerator on and Internet on. Internet is required to clone this repository and to let Faster-Whisper and Silero download weights. The notebook does not need a Kaggle API token or a GitHub write token.
2. Set `BENCHMARK_SHA` in the first code cell to the full commit that should be measured.
3. Attach a Kaggle dataset that contains `manifest.json` plus the audio and reference files. Read it from `/kaggle/input/<dataset-name>`.
4. Run all cells. The notebook writes `/kaggle/working/asr-benchmark.zip`.
5. Download that zip. A later update on this same pull request records the numbers. Until then the technology note stays **PENDING**.

Optional CPU int8 runs are off unless `INCLUDE_CPU` is true. CPU float16 is recorded as `UNSUPPORTED` and is not launched. `large-v3` on CPU is in the plan and is skipped with a reason if the execution budget is exhausted. Failed and skipped rows stay in the JSON files.

## Dataset layout

Do not commit audio, private recordings, model weights, or a third-party corpus. `dataset_manifest.example.json` has no clips and is not ground truth.

```text
manifest.json
audio/en-001.wav
transcripts/en-001.txt
alignment/en-001.json    # optional, required for timestamp metrics
vad/en-001.json          # optional, required for VAD metrics
```

`manifest.json`:

```json
{
  "clips": [
    {
      "id": "en-001",
      "audio_path": "audio/en-001.wav",
      "language": "en",
      "duration_seconds": 60.0,
      "source": "who created or published the recording",
      "license": "the license or written permission",
      "transcript_path": "transcripts/en-001.txt",
      "word_timestamps_path": "alignment/en-001.json",
      "speech_intervals_path": "vad/en-001.json"
    }
  ]
}
```

`language` is `en` / `english` or `ar` / `arabic`. Paths are relative to the dataset root and cannot contain `..`. `source` and `license` must be non-empty. The transcript is plain text. Word timestamps are `{"words": [{"word", "start", "end"}]}`. Speech intervals are `{"intervals": [{"start", "end"}]}` in seconds.

The runner refuses a benchmark whose clips sum to less than 600 seconds. Prefer 600 seconds of English and 600 seconds of Arabic. Timestamp metrics need at least three clips with `word_timestamps_path`. VAD metrics need `speech_intervals_path`. If those files are absent, quality status is `INSUFFICIENT_REFERENCE` and `reported_pass` is false.

## Commands

From this directory, after the dataset exists locally:

```bash
python3 tests/test_asr_benchmark.py
python3 benchmark.py \
  --manifest /path/to/manifest.json \
  --dataset-root /path/to/dataset \
  --output /tmp/asr-out \
  --commit-sha "$(git rev-parse HEAD)" \
  --budget-seconds 3600 \
  --clip-timeout-seconds 600
python3 evaluate.py \
  --manifest /path/to/manifest.json \
  --dataset-root /path/to/dataset \
  --hypotheses /tmp/asr-out/hypotheses \
  --vad /tmp/asr-out/vad \
  --output /tmp/asr-out/quality.json
```

Add `--include-cpu` to run the CPU int8 matrix. `--warmup` defaults to 1 and `--repeats` defaults to 1. Warm-up rows are saved with `"measured": false`. Each finished configuration is its own file under `runs/`, so a stopped Kaggle session keeps the runs that completed.

## Metrics

Real-time factor is inference seconds divided by audio seconds. Throughput is audio seconds divided by inference seconds. Peak RAM is `VmHWM` from `/proc/self/status` when that file exists. Peak GPU memory is the used-memory reading from `nvidia-smi` when that command succeeds. Missing hardware fields stay null.

WER uses the normalization in `metrics.normalize_words`. English is Unicode casefold with punctuation other than apostrophes removed. Arabic removes tatweel and harakat, folds `أ إ آ` to `ا`, `ى` to `ي`, and `ة` to `ه`. Word-timestamp error uses the same tokens and keeps only monotonic matches. Unmatched words are not given a timestamp error.

VAD precision, recall, and F1 use 10 ms frames. A frame is speech when an interval covers its center. Interval boundary error uses greedy matches with intersection-over-union of at least 0.5.

ASR timing uses Faster-Whisper with `vad_filter` off and `word_timestamps` on, so the clock is the recognizer. Silero VAD is a separate pass.

CP1's ASR rate is 10 minutes of speech in at most 3 minutes, which is a real-time factor of 0.3, on the reference GPU, or a viable CPU model. `formal_cp1` in every export is `NOT_VERIFIED` until the owner confirms the reference hardware. The rendering CP1 gate from US-106 is unchanged.

## Licenses

Weights are downloaded at runtime into the Kaggle or Hugging Face cache. They are not stored in git.

- Faster-Whisper code: https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE (MIT)
- Whisper model card and license: https://github.com/openai/whisper/blob/main/LICENSE (MIT)
- Silero VAD: https://github.com/snakers4/silero-vad/blob/master/LICENSE (MIT)

Pinned benchmark packages are `faster-whisper==1.2.1` and `silero-vad==6.2.3`. This spike does not decide whether the team may use them commercially.

## Decision rule for a later results update

After the zip is attached, a default GPU model can be proposed only from a successful measured run whose real-time factor is at most 0.3 on at least 10 minutes of audio, with WER reported for the languages that were present. A CPU fallback can be proposed only from a successful CPU int8 run. This commit does not make either choice.
