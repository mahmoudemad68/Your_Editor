# Web

The dashboard lists, creates, and deletes Projects through a generated OpenAPI client.

Production sign-in is not implemented. US-118 will authenticate the API transport, and US-119 will add the sign-in screens. This app does not send a user id, a test actor header, or a stand-in token. The test actor wrapper lives in `tests/integration/test-actor-fetch.mjs` and is not part of the web application.

`GET /projects/:projectId` does not exist. Opening a project reads `GET /projects` and selects the matching id.

Same-origin `/api/projects` responses stay HTTP 200 with the typed JSON envelope. Every response, including a 401 envelope, sends `Cache-Control: private, no-store`. Upload begin, upload complete, and media details use the same envelope and cache header. The video bytes are PUT to the presigned URL. They are not proxied.

There is no media list endpoint. After a full page reload, earlier uploads are not shown. That avoids storing media ids in the browser.

Inspection stays pending until a worker records it. Automatic inspection is US-129. This page can refresh details; it does not run FFprobe.

Leaving the page aborts the browser hash and the direct PUT. Begin and Complete may already have been accepted by the API. Cancelling those browser requests does not delete the stored object and does not retry Complete, because a successful Complete may already have recorded the MediaAsset.

Local MinIO accepts the signed PUT preflight for `content-type`, `x-amz-checksum-sha256`, and `if-none-match`. A production S3 bucket needs an explicit CORS rule for those headers and PUT. CORS does not make objects public. Anonymous reads stay denied.

Regenerate the client after the API OpenAPI document changes:

```bash
pnpm --filter @editagent/api build
pnpm --filter @editagent/web generate:api
```

`pnpm --filter @editagent/web check:api-client` fails when the committed client is stale.
