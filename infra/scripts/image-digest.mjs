/**
 * Staging image references must be digest-pinned.
 * A mutable tag such as :latest or :local is rejected.
 */

const DIGEST = /@sha256:[a-f0-9]{64}$/;

export function assertDigestPinned(name, value) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${name} must be pinned with @sha256 and 64 hex digits.`);
  }
  if (value.includes(":latest") || value.includes(":local")) {
    throw new Error(`${name} must not use a latest or local tag.`);
  }
}

export const STAGING_IMAGE_ENV = [
  "EDITAGENT_API_IMAGE",
  "EDITAGENT_WEB_IMAGE",
  "EDITAGENT_MEDIA_WORKER_IMAGE",
  "EDITAGENT_RENDER_WORKER_IMAGE",
  "EDITAGENT_AGENT_WORKER_IMAGE",
  "EDITAGENT_AI_WORKER_IMAGE",
  "EDITAGENT_MINIO_IMAGE",
  "EDITAGENT_POSTGRES_IMAGE",
  "EDITAGENT_REDIS_IMAGE",
];
