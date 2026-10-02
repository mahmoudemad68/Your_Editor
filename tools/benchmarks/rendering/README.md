# Rendering feasibility benchmark

US-106 compares FFmpeg and Remotion on one fixed 60-second vertical composition. The production render worker is not changed. Generated MP4 files stay out of Git.

This directory is not part of the pnpm workspace. Install it on its own:

```bash
cd tools/benchmarks/rendering
pnpm install --ignore-workspace
pnpm rebuild esbuild --ignore-workspace
```

Create the generated source and run the suite. The suite does one cold run, one warm-up, and three measured runs for each strategy. It does not run in CI.

```bash
env -u LD_LIBRARY_PATH node scripts/generate-fixture.mjs
env -u LD_LIBRARY_PATH node scripts/run-suite.mjs
```

`results/summary.json` is the machine-readable record. `docs/research/technology-evaluation.md` quotes those measurements.

The container proof is separate from the host suite:

```bash
docker build -f docker/Dockerfile -t editagent-render-spike .
docker run --rm --shm-size=1g editagent-render-spike
```

That image runs as uid 10001. Remotion 4.0.532 still launches Chrome Headless Shell with `--no-sandbox`. The Dockerfile does not add that flag.
