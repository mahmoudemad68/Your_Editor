#!/usr/bin/env python3
"""Independently ffprobe the fresh graduation download. Does not trust the product report alone."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from results import emit  # noqa: E402


def main() -> int:
    results = Path(sys.argv[1])
    out = Path(sys.argv[2])
    root = Path(__file__).resolve().parents[2]
    mp4 = root / ".local/graduation-demo-public/demo-export.mp4"
    report = root / ".local/graduation-demo-public/report.json"
    if not mp4.is_file():
        emit(results, "g3.browser_export", "G3", "FAIL", True, "downloaded MP4 is absent")
        emit(results, "g3.ffprobe_export", "G3", "FAIL", True, "no file to probe")
    else:
        digest = hashlib.sha256(mp4.read_bytes()).hexdigest()
        emit(results, "g3.browser_export", "G3", "PASS", True, f"fresh download sha256={digest} bytes={mp4.stat().st_size}")
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(mp4)],
            capture_output=True,
            text=True,
            check=False,
        )
        (out / "export-ffprobe.json").write_text(probe.stdout, encoding="utf-8")
        try:
            document = json.loads(probe.stdout)
            video = next(stream for stream in document["streams"] if stream["codec_type"] == "video")
            audio = next(stream for stream in document["streams"] if stream["codec_type"] == "audio")
            ok = (
                probe.returncode == 0
                and video["codec_name"] == "h264"
                and video["width"] == 320
                and video["height"] == 180
                and video.get("avg_frame_rate") == "25/1"
                and int(video.get("nb_read_frames", "0")) == 200
                and audio["codec_name"] == "aac"
                and abs(float(document["format"]["duration"]) - 8) <= 0.02
            )
            detail = (
                f"codec={video.get('codec_name')} {video.get('width')}x{video.get('height')} "
                f"fps={video.get('avg_frame_rate')} frames={video.get('nb_read_frames')} "
                f"duration={document['format'].get('duration')} audio={audio.get('codec_name')} sha256={digest}"
            )
        except Exception as exc:  # noqa: BLE001
            ok = False
            detail = str(exc)
        emit(results, "g3.ffprobe_export", "G3", "PASS" if ok else "FAIL", True, detail)
    if report.is_file():
        (out / "graduation-report.json").write_text(report.read_text(encoding="utf-8"), encoding="utf-8")
    emit(
        results,
        "g3.browser_storage_backend",
        "G3",
        "OBSERVED",
        False,
        "The product graduation harness starts real PostgreSQL, Redis, and its test MinIO container. "
        "SeaweedFS is qualified on the compose stack, not by this browser S3 client. QA did not retarget product code.",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
