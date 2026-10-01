# Media worker

`src/index.ts` stays idle so Compose can health-check `/tmp/editagent.ready`. It does not inspect uploads.

Automatic post-upload inspection is not active. It waits for US-129. A manual command is not background processing.

## Inspect one stored MediaAsset

```bash
node dist/inspect.js <mediaAssetId>
```

The id is the MediaAsset UUIDv7. The command loads that row, streams the canonical object from object storage into a temporary file named `source.bin`, runs FFprobe, and writes technical metadata. The display filename is never used as a filesystem path.

Required environment: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_REGION`.

Optional environment:

- `FFPROBE_PATH` defaults to `ffprobe` on `PATH`.
- `FFPROBE_TIMEOUT_MS` defaults to 30000 and must be a positive integer.
- `PROBE_TMPDIR` defaults to the operating system temporary directory and must be absolute.

`CompleteMediaUpload` does not call this command. `GET /projects/:projectId/media/:mediaAssetId` reads the stored row and does not run FFprobe.

## How US-129 will call this

The BullMQ job handler should call `inspectMediaAsset` from `src/application/inspect-media.ts` with the MediaAsset id in the job payload. Wire it to `PostgresMediaInspectionRepository`, `FileObjectStager` over `S3ObjectByteSource`, and `FFprobeMediaProbe`, the same adapters `src/inspect.ts` constructs. Do not add a second probe implementation, a fake queue, or an FFprobe call in the API process.
