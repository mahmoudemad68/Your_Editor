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

Credential rate limiting is API-authoritative and process-local. Its rolling 30/minute key is `<operation>:<trusted-network-key>:sha256:<SHA-256(normalizeEmail(email))>`; login and registration are separate operations. Normalization uses the same trim/lowercase/domain validation as account lookup. Known and unknown valid identities use identical keys and budgets; no raw email is retained in limiter keys. Malformed emails share `<operation>:<trusted-network-key>:malformed-email`. The BFF does not forward caller-supplied client-address headers. Distinct identities behind its one peer address therefore remain isolated, without trusting spoofable addresses.

The limiter periodically sweeps expired entries and evicts the least recently used bucket at its unchanged 10,000-key capacity, touching both accepted and denied attempts. New identities are admitted rather than globally denied at capacity. Eviction may forget an inactive process-local budget under key churn; persistent five-failure account lockout remains authoritative across peers/processes and is unaffected by eviction. The F1 Playwright regression exhausts an attacker's bucket through real BFF routes, then verifies a separate browser's valid login and unrelated registration while the attacker remains throttled. API tests cover normalization, endpoint scopes, malformed inputs, key churn, password burn/account lockout, and trusted/untrusted proxy handling.

The US-118 limitations remain: issued access JWTs retain their approximately 15-minute natural expiry, and this story adds no distributed limiting or access-token revocation lists. F2 remains non-blocking: browsers without Web Locks coalesce refresh within each tab, but competing tabs can invalidate the refresh family. F3 remains pre-existing and non-blocking: oversized credential bodies currently return a sanitized 500. Neither finding is redesigned by the F1 repair. Independent QA on the repaired HEAD, Project Owner sign-off, merge, and staging validation are subsequent steps. Supply-chain HIGH findings remain unresolved.

## US-123 resumable upload

Files of at least 16 MiB use S3 multipart, with 16 MiB parts and at most three
concurrent PUTs. Smaller files keep the direct conditional PUT flow. No video
bytes are proxied through Next/Nest. All multipart control routes use the existing
verified cookie session, creator/project authorization and browser-supplied CSRF
header; storage PUTs use only the presigned request.

IndexedDB stores upload-session metadata scoped to the authenticated user and
project. It stores neither file bytes nor tokens, provider upload ids or presigned
URLs. After reload/reopening, reselect the same local file. The complete SHA-256,
size and MIME must match before resume; a matching filename is insufficient.
The API reconciles provider parts into durable individual UploadPart rows, so
non-contiguous completed parts are retained and only missing part numbers are
scheduled. Uploaded bytes start from server-confirmed completed bytes.

Each part gets at most four attempts for network errors, HTTP 408 and selected
5xx responses, with exponential backoff/jitter. Expired URLs are renewed for the
same pending part. Before retry, server reconciliation catches successful PUTs
whose acknowledgment was lost. Permanent authorization/checksum/part errors are
not blindly retried. Pause cancels all active requests/retry waits and preserves
metadata. Discard aborts the provider upload and removes local state only after
server confirmation. Navigating away aborts active requests and leaves durable
resume state. Late callbacks are guarded by the existing generation/controller.

Progress combines durable parts and current in-flight bytes without retry double
counting. Speed uses a moving five-second window; startup/zero speed has no ETA.
The UI stays below 100% until provider completion, streamed whole-file SHA-256
verification and MediaAsset completion succeed. Completed objects share the
US-122 publication path; multipart ETags are never file checksums.

The Playwright suite now also uploads real 64 MiB bytes against SeaweedFS,
interrupts at parts [1,2], recreates the page, rejects changed content with the
same filename, restores 50% progress, silently refreshes expired access on a
control request, PUTs only [3,4], and verifies the final SHA-256. Another scenario
covers small-file upload, CSRF/forged session rejection and intentional discard.
A deterministic boundary test covers both 1.5 GB (decimal, ~50.33%) and 1.5 GiB
(exactly 50%) without allocating those files. This is not a real 1.5 GB transfer.

The 24-hour expiry cleanup command/scheduling prerequisite is documented in
`docs/operations/seaweedfs-object-storage.md`. File System Access handles are not
required; file reselection is the portable reload path. Independent QA and Owner
acceptance remain subsequent steps. Existing US-119 N1/N2/F2/F3 and supply-chain
HIGH findings remain debt; US-123 does not remediate them.
