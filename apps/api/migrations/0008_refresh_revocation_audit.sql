-- A revocation cannot predate the session it ends. A losing refresh used to
-- store an earlier clock on a replacement created after it waited for the lock.

UPDATE refresh_sessions
SET revoked_at = created_at
WHERE revoked_at IS NOT NULL AND revoked_at < created_at;

ALTER TABLE refresh_sessions
  ADD CONSTRAINT refresh_sessions_revocation
  CHECK (revoked_at IS NULL OR created_at <= revoked_at);
