# Web

The dashboard lists, creates, and deletes Projects through a generated OpenAPI client.

Production sign-in is not implemented. US-118 will authenticate the API transport, and US-119 will add the sign-in screens. This app does not send a user id, a test actor header, or a stand-in token. The test actor wrapper lives in `tests/integration/test-actor-fetch.mjs` and is not part of the web application.

`GET /projects/:projectId` does not exist. Opening a project reads `GET /projects` and selects the matching id.

Regenerate the client after the API OpenAPI document changes:

```bash
pnpm --filter @editagent/api build
pnpm --filter @editagent/web generate:api
```

`pnpm --filter @editagent/web check:api-client` fails when the committed client is stale.
