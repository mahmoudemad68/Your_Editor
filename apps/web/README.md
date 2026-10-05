# Web

The dashboard lists, creates, and deletes Projects through a generated OpenAPI client.

US-119 adds public `/sign-in` and `/sign-up` screens and a session check before the dashboard/project pages render. The shell shows the verified user's email and a CSRF-protected sign-out action. Registration uses the US-118 email contract (max 254 characters) and passwords of 12–200 characters. Generic invalid-credential, conflict, and rate-limit messages do not display raw server details.

Authentication uses same-origin `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, and `/auth/me` routes. Keeping `/auth` preserves the HttpOnly refresh cookie's `Path=/auth`. The proxy forwards incoming cookies and the original Origin/Fetch Metadata, rejects cross-site or mismatched browser authorities, and forwards every Set-Cookie line without rewriting its attributes. The API's trusted-Origin guard remains authoritative. Configure `AUTH_TRUSTED_ORIGINS` on the API with the actual browser origin (the local Compose default is `http://localhost:3000`). Forwarded host/protocol headers never establish trust. Authentication/session responses use `Cache-Control: private, no-store`.

Identity after reload comes from `GET /auth/me`, authenticated by the API's existing verified access-token mechanism and returning only `{ id, email }`. No access/refresh token is decoded by browser JavaScript, stored in web storage/React state, or included in URLs/logs. The browser reads only `editagent_csrf` and explicitly supplies `x-editagent-csrf` for mutations, refresh and logout. The BFF never synthesizes that header from ambient cookies. Read-only operations do not require it.

The session client coalesces concurrent 401s, silently refreshes and retries the original request at most once, including project API 401 envelopes. Web Locks serialize refresh work across tabs; a session check inside the lock avoids rotating credentials another tab already refreshed. Browsers without Web Locks still coalesce refresh within each tab. Invalid/expired/revoked refresh sessions hide protected content and redirect to sign-in. Network failures during bootstrap show a retry state. Internal return targets are restricted to the dashboard and valid project paths, preserving their query/fragment; invalid or external targets fall back to `/`.

Backend project authorization remains authoritative. This app does not send a user id, a test actor header, or a stand-in token. The test actor wrapper lives in `tests/integration/test-actor-fetch.mjs` and is not part of the web application.

`GET /projects/:projectId` does not exist. Opening a project reads `GET /projects` and selects the matching id.

Same-origin `/api/projects` responses stay HTTP 200 with the typed JSON envelope. Every response, including a 401 envelope, sends `Cache-Control: private, no-store`. Upload begin, upload complete, and media details use the same envelope and cache header. The video bytes are PUT to the presigned URL. They are not proxied.

There is no media list endpoint. After a full page reload, earlier uploads are not shown. That avoids storing media ids in the browser.

Inspection stays pending until a worker records it. Automatic inspection is US-129. This page can refresh details; it does not run FFprobe.

Leaving the page aborts the browser hash and the direct PUT. Begin and Complete may already have been accepted by the API. Cancelling those browser requests does not delete the stored object and does not retry Complete, because a successful Complete may already have recorded the MediaAsset.

SeaweedFS accepts the signed PUT preflight for `content-type`, `x-amz-checksum-sha256`, and `if-none-match`. A production S3 bucket needs an explicit CORS rule for those headers and PUT. CORS does not make objects public. Anonymous reads stay denied.

Regenerate the client after the API OpenAPI document changes:

```bash
pnpm --filter @editagent/api build
pnpm --filter @editagent/web generate:api
```

`pnpm --filter @editagent/web check:api-client` fails when the committed client is stale.

## US-119 verification

`pnpm test` and `pnpm check` include the Playwright suite after building both services. Run it separately with `pnpm --filter @editagent/web test:e2e`. Chrome must be installed at `/opt/google/chrome/chrome`, or set `PLAYWRIGHT_CHROME_EXECUTABLE` to a local Chrome binary. Tests start production Next.js and the real Nest authentication implementation with in-memory repositories and a controllable clock; no browser authentication endpoints are mocked. The separate loopback fixture controls live in `tests/e2e/us119-api.mjs` and are not part of the production API or BFF. Existing API/Postgres integration and Chrome CSRF regression suites remain in the aggregate validation.

The suite covers registration plus project creation in under 60 seconds, login/logout/reload identity, protected routes, expired/revoked sessions and internal return targets, concurrent tab refresh, validation/conflict/rate limits, explicit CSRF and hostile form/fetch attempts against the actual web routes, and absence of tokens in local/session storage. Playwright traces are disabled to avoid persisting cookie headers, and browser artifacts are ignored by Git.

The US-118 limitations remain: credential rate limiting is process-local, and issued access JWTs retain their approximately 15-minute natural expiry. US-119 does not implement distributed limiting or access-token revocation lists. Independent QA, Project Owner sign-off, merge, and staging validation are subsequent steps.
