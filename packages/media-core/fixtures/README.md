# Media probe fixtures

These files were generated with FFmpeg and probed with FFprobe `6.1.1-3ubuntu5`.
Durations are integer microseconds. Frame rates stay rational. A null field means the probe did not report that value.

US-122 accepts only video MIME types. `audio.wav` and `image.png` are parser fixtures. They are not uploaded through the direct-upload API.

| File          | Container              | Video | Audio                          | Stored size | Display size | Rotation           | Frame rate | Mode     | Duration |
| ------------- | ---------------------- | ----- | ------------------------------ | ----------- | ------------ | ------------------ | ---------- | -------- | -------- |
| `normal.mp4`  | MP4                    | h264  | aac, 1 channel, 48000 Hz       | 320x240     | 320x240      | none               | 25/1       | constant | 1000000  |
| `rotated.mov` | MOV (`major_brand` qt) | h264  | aac, 1 channel, 48000 Hz       | 320x240     | 240x320      | 90, display matrix | 25/1       | constant | 1000000  |
| `vfr.mp4`     | MP4                    | h264  | none                           | 160x120     | 160x120      | none               | 125/9      | variable | 360000   |
| `multi.mp4`   | MP4                    | h264  | aac 48000 Hz and aac 44100 Hz  | 160x120     | 160x120      | none               | 25/1       | constant | 1000000  |
| `audio.wav`   | WAV                    | none  | pcm_s16le, 1 channel, 44100 Hz | none        | none         | none               | none       | unknown  | 1000000  |
| `image.png`   | PNG                    | png   | none                           | 64x48       | 64x48        | none               | 25/1       | unknown  | none     |
| `corrupt.mp4` | truncated              | none  | none                           | none        | none         | none               | none       | failure  | none     |

`vfr.mp4` video timestamps, in microseconds, are 0, 40000, 160000, 200000, and 400000. The deltas are 40000, 120000, 40000, and 200000. `pkt_duration` stays 40, so packet duration alone would miss the variable rate. `r_frame_rate` is 25/1 and is not the stored rate. FFprobe 6.1.1 reports format duration `0.360000` (360000 microseconds). Debian bookworm FFprobe 5.1.9 reports `0.440000` for the same file. The timestamp deltas, and therefore the variable classification, stay the same.

`rotated.mov` uses a display matrix. Stream tag rotation is covered by a recorded JSON mutation with `tags.rotate` and no side data. A 90 or 270 degree rotation swaps display width and height. Stored width and height stay unchanged.

Color space is stored only when FFprobe reports one. The PNG fixture reports `gbr`. The video fixtures do not report a color space, so the value is null.

Regenerate the binaries with FFmpeg, then refresh `ffprobe/*.json` with the same argument list as `buildFfprobeArgs`:

```bash
ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=25:duration=1 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 1 -shortest fixtures/media/normal.mp4
ffmpeg -y -display_rotation 90 -i fixtures/media/normal.mp4 -c copy -brand qt -f mov fixtures/media/rotated.mov
ffmpeg -y -f lavfi -i testsrc=size=160x120:rate=25:duration=1 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -f lavfi -i sine=frequency=880:sample_rate=44100:duration=1 -map 0:v -map 1:a -map 2:a -c:v libx264 -c:a aac -shortest fixtures/media/multi.mp4
ffmpeg -y -f lavfi -i sine=frequency=440:sample_rate=44100:duration=1 -c:a pcm_s16le fixtures/media/audio.wav
ffmpeg -y -f lavfi -i color=c=red:s=64x48:d=1 -frames:v 1 fixtures/media/image.png
```

The variable-frame-rate file is a concat of 160x120 frames held for 0.040, 0.120, 0.040, and 0.200 seconds, encoded with `fps_mode passthrough` and `video_track_timescale 1000`. `corrupt.mp4` is the first 64 bytes of `normal.mp4`.
