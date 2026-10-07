# Canonical tiny media fixtures

Six synthetic CC0 inputs, each below 5 MB; no third-party footage or identifiable
people. `manifest.json` records purpose, SHA-256, byte count and exact FFprobe
metadata. Talking head is an animated geometric avatar with synthesized speech;
two speakers uses the distinct flite `kal` and `slt` voices. Silence gaps uses
known one-second tone/silence intervals. VFR has nonuniform frame timestamps.
Rotated phone has a 90-degree display matrix. Corrupt is intentionally truncated.

```sh
git lfs install --local --skip-repo
git lfs pull
pnpm test:fixtures
# Only when intentionally regenerating fixtures (FFmpeg + libflite required):
node tests/fixtures/media/generate.mjs
git add tests/fixtures/media
```

The committed binaries are the test inputs; CI never regenerates them. FFmpeg
versions can change encoded bytes; review manifest/hash changes on regeneration.
Only `*.mp4` in this directory uses LFS; the README, JSON and source remain Git
text. The repository pre-push hook uploads objects. The integrity test rejects
LFS pointer text and probes the actual five valid files.
