"""QA: verify an exported render against its source and the saved edit (frame + audio level).

Edit semantics under test (UI: "Trim preserves clip placement and composition duration.
Empty ranges render as black."): export time t shows source time t inside kept ranges,
and black/silence elsewhere.
"""
import argparse, hashlib, json, subprocess, sys
import numpy as np

FPS, SR = 25, 16000


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-count_frames", "-of", "json", path],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def frames(path, w, h):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=bilinear,fps={FPS}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)


def audio(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                         capture_output=True).stdout
    return np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True); ap.add_argument("--export", required=True)
    ap.add_argument("--keep", action="append", required=True, help="start:end seconds (timeline = source time)")
    ap.add_argument("--duration", type=float, required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    keep = [tuple(map(float, k.split(":"))) for k in a.keep]
    inside = lambda t, m: any(s + m <= t < e - m for s, e in keep)
    outside = lambda t, m: all(t < s - m or t >= e + m for s, e in keep)
    rep = {"sourceSha256": hashlib.sha256(open(a.source, "rb").read()).hexdigest(),
           "exportSha256": hashlib.sha256(open(a.export, "rb").read()).hexdigest(), "keep": keep}
    p = probe(a.export)
    v = next(s for s in p["streams"] if s["codec_type"] == "video")
    au = [s for s in p["streams"] if s["codec_type"] == "audio"]
    rep["exportProbe"] = {"duration": float(p["format"]["duration"]), "videoCodec": v["codec_name"], "width": v["width"],
                          "height": v["height"], "fps": v["r_frame_rate"], "frames": int(v.get("nb_read_frames", 0)),
                          "pixFmt": v.get("pix_fmt"), "audio": [{"codec": s["codec_name"], "rate": s.get("sample_rate"),
                                                                 "channels": s.get("channels")} for s in au]}
    sp = probe(a.source); sv = next(s for s in sp["streams"] if s["codec_type"] == "video")
    w, h = int(sv["width"]), int(sv["height"])
    src, exp = frames(a.source, w, h), frames(a.export, w, h)
    n = int(round(a.duration * FPS))
    checks = {}
    checks["durationOk"] = abs(rep["exportProbe"]["duration"] - a.duration) <= 0.05
    checks["frameCountOk"] = len(exp) == n and rep["exportProbe"]["frames"] == n
    checks["hasAudio"] = bool(au)
    kept_err, offsets, black_bad, kept_bad = [], [], 0, 0
    for i in range(min(len(exp), n)):
        t = (i + 0.5) / FPS
        if inside(t, 1.0 / FPS):
            mae = float(np.abs(exp[i] - src[i]).mean()); kept_err.append(mae)
            cand = range(max(0, i - 3), min(len(src), i + 4))
            best = min(cand, key=lambda j: float(np.abs(exp[i] - src[j]).mean()))
            offsets.append(best - i)
            kept_bad += mae > 12.0
        elif outside(t, 1.0 / FPS):
            black_bad += float(exp[i].mean()) > 16.0
    checks["keptFramesMatchSameSourceTime"] = kept_bad == 0 and bool(kept_err)
    checks["zeroFrameOffset"] = bool(offsets) and all(o == 0 for o in offsets)
    checks["removedRangesBlack"] = black_bad == 0
    rep["video"] = {"keptFrames": len(kept_err), "keptMaeMax": max(kept_err) if kept_err else None,
                    "keptMaeMean": float(np.mean(kept_err)) if kept_err else None,
                    "offsetHistogram": {str(k): offsets.count(k) for k in sorted(set(offsets))}, "nonBlackRemovedFrames": black_bad}
    sa, ea = audio(a.source), audio(a.export)
    win, corr_bad, sil_bad, corrs = int(0.25 * SR), 0, 0, []
    for k in range(int(a.duration / 0.25)):
        t0, seg = k * 0.25, slice(k * win, (k + 1) * win)
        e, s = ea[seg], sa[seg]
        if len(e) < win or len(s) < win:
            continue
        if inside(t0 + 0.125, 0.175):  # whole window inside a kept range with 50 ms margin
            if np.sqrt((s ** 2).mean()) < 0.003:
                continue  # near-silent source window: correlation is not meaningful
            best = max(float(np.dot(np.roll(e, lag), s) / (np.linalg.norm(e) * np.linalg.norm(s) + 1e-9)) for lag in range(-480, 481, 16))
            corrs.append(best); corr_bad += best < 0.8
        elif outside(t0 + 0.125, 0.2):
            sil_bad += float(np.sqrt((e ** 2).mean())) > 0.003
    checks["keptAudioMatchesSource"] = bool(corrs) and corr_bad == 0
    checks["removedRangesSilent"] = sil_bad == 0
    rep["audio"] = {"correlatedWindows": len(corrs), "minCorrelation": min(corrs) if corrs else None, "nonSilentRemovedWindows": sil_bad}
    rep["checks"] = checks
    rep["pass"] = all(checks.values())
    json.dump(rep, open(a.out, "w"), indent=2)
    print(json.dumps(rep, indent=2))
    sys.exit(0 if rep["pass"] else 1)


if __name__ == "__main__":
    main()
